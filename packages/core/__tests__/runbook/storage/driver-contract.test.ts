import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import type { SqlJsStatic } from 'sql.js';
import { getErrorMessage, isNodeError } from '../../../src/errors.js';
import {
  AsyncTransactionWorkError,
  UnrepresentableIntegerError,
  type SqlDriver,
} from '../../../src/runbook/storage/sql-driver.js';
import {
  NativeSqlDriver,
  openNativeDriver,
  isSqliteBusy,
} from '../../../src/runbook/storage/native-sqlite-driver.js';
import {
  SqljsDriver,
  openSqljsDriver,
  type SqljsPersistStage,
} from '../../../src/runbook/storage/sqljs-driver.js';
import { ensureSchema, IncompatibleSchemaError } from '../../../src/runbook/storage/schema.js';
import {
  isWebContainerRuntime,
  selectStorageRuntime,
  openRunbookDriver,
  NativeSqliteUnavailableError,
  SqljsUnsupportedHostError,
  STORAGE_RUNTIME_ENV,
} from '../../../src/runbook/storage/driver-factory.js';

const CREATE_KV = 'CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-driver-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Run an operation and resolve with whatever it failed with, or `undefined` when
 * it succeeded. Wrapping in `Promise.resolve().then` normalizes a synchronous
 * throw into a rejection, so a caller can assert on the failure VALUE without
 * also asserting on its delivery shape. Both adapters deliver every failure as a
 * rejection — `rejects rather than throwing when a disposed driver is used` is
 * the test that pins that separately.
 */
async function failureOf(op: () => unknown): Promise<unknown> {
  return await Promise.resolve()
    .then(op)
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

interface Adapter {
  readonly name: 'native' | 'sqljs';
  open(): Promise<SqlDriver>;
}

const ADAPTERS: readonly Adapter[] = [
  {
    name: 'native',
    open: () => Promise.resolve(openNativeDriver(path.join(dir, 'rundown.db'))),
  },
  {
    name: 'sqljs',
    open: () => openSqljsDriver(path.join(dir, 'rundown.db')),
  },
];

describe.each(ADAPTERS)('SqlDriver contract [$name]', (adapter) => {
  it('reports its multiProcess capability honestly', async () => {
    await using driver = await adapter.open();
    expect(driver.kind).toBe(adapter.name);
    expect(driver.capabilities.multiProcess).toBe(adapter.name === 'native');
  });

  it('commits a write so a later read observes it', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'a', v: 1 });
    });
    const value = await driver.read(
      (tx) =>
        tx.prepare('SELECT v FROM kv WHERE k = :k').get<{ readonly v: number }>({ k: 'a' })?.v,
    );
    expect(value).toBe(1);
  });

  it('rolls back every write when the transaction throws, and rethrows', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });
    const boom = new Error('boom');
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'b', v: 2 });
        throw boom;
      }),
    ).rejects.toBe(boom);

    const count = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(count).toBe(0);
  });

  it('binds named parameters by name', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      const stmt = tx.prepare('INSERT INTO kv VALUES(:k, :v)');
      stmt.run({ k: 'x', v: 10 });
      stmt.run({ k: 'y', v: 20 });
    });
    const rows = await driver.read((tx) =>
      tx
        .prepare('SELECT k, v FROM kv ORDER BY k')
        .all<{ readonly k: string; readonly v: number }>(),
    );
    expect(rows).toEqual([
      { k: 'x', v: 10 },
      { k: 'y', v: 20 },
    ]);
  });

  it('filters through all() with bound parameters', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      const stmt = tx.prepare('INSERT INTO kv VALUES(:k, :v)');
      stmt.run({ k: 'lo', v: 1 });
      stmt.run({ k: 'hi', v: 9 });
    });
    const rows = await driver.read((tx) =>
      tx
        .prepare('SELECT k FROM kv WHERE v >= :min ORDER BY k')
        .all<{ readonly k: string }>({ min: 5 }),
    );
    expect(rows).toEqual([{ k: 'hi' }]);
  });

  it('executes a parameterless statement through run()', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      const stmt = tx.prepare('INSERT INTO kv VALUES(:k, :v)');
      stmt.run({ k: 'a', v: 1 });
      stmt.run({ k: 'b', v: 2 });
    });
    const deleted = await driver.immediate((tx) => tx.prepare('DELETE FROM kv').run());
    expect(deleted.changes).toBe(2);
    const remaining = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(remaining).toBe(0);
  });

  it('binds a bigint parameter as a SQLite integer', async () => {
    await using driver = await adapter.open();
    const bound = 2n ** 40n;
    const stored = await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'big', v: bound });
      return tx.prepare('SELECT v FROM kv WHERE k = :k').get<{ readonly v: number }>({
        k: 'big',
      })?.v;
    });
    expect(Number(stored)).toBe(Number(bound));
  });

  it('round-trips a bigint at the safe-integer boundary exactly', async () => {
    await using driver = await adapter.open();
    const bound = BigInt(Number.MAX_SAFE_INTEGER);
    const storedText = await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'edge', v: bound });
      // Read the value back as TEXT so SQLite reports what it actually stored,
      // rather than whatever the adapter's JS number conversion produces.
      return tx
        .prepare('SELECT CAST(v AS TEXT) AS t FROM kv WHERE k = :k')
        .get<{ readonly t: string }>({ k: 'edge' })?.t;
    });
    expect(storedText).toBe(String(bound));
  });

  it('refuses a bigint beyond the safe-integer range instead of corrupting it', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });
    // MAX_SAFE_INTEGER + 2 is the smallest odd integer above the safe range.
    // Unguarded, sql.js stores 9007199254740992 for it with no error, and the
    // native adapter stores it exactly but then throws on every read.
    const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'beyond', v: beyond });
      }),
    ).rejects.toBeInstanceOf(UnrepresentableIntegerError);

    // The refusal happens at bind time, so nothing is written.
    const count = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(count).toBe(0);
  });

  it('closes a completed read transaction so a later write still commits', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });
    const count = (): Promise<number | undefined> =>
      driver.read(
        (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
      );

    // A read that is interleaved with writes, not the last statement of the
    // test: a read that forgot to end its transaction would block this write.
    expect(await count()).toBe(0);
    await driver.immediate((tx) => {
      tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'a', v: 1 });
    });
    expect(await count()).toBe(1);
  });

  it('returns the RETURNING row through get()', async () => {
    await using driver = await adapter.open();
    const returned = await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
      return tx
        .prepare('INSERT INTO kv VALUES(:k, :v) RETURNING v AS rv')
        .get<{ readonly rv: number }>({ k: 'r', v: 42 });
    });
    expect(returned).toEqual({ rv: 42 });
  });

  it('reports changes and lastInsertRowid from run()', async () => {
    await using driver = await adapter.open();
    const result = await driver.immediate((tx) => {
      tx.exec('CREATE TABLE seq (id INTEGER PRIMARY KEY, k TEXT)');
      return tx.prepare('INSERT INTO seq (k) VALUES(:k)').run({ k: 'first' });
    });
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);
  });

  it('unwinds a failed read and stays usable afterwards', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });
    const boom = new Error('read boom');
    await expect(
      driver.read(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // The failed read must leave no transaction open, so the next write commits.
    await driver.immediate((tx) => {
      tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'after', v: 7 });
    });
    const value = await driver.read(
      (tx) =>
        tx.prepare('SELECT v FROM kv WHERE k = :k').get<{ readonly v: number }>({ k: 'after' })?.v,
    );
    expect(value).toBe(7);
  });

  it('refuses every operation after disposal, and disposes idempotently', async () => {
    const driver = await adapter.open();
    await driver[Symbol.asyncDispose]();

    for (const op of [
      () =>
        driver.read((tx) => {
          tx.prepare('SELECT 1').get();
        }),
      () =>
        driver.immediate((tx) => {
          tx.exec('SELECT 1');
        }),
    ]) {
      expect(getErrorMessage(await failureOf(op))).toMatch(/used after disposal/);
    }

    await expect(driver[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('rejects rather than throwing when a disposed driver is used', async () => {
    const driver = await adapter.open();
    await driver[Symbol.asyncDispose]();

    // Both methods declare Promise<T>, so a caller is entitled to route the
    // failure through .catch(). A guard that throws synchronously escapes that
    // handler entirely and crashes the caller instead — attaching .catch() at
    // the call site is what distinguishes the two deliveries.
    for (const op of [
      () => driver.read(() => undefined),
      () => driver.immediate(() => undefined),
    ]) {
      let caught: unknown;
      await op().catch((err: unknown) => {
        caught = err;
      });
      expect(getErrorMessage(caught)).toMatch(/used after disposal/);
    }
  });

  it('rethrows a cross-realm error unchanged instead of re-wrapping it', async () => {
    // Work callbacks are caller code, and caller code can hand back an Error
    // minted in another realm — Jest's VM modules, vm.runInNewContext, a worker
    // thread. `instanceof Error` is false for those, so a driver that narrows
    // with it silently replaces the real failure with new Error(String(err)),
    // discarding the stack and cause the caller needs to diagnose it.
    await using driver = await adapter.open();
    const foreign = runInNewContext('new Error("cross-realm boom")') as Error;
    expect(foreign instanceof Error).toBe(false);

    for (const op of [
      () =>
        driver.read(() => {
          throw foreign;
        }),
      () =>
        driver.immediate(() => {
          throw foreign;
        }),
    ]) {
      // Identity, not shape: a re-wrapped copy would still match a message
      // assertion while having lost everything that made it diagnosable.
      expect(await failureOf(op)).toBe(foreign);
    }
  });

  it('hands read work a transaction with no mutating surface', async () => {
    // A "read-only" transaction that still exposes exec()/run() is only read-only
    // by convention: under the sql.js adapter a mutation made through read() is
    // silently discarded (read never persists), so the restriction has to be real
    // rather than documented.
    await using driver = await adapter.open();
    const surface = await driver.read((tx) => ({
      hasExec: 'exec' in tx,
      hasRun: 'run' in tx.prepare('SELECT 1 AS one'),
      reads: tx.prepare('SELECT 1 AS one').get<{ readonly one: number }>()?.one,
    }));
    expect(surface).toEqual({ hasExec: false, hasRun: false, reads: 1 });
  });

  it('pins the read surface and the sync-only work contract at compile time', async () => {
    await using driver = await adapter.open();
    // Never invoked: every statement below is a type assertion. `@ts-expect-error`
    // fails the build if the surface widens, which is the point — the runtime
    // guards below are the backstop, not the primary constraint.
    const compileOnly = async (): Promise<void> => {
      await driver.read((tx) => {
        // @ts-expect-error - a read transaction exposes no exec()
        tx.exec('CREATE TABLE nope (x)');
        // @ts-expect-error - a read statement exposes no run()
        tx.prepare('DELETE FROM kv').run();
      });
      // @ts-expect-error - work must be synchronous: no awaiting under the lock
      await driver.read(async () => 1);
      // @ts-expect-error - work must be synchronous: no awaiting under the lock
      await driver.immediate(async () => 1);
      // @ts-expect-error - a promise-returning callback is async work by any name
      await driver.immediate(() => Promise.resolve(1));
    };
    expect(typeof compileOnly).toBe('function');
  });

  it('refuses promise-returning read work instead of closing the transaction around it', async () => {
    await using driver = await adapter.open();
    // Cast: the type contract already rejects this. The runtime guard is what
    // protects a JavaScript caller, or a callback whose promise return is
    // hidden behind an `any`-typed helper.
    const asyncWork = (): number => Promise.resolve(1) as unknown as number;

    const err = await failureOf(() => driver.read(asyncWork));
    expect(err).toBeInstanceOf(AsyncTransactionWorkError);
    expect((err as Error).name).toBe('AsyncTransactionWorkError');
    // The message has to say WHY, not just "no": the caller's next move is to
    // hoist the await out of the transaction, which the wording has to imply.
    expect(getErrorMessage(err)).toMatch(/must be synchronous/);
    expect(getErrorMessage(err)).toMatch(/commit before the awaited work ran/);

    // The refusal must leave no transaction open, so the next write still commits.
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });
    const count = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(count).toBe(0);
  });

  it('consumes the rejection of the async work it refused', async () => {
    // Refusing the work does not un-start it. The promise is already running and
    // nothing will ever await it — the caller gets AsyncTransactionWorkError
    // instead — so its eventual rejection has no handler. Under Node's default
    // policy an unhandled rejection terminates the process, which would turn a
    // refused transaction into a crash of the whole CLI.
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      await using driver = await adapter.open();
      const rejectsLater = (): number =>
        Promise.reject(new Error('rejected after the driver refused it')) as unknown as number;

      await expect(driver.immediate(rejectsLater)).rejects.toBeInstanceOf(
        AsyncTransactionWorkError,
      );

      // Unhandled rejections are reported a turn later, so yield the loop
      // before asserting none arrived.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('passes a null work result through rather than mistaking it for a thenable', async () => {
    // `typeof null === 'object'`, so a thenable check that forgets the null case
    // dereferences it and turns a perfectly valid "found nothing" into a crash.
    await using driver = await adapter.open();
    await expect(driver.read(() => null)).resolves.toBeNull();
    await expect(driver.immediate(() => null)).resolves.toBeNull();
  });

  it('refuses promise-returning write work instead of committing around it', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });

    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'a', v: 1 });
        return Promise.resolve(1) as unknown as number;
      }),
    ).rejects.toBeInstanceOf(AsyncTransactionWorkError);

    // The write staged before the refusal must have rolled back, not committed.
    const count = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(count).toBe(0);
  });

  it('enforces foreign keys on write', async () => {
    // The schema's referential invariants (claims → runs, and the deferred
    // runs → execution_attempts identity link) are only real if BOTH adapters
    // enforce them. SQLite defaults `foreign_keys` OFF, so this is a per-adapter
    // configuration property, not something the DDL can guarantee on its own.
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
      tx.exec(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
      );
    });
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO child VALUES(:id, :parent)').run({ id: 1, parent: 99 });
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('enforces a deferred foreign key at commit', async () => {
    // The runs → execution_attempts link is DEFERRABLE INITIALLY DEFERRED, so
    // the violation surfaces from COMMIT rather than from the statement. An
    // adapter that never reaches a real COMMIT would silently accept it.
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
      tx.exec(
        `CREATE TABLE child (
           id INTEGER PRIMARY KEY,
           parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
         )`,
      );
    });
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO child VALUES(:id, :parent)').run({ id: 1, parent: 99 });
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);

    // The rejected transaction must leave the driver usable and the row absent.
    await driver.immediate((tx) => {
      tx.prepare('INSERT INTO parent VALUES(:id)').run({ id: 99 });
      tx.prepare('INSERT INTO child VALUES(:id, :parent)').run({ id: 1, parent: 99 });
    });
    const rows = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM child').get<{ readonly c: number }>()?.c,
    );
    expect(rows).toBe(1);
  });

  it('rejects an incompatible schema version rather than migrating', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      ensureSchema(tx);
      tx.exec('PRAGMA user_version = 4242');
    });
    await expect(
      driver.immediate((tx) => {
        ensureSchema(tx);
      }),
    ).rejects.toBeInstanceOf(IncompatibleSchemaError);
  });
});

/** Build a `node:sqlite`-shaped error carrying a SQLite primary result code. */
function sqliteError(message: string, errcode: number): Error {
  return Object.assign(new Error(message), {
    code: 'ERR_SQLITE_ERROR',
    errcode,
  });
}

/**
 * Minimal `node:sqlite` stand-in that records every statement the driver issues
 * and can fail `BEGIN IMMEDIATE` on demand.
 *
 * The retry budget and its backoff growth are only observable through the number
 * and spacing of the `BEGIN IMMEDIATE` attempts a contended write makes, and the
 * close-once-per-driver contract is only observable by counting `close()`.
 */
class RecordingDatabase {
  readonly executed: string[] = [];
  closeCount = 0;

  constructor(private readonly beginIsContended: (attempt: number) => boolean) {}

  /** Number of `BEGIN IMMEDIATE` statements issued so far. */
  get beginAttempts(): number {
    return this.executed.filter((sql) => sql === 'BEGIN IMMEDIATE').length;
  }

  exec(sql: string): void {
    this.executed.push(sql);
    if (sql === 'BEGIN IMMEDIATE' && this.beginIsContended(this.beginAttempts)) {
      throw sqliteError('database is locked', 5);
    }
  }

  close(): void {
    this.closeCount += 1;
  }
}

/** Adapt a {@link RecordingDatabase} to the connection the driver expects. */
function recordingConnection(db: RecordingDatabase): DatabaseSync {
  return db as unknown as DatabaseSync;
}

describe('native adapter connection configuration', () => {
  it('opens in WAL mode with foreign keys on and the configured busy timeout', async () => {
    await using driver = new NativeSqlDriver(new DatabaseSync(path.join(dir, 'pragma.db')), {
      busyTimeoutMs: 1234,
    });
    const pragmas = await driver.read((tx) => ({
      journalMode: tx.prepare('PRAGMA journal_mode').get<{ readonly journal_mode: string }>()
        ?.journal_mode,
      busyTimeout: tx.prepare('PRAGMA busy_timeout').get<{ readonly timeout: number }>()?.timeout,
      foreignKeys: tx.prepare('PRAGMA foreign_keys').get<{ readonly foreign_keys: number }>()
        ?.foreign_keys,
    }));
    expect(pragmas).toEqual({
      journalMode: 'wal',
      busyTimeout: 1234,
      foreignKeys: 1,
    });
  });

  it('defaults the busy timeout to five seconds', async () => {
    await using driver = new NativeSqlDriver(new DatabaseSync(path.join(dir, 'pragma-default.db')));
    const busyTimeout = await driver.read(
      (tx) => tx.prepare('PRAGMA busy_timeout').get<{ readonly timeout: number }>()?.timeout,
    );
    expect(busyTimeout).toBe(5_000);
  });

  it('turns foreign keys on over a connection that opened with them disabled', async () => {
    // node:sqlite enables foreign-key constraints by default, so a driver opened
    // over a default connection cannot distinguish its own `PRAGMA foreign_keys
    // = ON` from the runtime default. Handing it a connection built with them
    // explicitly off is what proves the constructor's pragma does the work — and
    // keeps the guarantee pinned to the driver rather than to a node:sqlite
    // default that could change.
    await using driver = new NativeSqlDriver(
      new DatabaseSync(path.join(dir, 'fk-disabled.db'), { enableForeignKeyConstraints: false }),
    );
    const foreignKeys = await driver.read(
      (tx) =>
        tx.prepare('PRAGMA foreign_keys').get<{ readonly foreign_keys: number }>()?.foreign_keys,
    );
    expect(foreignKeys).toBe(1);
  });

  it('enforces foreign keys on write', async () => {
    await using driver = new NativeSqlDriver(new DatabaseSync(path.join(dir, 'fk.db')));
    await driver.immediate((tx) => {
      tx.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
      tx.exec(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))',
      );
    });
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO child VALUES(:id, :parent)').run({
          id: 1,
          parent: 99,
        });
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('closes the connection exactly once, however often it is disposed', async () => {
    const db = new RecordingDatabase(() => false);
    const driver = new NativeSqlDriver(recordingConnection(db));
    await driver[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
    expect(db.closeCount).toBe(1);
  });
});

describe('native adapter SQLITE_BUSY handling', () => {
  it('classifies busy and locked contention, and nothing else', () => {
    expect(isSqliteBusy(sqliteError('database is locked', 5))).toBe(true);
    expect(isSqliteBusy(sqliteError('database table is locked', 6))).toBe(true);
    // Any other SQLite result code is a real failure, not contention.
    expect(isSqliteBusy(sqliteError('constraint failed', 19))).toBe(false);
    expect(isSqliteBusy(new Error('unrelated'))).toBe(false);
    // A bare object is not an error, however busy-looking its fields.
    expect(isSqliteBusy({ code: 'ERR_SQLITE_ERROR', errcode: 5 })).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
  });

  it('retries a contended BEGIN IMMEDIATE exactly maxBusyRetries times, backing off further each attempt', async () => {
    const db = new RecordingDatabase(() => true);
    await using driver = new NativeSqlDriver(recordingConnection(db), {
      busyTimeoutMs: 0,
      maxBusyRetries: 2,
      busyRetryBaseMs: 60,
    });

    const startedAt = Date.now();
    const err = await failureOf(() => driver.immediate(() => 'unreachable'));
    const elapsedMs = Date.now() - startedAt;

    expect(isSqliteBusy(err)).toBe(true);
    // One initial attempt plus exactly maxBusyRetries retries.
    expect(db.beginAttempts).toBe(3);
    // Backoff grows with the attempt number: 60ms then 120ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(db.executed).not.toContain('COMMIT');
  });

  it('commits on the first BEGIN IMMEDIATE that wins the write lock', async () => {
    const db = new RecordingDatabase((attempt) => attempt < 3);
    await using driver = new NativeSqlDriver(recordingConnection(db), {
      busyTimeoutMs: 0,
      maxBusyRetries: 5,
      busyRetryBaseMs: 1,
    });
    await expect(driver.immediate(() => 'ok')).resolves.toBe('ok');
    expect(db.beginAttempts).toBe(3);
    expect(db.executed.at(-1)).toBe('COMMIT');
  });

  it('throws after exhausting the busy-retry budget when the lock never frees', async () => {
    const dbPath = path.join(dir, 'busy.db');
    // A separate raw connection holds the write lock for the whole test.
    const holder = new DatabaseSync(dbPath);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('PRAGMA journal_mode = WAL');
    holder.exec('CREATE TABLE t (x)');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec('INSERT INTO t VALUES (1)');

    await using driver = new NativeSqlDriver(new DatabaseSync(dbPath), {
      busyTimeoutMs: 0,
      maxBusyRetries: 2,
      busyRetryBaseMs: 5,
    });
    const err = await driver
      .immediate((tx) => {
        tx.prepare('INSERT INTO t VALUES (2)').run();
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isSqliteBusy(err)).toBe(true);

    holder.exec('COMMIT');
    holder.close();
  });

  it('succeeds once the contended write lock is released mid-retry', async () => {
    const dbPath = path.join(dir, 'busy2.db');
    const holder = new DatabaseSync(dbPath);
    holder.exec('PRAGMA busy_timeout = 0');
    holder.exec('PRAGMA journal_mode = WAL');
    holder.exec('CREATE TABLE t (x)');
    holder.exec('BEGIN IMMEDIATE');
    holder.exec('INSERT INTO t VALUES (1)');
    // Release the lock shortly, while the driver is still retrying.
    setTimeout(() => {
      holder.exec('COMMIT');
      holder.close();
    }, 40);

    await using driver = new NativeSqlDriver(new DatabaseSync(dbPath), {
      busyTimeoutMs: 0,
      maxBusyRetries: 50,
      busyRetryBaseMs: 10,
    });
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO t VALUES (2)').run();
      }),
    ).resolves.toBeUndefined();
  });
});

describe('positive driver selection', () => {
  it('identifies WebContainer only by its jsh shell marker', () => {
    expect(isWebContainerRuntime({ SHELL: '/bin/jsh' })).toBe(true);
    expect(isWebContainerRuntime({ SHELL: 'jsh' })).toBe(true);
    expect(isWebContainerRuntime({ SHELL: '/bin/bash' })).toBe(false);
    expect(isWebContainerRuntime({ SHELL: '/usr/bin/zsh' })).toBe(false);
    expect(isWebContainerRuntime({})).toBe(false);
    // The marker matches a whole path segment: neither a prefix nor a suffix of
    // some other shell name counts.
    // cspell:ignore jshell notjsh -- fixture shell names pinning both path-segment anchors
    expect(isWebContainerRuntime({ SHELL: '/bin/jshell' })).toBe(false);
    expect(isWebContainerRuntime({ SHELL: '/bin/notjsh' })).toBe(false);
  });

  it('selects sqljs only for WebContainer, native otherwise', () => {
    expect(selectStorageRuntime({ SHELL: '/bin/jsh' })).toBe('sqljs');
    expect(selectStorageRuntime({ SHELL: '/bin/bash' })).toBe('native');
    expect(selectStorageRuntime({})).toBe('native');
  });

  it('honors an explicit runtime override in the safe direction', () => {
    // Forcing NATIVE is always safe: it is the multi-process-capable adapter.
    expect(
      selectStorageRuntime({
        [STORAGE_RUNTIME_ENV]: 'native',
        SHELL: '/bin/jsh',
      }),
    ).toBe('native');
    expect(() => selectStorageRuntime({ [STORAGE_RUNTIME_ENV]: 'wat' })).toThrow();
  });

  it('refuses to force sql.js onto a host that is not WebContainer', () => {
    // The env override is user-reachable, so it must not be a way to opt a real
    // multi-process host into the single-writer adapter — that is the unsafe
    // downgrade this module exists to prevent, just spelled differently.
    const forced = { [STORAGE_RUNTIME_ENV]: 'sqljs', SHELL: '/bin/bash' };
    expect(() => selectStorageRuntime(forced)).toThrow(SqljsUnsupportedHostError);
    expect(() => selectStorageRuntime(forced)).toThrow(/WebContainer/);
    expect(() => selectStorageRuntime(forced)).toThrow(new RegExp(STORAGE_RUNTIME_ENV));
  });

  it('honors a forced sql.js override inside WebContainer', () => {
    expect(
      selectStorageRuntime({
        [STORAGE_RUNTIME_ENV]: 'sqljs',
        SHELL: '/bin/jsh',
      }),
    ).toBe('sqljs');
  });

  it('names the override variable and the offending value when it is invalid', () => {
    // Spelled literally: the env var name is the documented escape hatch.
    expect(STORAGE_RUNTIME_ENV).toBe('RUNDOWN_SQL_DRIVER');
    expect(() => selectStorageRuntime({ RUNDOWN_SQL_DRIVER: 'wat' })).toThrow(/RUNDOWN_SQL_DRIVER/);
    expect(() => selectStorageRuntime({ RUNDOWN_SQL_DRIVER: 'wat' })).toThrow(/"wat"/);
    expect(() => selectStorageRuntime({ RUNDOWN_SQL_DRIVER: 'wat' })).toThrow(
      /native.*sqljs|sqljs.*native/,
    );
  });

  it('opens a schema-ensured native driver from the factory', async () => {
    await using driver = await openRunbookDriver(path.join(dir, 'factory.db'), {
      runtime: 'native',
    });
    expect(driver.kind).toBe('native');
    const version = await driver.read(
      (tx) =>
        tx.prepare('PRAGMA user_version').get<{ readonly user_version: number }>()?.user_version,
    );
    expect(version).toBe(1);
  });

  it('opens a schema-ensured sql.js driver when that runtime is selected', async () => {
    await using driver = await openRunbookDriver(path.join(dir, 'factory-wasm.db'), {
      runtime: 'sqljs',
    });
    expect(driver.kind).toBe('sqljs');
    expect(driver.capabilities.multiProcess).toBe(false);
    const version = await driver.read(
      (tx) =>
        tx.prepare('PRAGMA user_version').get<{ readonly user_version: number }>()?.user_version,
    );
    expect(version).toBe(1);
  });

  it('disposes the opened driver when schema initialization fails', async () => {
    const dbPath = path.join(dir, 'incompatible.db');
    {
      await using seeded = openNativeDriver(dbPath);
      await seeded.immediate((tx) => {
        ensureSchema(tx);
        tx.exec('PRAGMA user_version = 4242');
      });
    }

    await expect(openRunbookDriver(dbPath, { runtime: 'native' })).rejects.toBeInstanceOf(
      IncompatibleSchemaError,
    );

    // A connection that outlives the failed open keeps its WAL sidecars alive;
    // SQLite removes them when the LAST connection closes. Their absence is the
    // observable proof that the half-open driver was disposed rather than leaked.
    const sidecars = (await fs.readdir(dir)).filter((name) => name.startsWith('incompatible.db-'));
    expect(sidecars).toEqual([]);
  });

  it('refuses to downgrade when the native driver cannot open', async () => {
    // node:sqlite cannot open a directory as a database file.
    const unopenable = path.join(dir, 'not-a-database');
    await fs.mkdir(unopenable);

    const err = await failureOf(() => openRunbookDriver(unopenable, { runtime: 'native' }));

    expect(err).toBeInstanceOf(NativeSqliteUnavailableError);
    expect((err as Error).name).toBe('NativeSqliteUnavailableError');
    const message = getErrorMessage(err);
    // The refusal names the failing subsystem, carries the underlying cause, and
    // states that no single-writer downgrade happens.
    expect(message).toMatch(/node:sqlite/);
    expect(message).toMatch(/unable to open database file/i);
    expect(message).toMatch(/does not downgrade/);
    expect(message).toMatch(/sql\.js/);
  });

  it('keeps the underlying open failure diagnosable behind the refusal', async () => {
    // Flattening every native open failure into one message discards what the
    // operator needs: a bad path, a permission denial and a corrupt file all
    // reach the same catch, and only the original error distinguishes them.
    const unopenable = path.join(dir, 'not-a-database');
    await fs.mkdir(unopenable);

    const err = await failureOf(() => openRunbookDriver(unopenable, { runtime: 'native' }));

    expect(err).toBeInstanceOf(NativeSqliteUnavailableError);
    const cause = (err as NativeSqliteUnavailableError).cause;
    expect(isNodeError(cause)).toBe(true);
    expect((cause as NodeJS.ErrnoException).code).toBe('ERR_SQLITE_ERROR');
    expect(getErrorMessage(cause)).toMatch(/unable to open database file/i);
    // The code is mirrored onto the refusal so a caller need not unwrap it.
    expect((err as NodeJS.ErrnoException).code).toBe('ERR_SQLITE_ERROR');
  });
});

describe('sql.js durability and crash boundaries', () => {
  const STAGES: readonly SqljsPersistStage[] = [
    'after-export',
    'after-temp-write',
    'after-temp-fsync',
    'after-rename',
    'after-dir-fsync',
  ];

  async function seed(dbPath: string): Promise<void> {
    await using driver = await openSqljsDriver(dbPath);
    await driver.immediate((tx) => {
      tx.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)');
      tx.prepare('INSERT INTO kv VALUES(:k,:v)').run({ k: 'seed', v: 1 });
    });
  }

  async function readSeed(dbPath: string): Promise<number | undefined> {
    await using driver = await openSqljsDriver(dbPath);
    return await driver.read(
      (tx) =>
        tx.prepare('SELECT v FROM kv WHERE k = :k').get<{ readonly v: number }>({ k: 'seed' })?.v,
    );
  }

  it.each(STAGES)('never adopts a partial image when crashing %s', async (stage) => {
    const dbPath = path.join(dir, `crash-${stage}.db`);
    await seed(dbPath);

    // A write that "crashes" at the given durability stage.
    {
      await using driver = await openSqljsDriver(dbPath, {
        faultHook: (s) => {
          if (s === stage) throw new Error(`crash at ${s}`);
        },
      });
      await expect(
        driver.immediate((tx) => {
          tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({
            v: 999,
            k: 'seed',
          });
        }),
      ).rejects.toThrow(`crash at ${stage}`);
    }

    // After the crash, the next open must observe a WHOLE database. A crash
    // before the rename keeps the seed; a crash at/after the rename may have the
    // new value — but never a torn database and never a value that was never
    // committed by any completed rename.
    const value = await readSeed(dbPath);
    expect(value === 1 || value === 999).toBe(true);
  });

  it('reclaims orphan temp files on the next locked open', async () => {
    const dbPath = path.join(dir, 'orphan.db');
    await seed(dbPath);
    {
      await using driver = await openSqljsDriver(dbPath, {
        faultHook: (s) => {
          if (s === 'after-temp-fsync') throw new Error('crash before rename');
        },
      });
      await expect(
        driver.immediate((tx) => {
          tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({
            v: 2,
            k: 'seed',
          });
        }),
      ).rejects.toThrow('crash before rename');
    }
    // The orphan temp exists now.
    const before = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(before.length).toBeGreaterThan(0);

    // The next successful write reclaims it under the lock.
    {
      await using driver = await openSqljsDriver(dbPath);
      await driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({
          v: 3,
          k: 'seed',
        });
      });
    }
    const after = (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(after).toEqual([]);
    expect(await readSeed(dbPath)).toBe(3);
  });

  it('never silently starts empty when the stored image cannot be read', async () => {
    // A path that exists but is not a readable file fails with EISDIR, not
    // ENOENT: only ENOENT means "first init", everything else is a real fault
    // and must surface rather than be replaced by an empty database.
    const dbPath = path.join(dir, 'unreadable.db');
    await fs.mkdir(dbPath);
    await using driver = await openSqljsDriver(dbPath);

    const err = await failureOf(() =>
      driver.read((tx) => {
        tx.prepare('SELECT 1').get();
      }),
    );
    expect(isNodeError(err)).toBe(true);
    expect((err as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it('reclaims only this database’s orphan temps', async () => {
    const dbPath = path.join(dir, 'scoped.db');
    await seed(dbPath);
    {
      await using driver = await openSqljsDriver(dbPath, {
        faultHook: (s) => {
          if (s === 'after-temp-fsync') throw new Error('crash before rename');
        },
      });
      await expect(
        driver.immediate((tx) => {
          tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({
            v: 5,
            k: 'seed',
          });
        }),
      ).rejects.toThrow('crash before rename');
    }

    // Another database's in-flight export, and a sidecar of this database that
    // merely shares its name prefix. Neither belongs to this driver's sweep.
    const foreignTemp = 'other.db.1111.tmp';
    const sidecar = 'scoped.db.notes';
    await fs.writeFile(path.join(dir, foreignTemp), 'keep');
    await fs.writeFile(path.join(dir, sidecar), 'keep');

    {
      await using driver = await openSqljsDriver(dbPath);
      await driver.read(() => undefined);
    }

    const remaining = await fs.readdir(dir);
    expect(remaining).toContain(foreignTemp);
    expect(remaining).toContain(sidecar);
    expect(remaining.filter((n) => n.startsWith('scoped.db.') && n.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces a reclaim failure instead of swallowing it', async () => {
    const dbPath = path.join(dir, 'stuck.db');
    await seed(dbPath);
    // A directory named like an orphan temp cannot be unlinked. Only a missing
    // file is an expected sweep outcome; any other filesystem fault is real.
    await fs.mkdir(path.join(dir, 'stuck.db.wedged.tmp'));
    await using driver = await openSqljsDriver(dbPath);

    const err = await failureOf(() => driver.read(() => undefined));

    expect(isNodeError(err)).toBe(true);
    expect((err as NodeJS.ErrnoException).code).not.toBe('ENOENT');
    expect((err as NodeJS.ErrnoException).syscall).toBe('unlink');
  });

  it('never lets a failed lock release mask the committed result', async () => {
    // RD-102: the file lock is best-effort on the way out. A failed unlink only
    // leaks a self-healing lock (the next acquirer reclaims it by PID), so it
    // must never replace the outcome of the work the lock protected. Revoking
    // write permission on the directory from inside the critical section is what
    // makes the release genuinely fail.
    const dbPath = path.join(dir, 'release-fails.db');
    await seed(dbPath);
    await using driver = await openSqljsDriver(dbPath);

    try {
      const value = await driver.read((tx) => {
        fsSync.chmodSync(dir, 0o500);
        return tx.prepare('SELECT v FROM kv WHERE k = :k').get<{ readonly v: number }>({
          k: 'seed',
        })?.v;
      });
      expect(value).toBe(1);
    } finally {
      fsSync.chmodSync(dir, 0o700);
    }

    // What the swallowed failure costs is a leaked lock file, nothing more. It
    // names a live PID (this process), so PID-aware reclaim frees it only once
    // this process exits — that is the accepted trade: leak a lock, never lose a
    // committed result.
    const lockFile = `${dbPath}.lock`;
    expect(fsSync.existsSync(lockFile)).toBe(true);

    fsSync.unlinkSync(lockFile);
    expect(await driver.read((tx) => tx.prepare('SELECT 1 AS one').get())).toEqual({ one: 1 });
  });

  it('makes the last durable rename win across sequential writes', async () => {
    const dbPath = path.join(dir, 'last-wins.db');
    await seed(dbPath);
    await using driver = await openSqljsDriver(dbPath);
    await driver.immediate((tx) => {
      tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 10, k: 'seed' });
    });
    await driver.immediate((tx) => {
      tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 20, k: 'seed' });
    });
    expect(await readSeed(dbPath)).toBe(20);
  });
});

/** Statements and lifecycle calls a driver made against its sql.js image. */
interface SqljsCallLog {
  readonly sql: string[];
  readonly freed: string[];
  closed: number;
}

/**
 * A minimal `sql.js` stand-in.
 *
 * WASM resource ownership — freeing every prepared statement and closing the
 * in-memory image on every exit path — and the rollback of a failed transaction
 * are invisible through a real sql.js database, because the whole image is
 * discarded either way. Leaking them leaks WASM heap for the process lifetime,
 * so they are pinned against a recording double instead.
 *
 * @param log - Recorder the returned module writes every call into.
 * @returns A `SqlJsStatic` whose `Database` records into `log`.
 */
function recordingSqlJs(log: SqljsCallLog): SqlJsStatic {
  class RecordingStatement {
    constructor(private readonly sql: string) {}
    reset(): boolean {
      return true;
    }
    bind(): boolean {
      return true;
    }
    run(): boolean {
      log.sql.push(this.sql);
      return true;
    }
    step(): boolean {
      return false;
    }
    getAsObject(): Record<string, unknown> {
      return {};
    }
    free(): boolean {
      log.freed.push(this.sql);
      return true;
    }
  }

  class RecordingSqljsDatabase {
    run(sql: string): this {
      log.sql.push(sql);
      return this;
    }
    prepare(sql: string): RecordingStatement {
      return new RecordingStatement(sql);
    }
    exec(): readonly {
      readonly columns: string[];
      readonly values: number[][];
    }[] {
      return [{ columns: ['id'], values: [[0]] }];
    }
    getRowsModified(): number {
      return 0;
    }
    export(): Uint8Array {
      return new Uint8Array([1]);
    }
    close(): void {
      log.closed += 1;
    }
  }

  return { Database: RecordingSqljsDatabase } as unknown as SqlJsStatic;
}

describe('sql.js resource ownership and rollback', () => {
  function newLog(): SqljsCallLog {
    return { sql: [], freed: [], closed: 0 };
  }

  it('rolls back, frees statements and closes the image when write work throws', async () => {
    const log = newLog();
    await using driver = new SqljsDriver(recordingSqlJs(log), path.join(dir, 'recorded-fail.db'));
    const boom = new Error('write boom');

    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO kv VALUES(1)').run();
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(log.sql).toEqual([
      'PRAGMA foreign_keys = ON',
      'BEGIN',
      'INSERT INTO kv VALUES(1)',
      'ROLLBACK',
    ]);
    expect(log.freed).toEqual(['INSERT INTO kv VALUES(1)']);
    expect(log.closed).toBe(1);
  });

  it('commits, frees statements and closes the image on a successful write', async () => {
    const log = newLog();
    await using driver = new SqljsDriver(recordingSqlJs(log), path.join(dir, 'recorded-ok.db'));

    await driver.immediate((tx) => {
      tx.prepare('INSERT INTO kv VALUES(2)').run();
    });

    expect(log.sql).toEqual([
      'PRAGMA foreign_keys = ON',
      'BEGIN',
      'INSERT INTO kv VALUES(2)',
      'COMMIT',
    ]);
    expect(log.freed).toEqual(['INSERT INTO kv VALUES(2)']);
    expect(log.closed).toBe(1);
  });

  it('frees statements and closes the image after a read', async () => {
    const log = newLog();
    await using driver = new SqljsDriver(recordingSqlJs(log), path.join(dir, 'recorded-read.db'));

    await driver.read((tx) => {
      tx.prepare('SELECT 1').all();
    });

    expect(log.freed).toEqual(['SELECT 1']);
    expect(log.closed).toBe(1);
  });
});
