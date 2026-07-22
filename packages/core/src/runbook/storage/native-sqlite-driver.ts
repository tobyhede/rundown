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
 * @module runbook/storage/native-sqlite-driver
 */

import { DatabaseSync } from 'node:sqlite';
import { isError, isNodeError, getErrorMessage } from '../../errors.js';
import type {
  SqlDriver,
  SqlParams,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlTransaction,
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
  if (typeof errcode !== 'number' || !Number.isInteger(errcode)) {
    return false;
  }
  const primaryCode = errcode & 0xff;
  return primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED;
}

/** Wraps a `node:sqlite` prepared statement in the {@link SqlStatement} contract. */
class NativeStatement implements SqlStatement {
  constructor(private readonly stmt: ReturnType<DatabaseSync['prepare']>) {}

  run(params?: SqlParams): SqlRunResult {
    const result = params === undefined ? this.stmt.run() : this.stmt.run(params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  get<T extends SqlRow>(params?: SqlParams): T | undefined {
    const row = params === undefined ? this.stmt.get() : this.stmt.get(params);
    return row as unknown as T | undefined;
  }

  all<T extends SqlRow>(params?: SqlParams): readonly T[] {
    const rows = params === undefined ? this.stmt.all() : this.stmt.all(params);
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
   * @template T - Value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the transaction closes.
   */
  // `node:sqlite` is synchronous, so this body has no await; it is `async` to
  // satisfy the Promise-returning {@link SqlDriver} contract with direct
  // return/throw rather than hand-rolled Promise.resolve/reject.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read<T>(work: (tx: SqlTransaction) => T): Promise<T> {
    this.assertOpen();
    this.db.exec('BEGIN');
    try {
      const result = work(new NativeTransaction(this.db));
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.rollback();
      // `Error.isError` (via `isError`) recognizes cross-realm and non-native
      // errors that a bare `instanceof Error` would miss and needlessly re-wrap.
      throw isError(err) ? err : new Error(getErrorMessage(err));
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
  async immediate<T>(work: (tx: SqlTransaction) => T): Promise<T> {
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
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.rollback();
        // Same normalization as `read`: surface a cross-realm/native error as
        // itself, wrapping only genuinely non-Error throws. The `BEGIN IMMEDIATE`
        // catch above is deliberately left raw so `isSqliteBusy` can still read
        // its `errcode`.
        throw isError(err) ? err : new Error(getErrorMessage(err));
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
