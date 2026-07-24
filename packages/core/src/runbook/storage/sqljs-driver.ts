/**
 * WASM `sql.js` driver.
 *
 * Backs single-writer WebContainer hosts where native machine code (and thus
 * `node:sqlite`'s C internals and native addons) is unavailable. sql.js is an
 * in-memory SQLite compiled to WebAssembly; it provides NO cross-process
 * serialization on its own. This adapter supplies that serialization by holding
 * an adapter-owned advisory file lock around each short
 * `load → transaction → export → temp fsync → rename → dir fsync` critical
 * section, and one in-process async mutex so the non-reentrant file lock is
 * never recursively acquired.
 *
 * Durability inside the lock is mandatory: the exported image is written to a
 * same-directory temp file, fsynced, atomically renamed over the database, and
 * the containing directory fsynced where supported, before success is reported.
 * A crash mid-cycle never adopts a partial image as authority; orphaned temp
 * files are reclaimed on the next locked open.
 *
 * @module runbook/storage/sqljs-driver
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BindParams, Database, SqlJsStatic, SqlValue, Statement } from 'sql.js';
import { isNodeError } from '../../errors.js';
import { acquireFileLock, heldLock, releaseFileLock } from '../file-lock.js';
import { assertSyncWorkResult, readOnlyTransaction, toPortableBindValue } from './sql-driver.js';
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

/**
 * Stages of the durable-export cycle, exposed for fault injection.
 *
 * A test supplies a {@link SqljsDriverOptions.faultHook} that throws at a named
 * stage to prove no partial image is ever adopted and the last durable rename
 * wins.
 */
export type SqljsPersistStage =
  | 'after-export'
  | 'after-temp-write'
  | 'after-temp-fsync'
  | 'after-rename'
  | 'after-dir-fsync';

/** Options for the sql.js driver. */
export interface SqljsDriverOptions {
  /**
   * Test-only hook invoked at each durability stage. Throwing simulates a crash
   * at that boundary. Never set in production.
   */
  readonly faultHook?: (stage: SqljsPersistStage) => void;
  /** Test-only replacement for opening the directory fsync handle. */
  readonly directoryOpen?: (directory: string) => Promise<fs.FileHandle>;
  /** Test-only replacement for releasing the adapter lock. */
  readonly releaseLock?: (lockFile: string) => Promise<void>;
}

/** Suffix marking an in-flight export temp file for this driver. */
const TEMP_SUFFIX = '.tmp';

/**
 * Translate the driver's bare named parameters to sql.js's `:`-prefixed bind
 * keys.
 *
 * `node:sqlite` accepts bare keys (`{ id }` binds `:id`); sql.js silently binds
 * NULL for bare keys and requires the prefix character in the bind object. This
 * is the one binding divergence between the two adapters, isolated here so the
 * store writes one dialect of SQL and one shape of params.
 *
 * @param params - Bare named parameters.
 * @returns The same values keyed by `:`-prefixed names.
 */
function toSqljsParams(params: SqlParams): BindParams {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) {
    // sql.js's SqlValue excludes bigint, and this build has no bind_int64, so
    // an out-of-range value would reach SQLite through a float64 and be stored
    // TRUNCATED with no error. The shared guard refuses it instead; in-range
    // values narrow to number, which both adapters store identically.
    out[`:${key}`] = toPortableBindValue(key, value);
  }
  return out;
}

/** Wraps a sql.js prepared statement in the {@link SqlStatement} contract. */
class SqljsStatement implements SqlStatement {
  constructor(
    private readonly stmt: Statement,
    private readonly db: Database,
  ) {}

  run(params?: SqlParams): SqlRunResult {
    this.stmt.reset();
    if (params === undefined) {
      this.stmt.run();
    } else {
      this.stmt.run(toSqljsParams(params));
    }
    return {
      changes: this.db.getRowsModified(),
      lastInsertRowid: lastInsertRowid(this.db),
    };
  }

  get<T extends SqlRow>(params?: SqlParams): T | undefined {
    this.stmt.reset();
    if (params !== undefined) {
      this.stmt.bind(toSqljsParams(params));
    }
    const row = this.stmt.step() ? (this.stmt.getAsObject() as T) : undefined;
    this.stmt.reset();
    return row;
  }

  all<T extends SqlRow>(params?: SqlParams): readonly T[] {
    this.stmt.reset();
    if (params !== undefined) {
      this.stmt.bind(toSqljsParams(params));
    }
    const rows: T[] = [];
    while (this.stmt.step()) {
      rows.push(this.stmt.getAsObject() as T);
    }
    this.stmt.reset();
    return rows;
  }
}

/** Wraps an in-memory sql.js database in the {@link SqlTransaction} contract. */
class SqljsTransaction implements SqlTransaction {
  private readonly statements: Statement[] = [];

  constructor(private readonly db: Database) {}

  prepare(sql: string): SqlStatement {
    const stmt = this.db.prepare(sql);
    this.statements.push(stmt);
    return new SqljsStatement(stmt, this.db);
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  /** Free every prepared statement created during this transaction. */
  dispose(): void {
    for (const stmt of this.statements) {
      stmt.free();
    }
  }
}

/**
 * WASM SQLite driver over sql.js.
 *
 * Single-writer only: correctness across processes depends on the adapter-owned
 * file lock making each load/CAS/export cycle atomic. This is NOT the native
 * adapter's genuine multi-process serialization.
 */
export class SqljsDriver implements SqlDriver {
  readonly kind = 'sqljs' as const;
  readonly capabilities = { multiProcess: false } as const;

  private readonly dir: string;
  private readonly lockFile: string;
  private mutexTail: Promise<unknown> = Promise.resolve();
  private closed = false;

  /**
   * Construct a sql.js driver.
   *
   * @param sql - Initialized sql.js module.
   * @param dbPath - Path to the database file on the shared filesystem.
   * @param options - Optional fault-injection hook (tests only).
   */
  constructor(
    private readonly sql: SqlJsStatic,
    private readonly dbPath: string,
    private readonly options: SqljsDriverOptions = {},
  ) {
    this.dir = path.dirname(dbPath);
    this.lockFile = `${dbPath}.lock`;
  }

  /**
   * Run read-only work against a freshly loaded image under the file lock.
   *
   * @template T - Value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value.
   */
  async read<T>(work: (tx: SqlReadTransaction) => SyncWork<T>): Promise<T> {
    return this.runLocked(async () => {
      const db = await this.load();
      const tx = new SqljsTransaction(db);
      try {
        const result = work(readOnlyTransaction(tx));
        assertSyncWorkResult(result);
        return result;
      } finally {
        tx.dispose();
        db.close();
      }
    });
  }

  /**
   * Run writing work under the file lock, then durably persist the image.
   *
   * @template T - Value the work callback returns.
   * @param work - Synchronous callback receiving the open transaction.
   * @returns The callback's return value once the image is persisted.
   */
  async immediate<T>(work: (tx: SqlTransaction) => SyncWork<T>): Promise<T> {
    return this.runLocked(async () => {
      const db = await this.load();
      const tx = new SqljsTransaction(db);
      let result: T;
      db.run('BEGIN');
      try {
        result = work(tx);
        assertSyncWorkResult(result);
        db.run('COMMIT');
      } catch (err) {
        rollbackQuietly(db);
        tx.dispose();
        db.close();
        throw err;
      }
      try {
        await this.persist(db);
      } finally {
        tx.dispose();
        db.close();
      }
      return result;
    });
  }

  /**
   * Drain queued work, then mark the driver closed. Idempotent.
   *
   * @returns Resolves once in-flight work settles and the driver is closed.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.closed) {
      return;
    }
    // Drain in-flight and queued critical sections before closing, so a caller
    // that returns an unawaited read/write from an `await using` scope still
    // completes rather than racing the disposal flag.
    await this.mutexTail.then(
      () => undefined,
      () => undefined,
    );
    this.closed = true;
  }

  /**
   * Serialize a critical section behind the in-process mutex and the
   * cross-process file lock, reclaiming orphan temps before the work runs.
   *
   * @template T - Value the critical section returns.
   * @param fn - The locked critical section.
   * @returns The section's result.
   */
  private runLocked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutexTail.then(async () => {
      if (this.closed) {
        throw new Error('SqljsDriver used after disposal');
      }
      await acquireFileLock(this.lockFile, this.dir);
      // Best-effort scoped release (RD-102): a failed unlink leaks only a
      // self-healing lock — the next acquirer reclaims it by PID — so it must
      // never propagate and replace the committed outcome of the durable write
      // this lock protected. A bare `finally` would do exactly that. Release
      // routes through the `releaseLock` seam so tests can inject failure.
      await using _guard = heldLock(
        () => this.releaseLock(),
        () => ({ lock: this.lockFile, driver: 'sqljs' }),
      );
      await this.reclaimOrphanTemps();
      return await fn();
    });
    // Keep the mutex chain alive regardless of this section's outcome.
    this.mutexTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Load the current on-disk image into a fresh in-memory database.
   *
   * A missing file yields an empty database (first init). Because the write path
   * renames atomically, a load never observes a torn image.
   *
   * Every load is a NEW connection, and SQLite defaults `foreign_keys` OFF per
   * connection, so the pragma is re-applied here rather than once at open —
   * otherwise the schema's referential invariants would hold under the native
   * adapter and silently not under this one.
   *
   * @returns A newly opened in-memory database.
   */
  private async load(): Promise<Database> {
    const db = await this.open();
    db.run('PRAGMA foreign_keys = ON');
    return db;
  }

  /**
   * Open the stored image, or an empty database on first init.
   *
   * @returns A newly opened in-memory database with no pragmas applied.
   */
  private async open(): Promise<Database> {
    try {
      const bytes = await fs.readFile(this.dbPath);
      return new this.sql.Database(bytes);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return new this.sql.Database();
      }
      throw err;
    }
  }

  /**
   * Durably persist the in-memory image over the database file.
   *
   * Exports, writes to a unique same-directory temp, fsyncs it, atomically
   * renames it over the database, and fsyncs the directory where supported. The
   * fault hook fires between stages so tests can crash at each boundary.
   *
   * @param db - The in-memory database to export.
   */
  private async persist(db: Database): Promise<void> {
    const bytes = db.export();
    this.fault('after-export');
    const tmp = path.join(this.dir, `${path.basename(this.dbPath)}.${randomUUID()}${TEMP_SUFFIX}`);
    const handle = await fs.open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      this.fault('after-temp-write');
      await handle.sync();
      this.fault('after-temp-fsync');
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.dbPath);
    this.fault('after-rename');
    await this.fsyncDir();
    this.fault('after-dir-fsync');
  }

  /** Fsync the containing directory where the host supports it. */
  private async fsyncDir(): Promise<void> {
    let dh: fs.FileHandle | undefined;
    try {
      dh = await this.openDirectory();
      await dh.sync();
    } catch (err) {
      if (!isUnsupportedDirectoryFsyncError(err)) {
        throw err;
      }
      // Some hosts do not support opening or syncing directories. Atomic rename
      // remains the strongest durability boundary those hosts expose.
    } finally {
      await dh?.close();
    }
  }

  /**
   * Open the containing directory through the production filesystem or test seam.
   *
   * @returns The opened file handle.
   */
  private openDirectory(): Promise<fs.FileHandle> {
    return this.options.directoryOpen?.(this.dir) ?? fs.open(this.dir, 'r');
  }

  /**
   * Release the adapter lock through the production filesystem or test seam.
   *
   * @returns A promise settled once release finishes.
   */
  private releaseLock(): Promise<void> {
    return this.options.releaseLock?.(this.lockFile) ?? releaseFileLock(this.lockFile);
  }

  /**
   * Remove crash-orphaned export temp files.
   *
   * Runs under the file lock, so no other writer is mid-cycle: any temp matching
   * this database's export pattern is a crash remnant and is safe to unlink.
   */
  private async reclaimOrphanTemps(): Promise<void> {
    const prefix = `${path.basename(this.dbPath)}.`;
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
    await Promise.all(
      entries
        .filter((name) => name.startsWith(prefix) && name.endsWith(TEMP_SUFFIX))
        .map((name) => removeQuietly(path.join(this.dir, name))),
    );
  }

  /**
   * Invoke the fault hook for a stage, if one is configured.
   *
   * @param stage - The durability stage that just completed.
   */
  private fault(stage: SqljsPersistStage): void {
    this.options.faultHook?.(stage);
  }
}

/**
 * Identify host errors that specifically mean directory fsync is unsupported.
 *
 * Permission and I/O failures are deliberately excluded: acknowledging those
 * would report durability that the filesystem did not provide.
 *
 * @param err - Failure from opening or syncing the containing directory.
 * @returns Whether the host lacks directory-open/fsync support.
 */
function isUnsupportedDirectoryFsyncError(err: unknown): boolean {
  return (
    isNodeError(err) &&
    (err.code === 'EINVAL' ||
      err.code === 'ENOTSUP' ||
      err.code === 'EOPNOTSUPP' ||
      err.code === 'EISDIR' ||
      err.code === 'ENOSYS')
  );
}

/**
 * Read the last inserted rowid from a sql.js database.
 *
 * sql.js exposes no per-statement `lastInsertRowid`, so it is queried from the
 * connection immediately after the insert.
 *
 * @param db - The in-memory database.
 * @returns The last inserted rowid.
 */
function lastInsertRowid(db: Database): number {
  const result = db.exec('SELECT last_insert_rowid() AS id');
  const value = result[0]?.values[0]?.[0];
  return typeof value === 'number' ? value : 0;
}

/**
 * Roll back a sql.js transaction, swallowing a "no transaction" error.
 *
 * @param db - The in-memory database to roll back.
 */
function rollbackQuietly(db: Database): void {
  try {
    db.run('ROLLBACK');
  } catch {
    // A failed statement may have already aborted the transaction.
  }
}

/**
 * Unlink a path, swallowing ENOENT.
 *
 * @param target - Absolute path to unlink.
 */
async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (err) {
    if (!isNodeError(err) || err.code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Load and initialize a sql.js driver at a filesystem path.
 *
 * @param dbPath - Path to the database file on the shared filesystem.
 * @param options - Optional fault-injection hook (tests only).
 * @returns An initialized {@link SqljsDriver}.
 */
export async function openSqljsDriver(
  dbPath: string,
  options?: SqljsDriverOptions,
): Promise<SqljsDriver> {
  const initSqlJs = (await import('sql.js')).default;
  const sql = await initSqlJs();
  return new SqljsDriver(sql, dbPath, options);
}
