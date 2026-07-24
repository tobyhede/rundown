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
 * voids the cross-process guarantee this adapter advertises.
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
  /** `PRAGMA busy_timeout` in milliseconds. */
  readonly busyTimeoutMs?: number;
  /** Maximum `BEGIN IMMEDIATE` attempts before surfacing `SQLITE_BUSY`. */
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
  return errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED;
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
   */
  constructor(
    private readonly db: DatabaseSync,
    options: NativeDriverOptions = {},
  ) {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.maxBusyRetries = options.maxBusyRetries ?? DEFAULT_MAX_BUSY_RETRIES;
    this.busyRetryBaseMs = options.busyRetryBaseMs ?? DEFAULT_BUSY_RETRY_BASE_MS;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
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
 */
export function openNativeDriver(dbPath: string, options?: NativeDriverOptions): NativeSqlDriver {
  return new NativeSqlDriver(new DatabaseSync(dbPath), options);
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
