/**
 * Native `node:sqlite` driver.
 *
 * Backs real multi-process hosts. Opens the database in WAL mode with a
 * `busy_timeout`, enforces foreign keys, and runs every writing transaction as a
 * short `BEGIN IMMEDIATE` with explicit rollback on any error and a bounded
 * application-level retry on `SQLITE_BUSY` beyond the busy timeout.
 *
 * `node:sqlite` is synchronous and single-connection, which is exactly what the
 * {@link SqlDriver} contract wants: the `work` callback runs synchronously inside
 * the open transaction, structurally preventing an awaited external effect from
 * being held across `BEGIN IMMEDIATE`.
 *
 * Each configuration choice below follows documented SQLite behaviour:
 *
 * - `BEGIN IMMEDIATE` for writes, never deferred. A deferred transaction that
 *   later writes must upgrade, and "if some other database connection has
 *   already modified the database … the write statement will fail with
 *   SQLITE_BUSY" (https://www.sqlite.org/lang_transaction.html). Taking the
 *   write lock up front converts a mid-transaction failure into an entry-point
 *   one the retry loop can handle.
 * - A bounded application-level retry ON TOP of `busy_timeout`, because the
 *   timeout alone is not sufficient: "If SQLite determines that invoking the
 *   busy handler could result in a deadlock, it will go ahead and return
 *   SQLITE_BUSY to the application instead of invoking the busy handler"
 *   (https://www.sqlite.org/c3ref/busy_handler.html).
 * - `PRAGMA foreign_keys = ON` in the constructor, before any transaction
 *   opens. Enforcement is per-connection and off by default, and "it is not
 *   possible to enable or disable foreign key constraints in the middle of a
 *   multi-statement transaction … it simply has no effect"
 *   (https://www.sqlite.org/foreignkeys.html) — a misplaced pragma fails silently.
 * - `PRAGMA synchronous` is deliberately left at SQLite's FULL default rather
 *   than the NORMAL commonly paired with WAL. NORMAL "omits this sync" on
 *   commit (https://www.sqlite.org/wal.html), trading durability across power
 *   loss for throughput; runbook state is small and written rarely, so the
 *   trade does not pay here.
 *
 * `capabilities.multiProcess` assumes a local filesystem. WAL's shared-memory
 * index means "all processes using a database must be on the same host
 * computer; WAL does not work over a network filesystem"
 * (https://www.sqlite.org/wal.html), so a project directory on NFS or SMB
 * voids the cross-process guarantee this adapter advertises. It is not the only
 * way to lose WAL — see {@link WalJournalModeUnavailableError} — which is why the
 * driver checks the EFFECTIVE journal mode rather than any single precondition.
 *
 * @module runbook/storage/native-sqlite-driver
 */

import { DatabaseSync } from 'node:sqlite';
import { isError, isNodeError } from '../../errors.js';
import { assertSyncWorkResult, readOnlyTransaction, toPortableParams } from './sql-driver.js';
import type {
  SqlDriver,
  SqlParams,
  SqlReadTransaction,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlTransaction,
  SyncWork,
} from './sql-driver.js';

/** SQLite primary result code for a contended write lock. */
const SQLITE_BUSY = 5;
/** SQLite primary result code for a table/shared-cache lock conflict. */
const SQLITE_LOCKED = 6;

/** Tuning knobs for the native driver's transaction retry behavior. */
export interface NativeDriverOptions {
  /**
   * `PRAGMA busy_timeout` in milliseconds.
   *
   * This is SQLite's OWN budget, spent inside a single statement. It multiplies
   * with {@link NativeDriverOptions.maxBusyRetries} rather than bounding it — see
   * the WAL-conversion retry in `enterWalJournalMode`.
   */
  readonly busyTimeoutMs?: number;
  /**
   * Retries allowed after the initial attempt before `SQLITE_BUSY` surfaces.
   * Applies to `BEGIN IMMEDIATE` and to the constructor's WAL conversion alike.
   */
  readonly maxBusyRetries?: number;
  /** Base backoff between busy retries in milliseconds (grows linearly). */
  readonly busyRetryBaseMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUSY_RETRIES = 10;
const DEFAULT_BUSY_RETRY_BASE_MS = 25;

/**
 * Return whether an error is a SQLite busy/locked contention error.
 *
 * `busy_timeout` handles most contention inside SQLite; this classifies the
 * residual `SQLITE_BUSY`/`SQLITE_LOCKED` that escapes it so the driver can retry
 * the whole transaction.
 *
 * @param err - Error thrown by a `node:sqlite` call.
 * @returns Whether the error is a retryable contention error.
 */
export function isSqliteBusy(err: unknown): boolean {
  if (!isNodeError(err)) {
    return false;
  }
  const errcode = (err as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') {
    return false;
  }
  const resultCode = errcode;
  if (resultCode >>> 0 !== resultCode || resultCode >>> 31 !== 0) {
    return false;
  }
  const primaryCode = resultCode & 0xff;
  return primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED;
}

/**
 * Block the calling thread for `ms`, for the one retry loop that cannot await.
 *
 * {@link NativeSqlDriver}'s constructor is synchronous, so the WAL conversion
 * has no turn of the event loop to yield. Every other busy retry in this module
 * uses {@link delay}.
 *
 * @param ms - Milliseconds to block.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Report whether the connection's `main` database is backed by a file.
 *
 * `PRAGMA database_list` names the file behind each attached database; `main`
 * carries an empty path for an in-memory (or transient) database. That is the
 * only distinction that matters here — an in-memory database is single
 * connection by construction, so the WAL guarantee is vacuous for it.
 *
 * @param db - Open `node:sqlite` connection.
 * @returns Whether `main` resolves to a filesystem path.
 */
function isFileBacked(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA database_list').all() as unknown as readonly {
    readonly name?: unknown;
    readonly file?: unknown;
  }[];
  return rows.some((row) => row.name === 'main' && typeof row.file === 'string' && row.file !== '');
}

/**
 * Raised when a file-backed connection did not enter WAL journal mode.
 *
 * Typed rather than a bare `Error` for the reason
 * {@link import('./schema.js').IncompatibleSchemaError} is: a front end classifies
 * on the CLASS to render a real error code, and an unclassifiable throw reaches
 * the operator as RD-999 / "Unknown error" on every command — including the
 * read-only ones, since opening the store precedes all of them.
 */
export class WalJournalModeUnavailableError extends Error {
  /**
   * Journal mode the connection actually reports, lowercased.
   *
   * `undefined` when `PRAGMA journal_mode` answered nothing a mode could be read
   * from. That is deliberately NOT collapsed into the `unknown` the message
   * renders: a consumer must be able to tell an absent answer from a mode SQLite
   * named.
   */
  readonly effectiveMode: string | undefined;

  /**
   * Construct the typed WAL refusal.
   *
   * @param effectiveMode - Observed journal mode, or `undefined` when the pragma
   *   returned no readable answer.
   */
  constructor(effectiveMode: string | undefined) {
    super(
      `Database did not enter WAL journal mode (effective mode: ${effectiveMode ?? 'unknown'}). ` +
        'Only WAL serializes writes across processes, so that guarantee is not in ' +
        'force on this connection. SQLite ANSWERED with the mode it kept instead of ' +
        'failing, which narrows the cause to one of: a filesystem whose VFS provides ' +
        'no shared memory (a network mount such as NFS or SMB is the common one), a ' +
        'temporary database opened with no filename, or a connection that was already ' +
        'inside a write transaction. A read-only file or directory is NOT among them — ' +
        'that fails the pragma outright and surfaces as a different error. Establish ' +
        'which applies before moving the project directory.',
    );
    this.name = 'WalJournalModeUnavailableError';
    this.effectiveMode = effectiveMode;
  }
}

/** Bounded busy-retry budget for the WAL conversion. */
interface WalConversionRetry {
  /**
   * Retries allowed AFTER the initial attempt before `SQLITE_BUSY` surfaces.
   * The conversion therefore issues at most `maxBusyRetries + 1` pragmas.
   */
  readonly maxBusyRetries: number;
  /** Base backoff in milliseconds, multiplied by the attempt number. */
  readonly busyRetryBaseMs: number;
}

/**
 * Put the connection into WAL mode and REFUSE any silent fallback.
 *
 * `PRAGMA journal_mode` is a query as much as a setting: it returns the mode
 * actually in force, and SQLite keeps that mode — answering rather than failing —
 * whenever WAL cannot be established. A filesystem whose VFS provides no shared
 * memory is the best-known reason ("WAL does not work over a network
 * filesystem", https://www.sqlite.org/wal.html) but not the only one: a
 * temporary database with no filename, and a connection already inside a write
 * transaction, reach the same place, which is why neither this guard nor its
 * message asserts a single cause. A read-only file or directory is NOT one of
 * them — that THROWS (`SQLITE_READONLY`, `SQLITE_READONLY_DIRECTORY`) rather than
 * returning a mode, so it never reaches this refusal. Issuing the pragma through
 * `exec` discards the answer, so the driver would go on advertising
 * `capabilities.multiProcess` over a connection that no longer serializes writes
 * across processes, leaving a `rundown.db-journal` sidecar as the only evidence.
 * This module refuses to downgrade silently; the same rule applies to the
 * journal mode.
 *
 * `memory` is accepted only for a connection with no file behind it: `:memory:`
 * cannot use WAL and always reports `memory`, and it is single connection by
 * construction. A FILE-backed database reporting `memory` is the rollback-journal
 * hazard wearing a different name, and is refused with everything else.
 *
 * The conversion itself contends: it rewrites the database header under a write
 * transaction, so two processes opening a fresh database race and the loser must
 * retry rather than die. See the comment on the catch below for which lock step
 * `PRAGMA busy_timeout` fails to cover, and why.
 *
 * @param db - Open `node:sqlite` connection to configure.
 * @param retry - Busy-retry budget for the conversion, shared with the driver's
 *   transaction retries.
 * @throws {WalJournalModeUnavailableError} When a file-backed connection did not
 *   enter WAL mode.
 * @throws {Error} When the conversion is still `SQLITE_BUSY` after the budget,
 *   or fails for any non-contention reason.
 */
function enterWalJournalMode(db: DatabaseSync, retry: WalConversionRetry): void {
  const { maxBusyRetries, busyRetryBaseMs } = retry;
  for (let attempt = 0; ; attempt++) {
    let applied: { readonly journal_mode?: unknown } | undefined;
    try {
      // Raw `node:sqlite` `.get()` takes no type argument (unlike this package's
      // own `SqlStatement` wrapper); the declared type of `applied` narrows it.
      applied = db.prepare('PRAGMA journal_mode = WAL').get();
    } catch (err) {
      // Converting to WAL rewrites the database header, so it opens a write
      // transaction (`sqlite3BtreeSetVersion` -> `sqlite3BtreeBeginTrans(…, 2, …)`)
      // and walks NO_LOCK -> SHARED -> RESERVED -> EXCLUSIVE. SQLite consults the
      // busy handler on only two of those four transitions, per the table
      // `sqlite3PagerSetBusyHandler` states outright in pager.c:
      //
      //   NO_LOCK       -> SHARED_LOCK      | Yes
      //   SHARED_LOCK   -> RESERVED_LOCK    | No
      //   SHARED_LOCK   -> EXCLUSIVE_LOCK   | No
      //   RESERVED_LOCK -> EXCLUSIVE_LOCK   | Yes
      //
      // The uncovered step is therefore the RESERVED ACQUISITION, not the
      // EXCLUSIVE upgrade: "The busy-handler callback can be used when upgrading
      // to the EXCLUSIVE lock, but not when obtaining the RESERVED lock"
      // (`sqlite3PagerBegin`, pager.c). That is a DIFFERENT rule from the
      // deadlock-avoidance one this module cites above for `BEGIN IMMEDIATE`, and
      // the two must not be conflated. Either way `PRAGMA busy_timeout`, set on
      // the line above, does not cover the conversion — measured on Node 24.18.1 /
      // SQLite 3.53.1 with `busy_timeout = 5000`: against a writer already holding
      // RESERVED the pragma fails in 0.24 ms with the handler never invoked;
      // against a READER holding SHARED it fails in 5208 ms, having burned the
      // whole timeout inside the handler. The first is what two `rundown run`
      // invocations racing to create the database on a fresh project hit, and
      // without this loop the loser dies with "database is locked".
      //
      // The retry is synchronous because the constructor is: `Atomics.wait` on a
      // throwaway buffer is the only way to yield the wall clock here. The two
      // budgets MULTIPLY rather than share — every attempt that reaches the busy
      // handler pays `busy_timeout` in full, so a reader holding SHARED costs
      // `maxBusyRetries + 1` times it: measured 58,408 ms at the defaults, with the
      // event loop blocked throughout (a timer scheduled at +50 ms fired at
      // +58,409 ms). Bounded, and acceptable for a one-shot CLI, but tuning
      // `maxBusyRetries` and tuning `busyTimeoutMs` are separate levers on that
      // same worst case, not one lever seen twice.
      if (isSqliteBusy(err) && attempt < maxBusyRetries) {
        sleepSync(busyRetryBaseMs * (attempt + 1));
        continue;
      }
      throw err;
    }

    const mode =
      typeof applied?.journal_mode === 'string' ? applied.journal_mode.toLowerCase() : undefined;
    if (mode === 'wal') {
      return;
    }
    if (mode === 'memory' && !isFileBacked(db)) {
      return;
    }
    // Not a contention failure — a real fallback. Refuse without retrying: the
    // answer will not change on a second ask.
    throw new WalJournalModeUnavailableError(mode);
  }
}

/** Wraps a `node:sqlite` prepared statement in the {@link SqlStatement} contract. */
class NativeStatement implements SqlStatement {
  constructor(private readonly stmt: ReturnType<DatabaseSync['prepare']>) {}

  run(params?: SqlParams): SqlRunResult {
    const result = params === undefined ? this.stmt.run() : this.stmt.run(toPortableParams(params));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T extends SqlRow>(params?: SqlParams): T | undefined {
    const row = params === undefined ? this.stmt.get() : this.stmt.get(toPortableParams(params));
    return row as unknown as T | undefined;
  }

  all<T extends SqlRow>(params?: SqlParams): readonly T[] {
    const rows = params === undefined ? this.stmt.all() : this.stmt.all(toPortableParams(params));
    return rows as unknown as readonly T[];
  }
}

/** Wraps the open connection in the {@link SqlTransaction} contract. */
class NativeTransaction implements SqlTransaction {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqlStatement {
    return new NativeStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

/**
 * Native SQLite driver over `node:sqlite`.
 *
 * Multi-process capable: WAL plus `BEGIN IMMEDIATE` give genuine cross-process
 * write serialization — the property the old file locks hand-rolled.
 */
export class NativeSqlDriver implements SqlDriver {
  readonly kind = 'native' as const;
  readonly capabilities = { multiProcess: true } as const;

  private readonly maxBusyRetries: number;
  private readonly busyRetryBaseMs: number;
  private closed = false;

  /**
   * Construct and initialize a native driver over an open connection.
   *
   * @param db - Open `node:sqlite` database connection.
   * @param options - Optional busy-timeout and retry tuning.
   * @throws {WalJournalModeUnavailableError} When a file-backed connection did
   *   not enter WAL mode — the silent rollback-journal fallback
   *   {@link enterWalJournalMode} refuses.
   */
  constructor(
    private readonly db: DatabaseSync,
    options: NativeDriverOptions = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.maxBusyRetries = options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;
    this.busyRetryBaseMs = options.busyRetryBaseMs ?? DEFAULT_BUSY_RETRY_BASE_MS;
    this.db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
    enterWalJournalMode(this.db, {
      maxBusyRetries: this.maxBusyRetries,
      busyRetryBaseMs: this.busyRetryBaseMs,
    });
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /**
   * Run read-only work in a deferred transaction.
   *
   * Declared `async` so EVERY failure — including the use-after-disposal guard —
   * reaches the caller as a rejection. The method returns `Promise<T>`, so a
   * caller is entitled to write `driver.read(...).catch(...)`; a synchronous
   * throw would escape that handler. There is no `await` before `COMMIT`, so the
   * transaction still opens, runs, and closes synchronously within one turn.
   *
   * @template T - Value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction closes.
   */
  // `async` is deliberate with no `await` to reach for: it is what routes the
  // synchronous `assertOpen` throw into the returned promise. Dropping it to
  // satisfy the rule reintroduces the defect this signature exists to prevent.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read<T>(work: (tx: SqlReadTransaction) => SyncWork<T>): Promise<T> {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const result = work(readOnlyTransaction(new NativeTransaction(this.db)));
      assertSyncWorkResult(result);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.rollback();
      throw isError(err) ? err : new Error(String(err));
    }
  }

  /**
   * Run writing work in a `BEGIN IMMEDIATE` transaction, retrying the whole
   * transaction on `SQLITE_BUSY` up to the configured budget.
   *
   * @template T - Value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction commits.
   */
  async immediate<T>(work: (tx: SqlTransaction) => SyncWork<T>): Promise<T> {
    this.assertOpen();
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
      } catch (err) {
        if (isSqliteBusy(err) && attempt < this.maxBusyRetries) {
          await delay(this.busyRetryBaseMs * (attempt + 1));
          continue;
        }
        throw err;
      }
      try {
        const result = work(new NativeTransaction(this.db));
        assertSyncWorkResult(result);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.rollback();
        throw err;
      }
    }
  }

  /**
   * Close the underlying connection. Idempotent.
   *
   * @returns Resolves once the connection is closed.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.db.close();
    await Promise.resolve();
  }

  /**
   * Throw if the driver has been disposed.
   *
   * @throws {Error} When used after disposal.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('NativeSqlDriver used after disposal');
    }
  }

  /** Roll back the active transaction, swallowing a "no transaction" error. */
  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // A failed statement inside the transaction may have already aborted it;
      // ROLLBACK then throws "cannot rollback - no transaction is active". The
      // original error is the one worth surfacing, so swallow this.
    }
  }
}

/**
 * Open a native SQLite driver at a filesystem path (or `:memory:`).
 *
 * @param dbPath - Path to the database file, or `':memory:'`.
 * @param options - Optional busy-timeout and retry tuning.
 * @returns An initialized {@link NativeSqlDriver}.
 * @throws {WalJournalModeUnavailableError} When a file-backed database fell back
 *   to a rollback journal.
 * @throws {Error} When the connection cannot be opened or otherwise configured.
 */
export function openNativeDriver(dbPath: string, options?: NativeDriverOptions): NativeSqlDriver {
  const db = new DatabaseSync(dbPath);
  try {
    return new NativeSqlDriver(db, options);
  } catch (err) {
    // The driver never took ownership, so nothing else can close this handle:
    // a refused configuration would otherwise leak the connection (and, on
    // Windows, keep the file locked) for the process lifetime. Closing must not
    // replace the refusal that caused it.
    try {
      db.close();
    } catch {
      // The open failure is the one worth surfacing.
    }
    throw err;
  }
}

/**
 * Resolve after `ms` milliseconds. Used only between busy retries, never inside
 * an open transaction.
 *
 * @param ms - Delay in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
