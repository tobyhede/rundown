import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import type { SqlJsStatic } from 'sql.js';
import { getErrorMessage, isError, isNodeError } from '../../../src/errors.js';
import { Errors } from '../../../src/errors/factory.js';
import {
  AsyncTransactionWorkError,
  UnrepresentableIntegerError,
  type SqlDriver,
} from '../../../src/runbook/storage/sql-driver.js';
import {
  NativeSqlDriver,
  openNativeDriver,
  isSqliteBusy,
  WalJournalModeUnavailableError,
} from '../../../src/runbook/storage/native-sqlite-driver.js';
import {
  SqljsDriver,
  openSqljsDriver,
  type SqljsDriverOptions,
  type SqljsPersistStage,
} from '../../../src/runbook/storage/sqljs-driver.js';
import {
  ensureSchema,
  IncompatibleSchemaError,
  SCHEMA_VERSION,
} from '../../../src/runbook/storage/schema.js';
import {
  isWebContainerRuntime,
  selectStorageRuntime,
  openRunbookDriver,
  NativeSqliteUnavailableError,
  SqljsUnsupportedHostError,
  STORAGE_RUNTIME_ENV,
} from '../../../src/runbook/storage/driver-factory.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { makeClaimRecord } from '../../../src/testing/claim-fixtures.js';
import { assertClaimGeneration } from '../../../src/runbook/storage/mutation-result.js';
import { assertClaimLookupKey } from '../../../src/runbook/claim-id.js';
import { makeBaseStep } from '../../helpers/step-factories.js';
import type { Runbook, Step } from '../../../src/runbook/types.js';

const CREATE_KV = 'CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = { title: 'Test', description: 'A test', steps: mockSteps };

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

  // RunbookStore.mutateSessionGuarded classifies a rolled-back ownership abort
  // by EXACT message equality against 'execution_in_progress' — the string the
  // claims_guard_* / stash_guard_* triggers raise. If either driver ever
  // decorated the raise text, that equality would silently degrade to a rethrow
  // and the typed refusal would surface as a crash, so the shape is pinned here
  // for both adapters rather than assumed.
  it('surfaces a RAISE(ABORT) message verbatim, with no adapter decoration', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      tx.exec(`
        CREATE TABLE owned_runs (id TEXT PRIMARY KEY, exec_token TEXT);
        CREATE TABLE guarded_claims (run_id TEXT NOT NULL);
        CREATE TRIGGER guarded_claims_insert
        BEFORE INSERT ON guarded_claims
        WHEN (SELECT exec_token FROM owned_runs WHERE id = NEW.run_id) IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'execution_in_progress');
        END;
      `);
      tx.prepare('INSERT INTO owned_runs VALUES (:id, :token)').run({
        id: 'rd_owned',
        token: 'sha256:live',
      });
    });

    const thrown = await failureOf(() =>
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO guarded_claims VALUES (:runId)').run({ runId: 'rd_owned' });
      }),
    );

    expect(isError(thrown)).toBe(true);
    if (!isError(thrown)) throw new Error('expected an Error from the ownership trigger');
    expect(thrown.message).toBe('execution_in_progress');
    expect(getErrorMessage(thrown)).toBe('execution_in_progress');
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

  it('cascades claim rows when their controlled run is deleted', async () => {
    await using driver = await adapter.open();
    const now = '2026-07-20T00:00:00.000Z';

    await driver.immediate((tx) => {
      ensureSchema(tx);
      tx.prepare(
        `INSERT INTO runs (id, state_version, claim_generation, lifecycle,
           state_json, created_at, updated_at)
         VALUES (:id, 1, 1, 'running', '{}', :now, :now)`,
      ).run({ id: 'rd_cascade', now });
      tx.prepare(
        `INSERT INTO claims (key, controlled_run, secret_hash, issued_generation,
           status, grants_json, issued_at, updated_at, last_seen_at)
         VALUES (:key, :run, 'hash', 1, 'active', '{}', :now, :now, :now)`,
      ).run({ key: 'rdclk_cascade', run: 'rd_cascade', now });
    });

    await driver.immediate((tx) => {
      tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: 'rd_cascade' });
    });

    const remaining = await driver.read((tx) =>
      tx.prepare('SELECT COUNT(*) AS n FROM claims').get<{ readonly n: number }>(),
    );
    expect(remaining?.n).toBe(0);
  });

  it('reports foreign_keys as enabled', async () => {
    await using driver = await adapter.open();
    const pragma = await driver.read((tx) =>
      tx.prepare('PRAGMA foreign_keys').get<{ readonly foreign_keys: number }>(),
    );
    expect(pragma?.foreign_keys).toBe(1);
  });

  it('cascades claim cleanup through the production RunbookStore.deleteRun path', async () => {
    await using driver = await adapter.open();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });
    const store = new RunbookStore(driver, dir);

    // Mint a schema-valid run state via a throwaway manager on a separate dir,
    // so its own storage cannot collide with the adapter driver under test.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-scratch-'));
    try {
      const manager = new RunbookStateManager(scratch);
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      await store.createRun(state);
      await store.transaction((txn) => {
        txn.insertClaim(
          makeClaimRecord({
            claimKey: assertClaimLookupKey(`rdclk_${'c'.repeat(32)}`),
            controlledRunId: state.id,
          }),
          assertClaimGeneration(0),
        );
      });

      await store.deleteRun(state.id);

      const remaining = await driver.read((tx) =>
        tx.prepare('SELECT COUNT(*) AS n FROM claims').get<{ readonly n: number }>(),
      );
      expect(remaining?.n).toBe(0);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true });
    }
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
/**
 * Pragma answers the connection double reports back.
 *
 * Both fields model a REAL `node:sqlite` answer shape rather than a convenience
 * scalar, because the driver's WAL guard reads both defensively: `.get()` may
 * legitimately return no row, and `PRAGMA database_list` returns one row PER
 * attached database, only one of which is `main`.
 */
interface PragmaFixture {
  /**
   * Row `PRAGMA journal_mode = WAL` answers with. An explicit `undefined`
   * models a pragma that returned no row at all; omitting the key entirely
   * defaults to a healthy `wal`.
   */
  readonly journalModeRow?: Record<string, unknown> | undefined;
  /** Rows `PRAGMA database_list` answers with. Omitted defaults to in-memory `main`. */
  readonly databaseList?: readonly Record<string, unknown>[];
  /**
   * Error the nth (0-based) `PRAGMA journal_mode = WAL` throws instead of
   * answering; `undefined` answers normally.
   *
   * The connection pragmas are the ONE place the driver contends before it owns
   * a transaction, and they all go through `prepare`. Without this seam the
   * entire class of connection-configuration contention — the WAL conversion's
   * busy retry, its budget, its backoff, and the short-circuit that must NOT
   * consume it — is unreachable at unit level, because `beginIsContended` only
   * reaches `exec('BEGIN IMMEDIATE')`.
   *
   * Returning an Error rather than a boolean is what lets a test distinguish
   * contention (`SQLITE_BUSY`, retried) from a permanent failure
   * (`SQLITE_READONLY`, rethrown at once) — the two arms of the same `if`.
   */
  readonly journalModeThrows?: (attempt: number) => Error | undefined;
}

/** The `database_list` an in-memory database reports: `main`, with no file behind it. */
const IN_MEMORY_MAIN: readonly Record<string, unknown>[] = [{ seq: 0, name: 'main', file: '' }];

/** The exact statement the driver issues to convert the connection to WAL. */
const WAL_PRAGMA = 'PRAGMA journal_mode = WAL';

/** A `database_list` row for `main` pointing at a real file. */
const fileBackedMain = (): Record<string, unknown> => ({
  seq: 0,
  name: 'main',
  file: path.join(dir, 'rundown.db'),
});

/**
 * Minimal `node:sqlite` stand-in that records every statement the driver issues,
 * can fail `BEGIN IMMEDIATE` on demand, and answers the connection pragmas.
 *
 * The retry budget and its backoff growth are only observable through the number
 * and spacing of the `BEGIN IMMEDIATE` attempts a contended write makes, and the
 * close-once-per-driver contract is only observable by counting `close()`.
 */
class RecordingDatabase {
  readonly executed: string[] = [];
  /**
   * Wall-clock stamp of each `PRAGMA journal_mode = WAL` issuance, in order.
   *
   * The conversion's retry BUDGET is observable as the length of this array and
   * its BACKOFF as the gaps between entries — neither is reachable through
   * `executed` alone, and neither is reachable at all without
   * {@link PragmaFixture.journalModeThrows}.
   */
  readonly walConversionAt: number[] = [];
  closeCount = 0;

  /**
   * @param beginIsContended - Whether the nth `BEGIN IMMEDIATE` should fail busy.
   * @param pragmas - Answers for the pragmas the constructor inspects.
   */
  constructor(
    private readonly beginIsContended: (attempt: number) => boolean,
    private readonly pragmas: PragmaFixture = {},
  ) {}

  /** Number of `BEGIN IMMEDIATE` statements issued so far. */
  get beginAttempts(): number {
    return this.executed.filter((sql) => sql === 'BEGIN IMMEDIATE').length;
  }

  /** Number of `PRAGMA journal_mode = WAL` statements issued so far. */
  get walConversionAttempts(): number {
    return this.walConversionAt.length;
  }

  exec(sql: string): void {
    this.executed.push(sql);
    if (sql === 'BEGIN IMMEDIATE' && this.beginIsContended(this.beginAttempts)) {
      throw sqliteError('database is locked', 5);
    }
  }

  prepare(sql: string): { get: () => unknown; all: () => unknown[] } {
    this.executed.push(sql);
    const pragmas = this.pragmas;
    if (sql !== WAL_PRAGMA) {
      return {
        get: () => undefined,
        all: () =>
          sql === 'PRAGMA database_list' ? [...(pragmas.databaseList ?? IN_MEMORY_MAIN)] : [],
      };
    }
    // Stamped at issue time, before the failure seam runs, so a refused attempt
    // still counts against the budget exactly as a real one does.
    const attempt = this.walConversionAt.length;
    this.walConversionAt.push(Date.now());
    return {
      get: () => {
        // node:sqlite compiles at `prepare` and RUNS the pragma at `get`, so a
        // contended conversion throws from HERE. The seam matches that shape
        // rather than throwing from `prepare`, so a driver that narrowed its
        // `try` around only the `get` would still be covered.
        const failure = pragmas.journalModeThrows?.(attempt);
        if (failure !== undefined) {
          throw failure;
        }
        // `in` rather than `??`: an explicit `undefined` is a distinct fixture
        // (the pragma returned no row) and must not fall back to the default.
        return 'journalModeRow' in pragmas ? pragmas.journalModeRow : { journal_mode: 'wal' };
      },
      all: () => [],
    };
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
  it('installs the busy timeout before WAL initialization can contend', async () => {
    const db = new RecordingDatabase(() => false);
    await using _driver = new NativeSqlDriver(recordingConnection(db), { busyTimeoutMs: 1234 });

    expect(db.executed.slice(0, 2)).toEqual([
      'PRAGMA busy_timeout = 1234',
      'PRAGMA journal_mode = WAL',
    ]);
  });

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

  // `PRAGMA journal_mode` RETURNS the effective mode: SQLite falls back to a
  // rollback journal (and keeps running) whenever WAL cannot be established —
  // a network filesystem, a host without shared-memory support. The driver
  // advertises `capabilities.multiProcess`, and only WAL earns that claim, so a
  // silent fallback must be a hard open failure rather than a `rundown.db-journal`
  // sidecar nobody notices. Not reproducible against real `node:sqlite` on a
  // normal host — a read-only connection and an in-transaction switch both throw
  // outright — so the connection double is what pins the inspection.
  describe('WAL refusal', () => {
    it.each([
      ['a rollback journal', 'delete'],
      ['an in-memory rollback journal', 'memory'],
    ])('refuses a file-backed connection that fell back to %s', (_label, mode) => {
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: mode },
        databaseList: [fileBackedMain()],
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).toThrow(
        `Database did not enter WAL journal mode (effective mode: ${mode}).`,
      );
      // Refused at construction: no transaction is ever opened over the connection.
      expect(db.executed).not.toContain('BEGIN IMMEDIATE');
    });

    it('names the effective mode, the consequence, and only reachable causes', () => {
      // The message is the operator's ONLY clue about which fallback happened and
      // what to do, so it is asserted whole rather than by keyword. It states the
      // observed mode and the guarantee that is no longer in force, and it lists
      // the causes WITHOUT asserting one, because naming a network filesystem as
      // THE cause would send an operator whose project is on a local disk looking
      // in the wrong place.
      //
      // Every cause it names must be one that can actually reach this class, and
      // the class is only reached when the pragma ANSWERED with a non-WAL mode.
      // Measured on Node 24.18.1 / SQLite 3.53.1: a read-only database file and a
      // read-only directory both THROW (errcode 8 `SQLITE_READONLY`, errcode 1544
      // `SQLITE_READONLY_DIRECTORY`) without returning a mode, so they surface as
      // `NativeSqliteUnavailableError` and never as this refusal. Listing them
      // here sent the operator to `chmod` for a fault that cannot produce this
      // message; the reachable causes replace them.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'delete' },
        databaseList: [fileBackedMain()],
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).toThrow(
        'Database did not enter WAL journal mode (effective mode: delete). ' +
          'WAL mode is required for supported multi-process operation. SQLite still ' +
          'serializes cross-process writers using file locks in rollback-journal mode, ' +
          "but rollback-journal mode does not provide WAL's reader/writer concurrency " +
          'and is not a validated Rundown deployment mode. SQLite returned the non-WAL ' +
          'mode it kept instead of failing. This narrows the cause to one of: a ' +
          'filesystem whose VFS provides ' +
          'no shared memory (a network mount such as NFS or SMB is the common one), a ' +
          'temporary database opened with no filename, or a connection that was already ' +
          'inside a write transaction. A read-only file or directory is NOT among them — ' +
          'that fails the pragma outright and surfaces as a different error. Establish ' +
          'which applies before moving the project directory.',
      );
    });

    it('refuses with a typed error carrying the effective mode', async () => {
      // A bare Error reaches the CLI's error mapper as RD-999 / "Unknown error" on
      // every command that opens the store, including read-only state commands.
      // The typed class is what lets a front end classify the refusal and render
      // a real code — the same shape IncompatibleSchemaError uses for
      // RD-305 — and the mode rides as DATA so no consumer re-parses the message.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'delete' },
        databaseList: [fileBackedMain()],
      });

      const err = await failureOf(() => new NativeSqlDriver(recordingConnection(db)));

      expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
      expect((err as Error).name).toBe('WalJournalModeUnavailableError');
      expect((err as WalJournalModeUnavailableError).effectiveMode).toBe('delete');
    });

    it('maps onto a registered error code rather than the unknown-error bucket', async () => {
      // The point of the typed class is that a front end turns it into a CODED
      // envelope; an unregistered refusal is indistinguishable from a crash to
      // every consumer. This pins the taxonomy seam from the storage side — the
      // mode the class carries is exactly what the factory accepts — so the CLI
      // arm (packages/cli/src/helpers/wrapper.ts, alongside the RD-305 one) has a
      // compile-checked contract to render and cannot silently drift back to
      // RD-999.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'delete' },
        databaseList: [fileBackedMain()],
      });

      const err = await failureOf(() => new NativeSqlDriver(recordingConnection(db)));
      const coded = Errors.walJournalModeUnavailable(
        (err as WalJournalModeUnavailableError).effectiveMode,
      );

      expect(coded.code).toBe('RD-306');
      // The observed mode, the unsupported concurrency model, and the candidate causes all
      // survive into the ENVELOPE message. The code's `description` carries them
      // too, but that reaches an operator only through `--text --verbose` and
      // never appears in the JSON default — so the message is where they count.
      expect(coded.message).toContain('effective mode: delete');
      expect(coded.message).toContain(
        'SQLite still serializes cross-process writers using file locks',
      );
      expect(coded.message).toContain(
        "rollback-journal mode does not provide WAL's reader/writer concurrency",
      );
      expect(coded.message).not.toContain('Cross-process write serialization is not in force');
      // The envelope's cause list must be the SAME list
      // `WalJournalModeUnavailableError` names, and every entry on it must be a
      // condition under which the pragma ANSWERS with a non-WAL mode — the only
      // way this code is reached. Both causes asserted here are measured, not
      // reasoned: on Node 24.18.1 / SQLite 3.53.1 `new DatabaseSync('')` and a
      // connection holding a dirty write transaction each return
      // `{journal_mode:'delete'}` (the two real-connection tests below drive
      // exactly those). A read-only file or directory does NOT, which is why the
      // message says so outright: both throw instead (errcode 8, errcode 1544) and
      // surface as RD-307, so naming them here sent an operator to `chmod` for a
      // fault that cannot produce this error.
      expect(coded.message).toContain('a temporary database opened with no filename');
      expect(coded.message).toContain('a connection already inside a write transaction');
      expect(coded.message).toContain(
        'A read-only database file or directory is NOT among them — that fails the pragma outright and surfaces as RD-307',
      );
      expect(coded.context.effectiveMode).toBe('delete');
    });

    it('carries no effective mode when the pragma answered nothing', async () => {
      // `unknown` in the message RENDERS an absent answer; it is not a mode SQLite
      // reported. The typed field keeps that distinction, so a consumer cannot
      // mistake "the pragma returned no row" for a journal mode named `unknown`.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: undefined,
        databaseList: IN_MEMORY_MAIN,
      });

      const err = await failureOf(() => new NativeSqlDriver(recordingConnection(db)));

      expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
      expect((err as WalJournalModeUnavailableError).effectiveMode).toBeUndefined();
      expect((err as Error).message).toContain('The pragma returned no readable journal mode');
      expect((err as Error).message).not.toContain('mode it kept');

      const coded = Errors.walJournalModeUnavailable(undefined);
      expect(coded.message).toContain('The pragma returned no readable journal mode');
      expect(coded.message).not.toContain('mode it kept');
    });

    it('refuses a non-memory fallback even on a connection with no file behind it', () => {
      // Only `memory` is excusable for a connection with no file — it is what
      // `:memory:` genuinely reports. A rollback journal is a fallback wherever
      // it appears, so the mode check may not be widened to "anything without a file".
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'delete' },
        databaseList: IN_MEMORY_MAIN,
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).toThrow('effective mode: delete');
    });

    it.each([
      ['returned no row', undefined],
      ['returned a row with no journal_mode column', {}],
    ])('refuses when the pragma %s', (_label, journalModeRow) => {
      // `.get()` is `unknown`-shaped: the optional chain and the `typeof` guard
      // are what keep an absent answer from reading as a mode (or throwing a
      // TypeError in place of the actionable refusal).
      const db = new RecordingDatabase(() => false, {
        journalModeRow,
        databaseList: IN_MEMORY_MAIN,
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).toThrow(
        'Database did not enter WAL journal mode (effective mode: unknown).',
      );
    });

    it('refuses when main is file-backed even though a sibling row is not', () => {
      // `database_list` returns a row per attached database. Only `main` decides:
      // scanning for ANY qualifying row would be wrong, and so would requiring
      // EVERY row to qualify — `temp` never has a file.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'memory' },
        databaseList: [fileBackedMain(), { seq: 1, name: 'temp', file: '' }],
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).toThrow('effective mode: memory');
    });

    it('accepts an in-memory main alongside an attached file-backed database', () => {
      // The mirror image: a `main` with no file stays acceptable however many
      // file-backed databases are attached beside it. Only `main` is consulted.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'memory' },
        databaseList: [
          { seq: 0, name: 'main', file: '' },
          { seq: 2, name: 'attached', file: path.join(dir, 'other.db') },
        ],
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).not.toThrow();
    });

    it('does not read a non-string database_list file as a path', () => {
      // `all()` is `unknown`-shaped and SQL NULL arrives as `null`, which is
      // `!== ''`. Without the `typeof` guard a NULL file column would read as a
      // filesystem path and refuse a connection that legitimately has no file.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'memory' },
        databaseList: [{ seq: 0, name: 'main', file: null }],
      });

      expect(() => new NativeSqlDriver(recordingConnection(db))).not.toThrow();
    });

    it('accepts the memory journal mode an in-memory database reports', async () => {
      // `:memory:` cannot use WAL and always reports `memory`. It is single
      // connection by construction, so it is not the hazard the check exists for,
      // and every in-memory test fixture depends on it opening. Real connection,
      // not the double: this is the behaviour the double is modelled on.
      await using driver = new NativeSqlDriver(new DatabaseSync(':memory:'));
      const journalMode = await driver.read(
        (tx) =>
          tx.prepare('PRAGMA journal_mode').get<{ readonly journal_mode: string }>()?.journal_mode,
      );
      expect(journalMode).toBe('memory');
    });

    it('closes the connection it opened when the refusal fires', () => {
      // `openNativeDriver` owns the connection until the driver takes it, so a
      // refused configuration must not leak the handle — the same rule
      // `openRunbookDriver` applies with `disposeQuietly` on a refused schema.
      // Patching the prototype is what makes the refusal fire on THIS path
      // deterministically. The two conditions that refuse a real connection (see
      // the two tests below) are reached by handing the driver a connection or by
      // opening a temporary database — neither is an `openNativeDriver(<path>)`
      // call, which is where the leak this test guards is observable.
      // The refusal short-circuits before `isFileBacked` runs, so the journal-mode
      // pragma is the ONLY statement prepared on this path — no delegation to the
      // real `prepare` is needed, and the asserted message proves it stayed that way.
      const prepareSpy = jest
        .spyOn(DatabaseSync.prototype, 'prepare')
        .mockReturnValue({ get: () => ({ journal_mode: 'delete' }) } as unknown as ReturnType<
          DatabaseSync['prepare']
        >);
      const closeSpy = jest.spyOn(DatabaseSync.prototype, 'close');

      try {
        expect(() => openNativeDriver(path.join(dir, 'refused.db'))).toThrow(
          'effective mode: delete',
        );
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        prepareSpy.mockRestore();
        closeSpy.mockRestore();
      }
    });

    it('refuses a real temporary on-disk database, which cannot enter WAL', async () => {
      // The one condition on an ordinary host that drives a REAL connection down
      // the refusal path, with no double and no prototype patch. `DatabaseSync('')`
      // opens a TEMPORARY on-disk database: `main` carries no filename, and SQLite
      // will not convert a temp file to WAL, so the pragma ANSWERS `delete` rather
      // than failing. Measured on Node 24.18.1 / SQLite 3.53.1.
      //
      // It matters beyond the coverage: every other refusal fixture injects a
      // synthetic `journalModeRow`, which leaves open whether the class can fire
      // at all. This says it can, and it is also what makes the "only `memory` is
      // excusable for a file-less connection" rule above a real rule rather than a
      // hypothetical — a temp database is exactly a file-less connection that
      // reports something other than `memory`.
      const err = await failureOf(() => openNativeDriver(''));

      expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
      expect((err as WalJournalModeUnavailableError).effectiveMode).toBe('delete');
    });

    it('refuses a real FILE-BACKED connection that could not leave its rollback journal', async () => {
      // The file-backed twin of the case above, on a real database file. SQLite
      // will not change the journal mode while the connection holds a DIRTY write
      // transaction: `sqlite3PagerOkToChangeJournalMode` returns false, so
      // `OP_JournalMode` leaves the mode alone and the pragma ANSWERS with the one
      // already in force instead of failing. Measured on Node 24.18.1 / SQLite
      // 3.53.1 — and note a CLEAN `BEGIN` throws instead ("cannot change into wal
      // mode from within a transaction"); the pending write is what makes it
      // answer, which is why this fixture inserts before constructing.
      //
      // Reachable because `NativeSqlDriver` takes an already-open connection, so a
      // consumer decides what state it is in. That makes the refusal — not a
      // silently kept rollback journal — the right outcome here.
      const dbPath = path.join(dir, 'dirty-txn.db');
      const seed = new DatabaseSync(dbPath);
      seed.exec('PRAGMA journal_mode = DELETE');
      seed.exec('CREATE TABLE t (x)');
      seed.close();

      const connection = new DatabaseSync(dbPath);
      try {
        connection.exec('BEGIN');
        connection.exec('INSERT INTO t VALUES (1)');

        const err = await failureOf(() => new NativeSqlDriver(connection));

        expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
        expect((err as WalJournalModeUnavailableError).effectiveMode).toBe('delete');
      } finally {
        connection.exec('ROLLBACK');
        connection.close();
      }
    });
  });

  // The conversion contends, and `PRAGMA busy_timeout` does not cover it: the
  // pragma rewrites the database header under a write transaction, and SQLite
  // refuses the SHARED -> RESERVED step WITHOUT consulting the busy handler
  // (`sqlite3PagerSetBusyHandler`, pager.c). Two `rundown run` invocations racing
  // to create a fresh database therefore leave the loser holding SQLITE_BUSY
  // after 0.24 ms, which is why the constructor retries at all.
  //
  // None of this is reachable through `beginIsContended`, which only fails
  // `exec('BEGIN IMMEDIATE')`; `journalModeThrows` is the seam that reaches it.
  describe('WAL conversion contention', () => {
    /** The `SQLITE_BUSY` a contended WAL conversion raises. */
    const busy = (): Error => sqliteError('database is locked', 5);

    it('retries a contended conversion and completes once it wins', async () => {
      const db = new RecordingDatabase(() => false, {
        journalModeThrows: (attempt) => (attempt < 3 ? busy() : undefined),
      });

      const driver = new NativeSqlDriver(recordingConnection(db), {
        busyTimeoutMs: 0,
        maxBusyRetries: 5,
        busyRetryBaseMs: 1,
      });

      // Three refusals plus the attempt that won.
      expect(db.walConversionAttempts).toBe(4);
      // Configuration ran to completion: the pragma the constructor issues AFTER
      // the conversion is what proves the loop exited by SUCCEEDING rather than by
      // falling out of its budget.
      expect(db.executed.at(-1)).toBe('PRAGMA foreign_keys = ON');
      await driver[Symbol.asyncDispose]();
    });

    it('surfaces SQLITE_BUSY after exactly maxBusyRetries retries', async () => {
      const db = new RecordingDatabase(() => false, {
        journalModeThrows: () => busy(),
      });

      const err = await failureOf(
        () =>
          new NativeSqlDriver(recordingConnection(db), {
            busyTimeoutMs: 0,
            maxBusyRetries: 2,
            busyRetryBaseMs: 1,
          }),
      );

      expect(isSqliteBusy(err)).toBe(true);
      // One initial attempt plus exactly maxBusyRetries retries. The budget is a
      // bound, not a suggestion: this loop blocks the event loop while it runs,
      // and each attempt can additionally burn a whole `busy_timeout` inside
      // SQLite, so an unbounded (or off-by-one) loop is measured in seconds.
      expect(db.walConversionAttempts).toBe(3);
      // Refused during configuration: foreign keys were never turned on, and no
      // transaction was ever opened over the connection.
      expect(db.executed).not.toContain('PRAGMA foreign_keys = ON');
      expect(db.executed).not.toContain('BEGIN IMMEDIATE');
    });

    it('backs off further before each successive retry', async () => {
      const db = new RecordingDatabase(() => false, {
        journalModeThrows: (attempt) => (attempt < 3 ? busy() : undefined),
      });

      const driver = new NativeSqlDriver(recordingConnection(db), {
        busyTimeoutMs: 0,
        maxBusyRetries: 3,
        busyRetryBaseMs: 50,
      });

      expect(db.walConversionAttempts).toBe(4);
      const gaps = db.walConversionAt.slice(1).map((at, index) => at - db.walConversionAt[index]);
      // `busyRetryBaseMs * (attempt + 1)`: 50ms, then 100ms, then 150ms. Lower
      // bounds only — a loaded machine can oversleep `Atomics.wait` but never wake
      // early from it, so there is no flake here. A CONSTANT backoff, a zeroed
      // one, or `attempt` in place of `attempt + 1` all fail the second bound.
      expect(gaps[0]).toBeGreaterThanOrEqual(50);
      expect(gaps[1]).toBeGreaterThanOrEqual(100);
      expect(gaps[2]).toBeGreaterThanOrEqual(150);
      await driver[Symbol.asyncDispose]();
    });

    it('pays the whole backoff inside the synchronous constructor', async () => {
      // `sleepSync`/`Atomics.wait` is deliberate: the constructor is synchronous,
      // so there is no turn to await on. The elapsed time is measured across the
      // `new` expression with nothing awaited in between, which is what says the
      // waiting happened THERE — a caller gets a fully configured connection or an
      // exception, never a half-configured one it could interleave work with. The
      // 1ms timer that still has not run says the same thing from the other side.
      let timerFired = false;
      const timer = setTimeout(() => {
        timerFired = true;
      }, 1);
      const db = new RecordingDatabase(() => false, {
        journalModeThrows: (attempt) => (attempt < 2 ? busy() : undefined),
      });

      const startedAt = Date.now();
      const driver = new NativeSqlDriver(recordingConnection(db), {
        busyTimeoutMs: 0,
        maxBusyRetries: 5,
        busyRetryBaseMs: 60,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(db.walConversionAttempts).toBe(3);
      // 60ms then 120ms, both spent before the constructor returned.
      expect(elapsedMs).toBeGreaterThanOrEqual(180);
      expect(timerFired).toBe(false);
      clearTimeout(timer);
      await driver[Symbol.asyncDispose]();
    });

    it('does not retry a conversion failure that is not contention', async () => {
      // `isSqliteBusy` is the gate on the retry, and widening it would turn one
      // permanent failure into eleven of them with the event loop blocked between.
      // SQLITE_READONLY is the shape that matters: measured on Node 24.18.1 /
      // SQLite 3.53.1, a read-only database file throws errcode 8 here rather than
      // answering with a fallback mode.
      const permanent = sqliteError('attempt to write a readonly database', 8);
      const db = new RecordingDatabase(() => false, {
        journalModeThrows: () => permanent,
      });

      const err = await failureOf(
        () =>
          new NativeSqlDriver(recordingConnection(db), {
            busyTimeoutMs: 0,
            maxBusyRetries: 10,
            busyRetryBaseMs: 1,
          }),
      );

      // Rethrown unwrapped, on the first attempt: the underlying SQLite error is
      // the diagnosable one, and the budget is untouched.
      expect(err).toBe(permanent);
      expect(db.walConversionAttempts).toBe(1);
    });

    it('spends no retry budget on a genuine journal-mode fallback', async () => {
      // The refusal `throw` sits OUTSIDE the catch, reached only once `.get()` has
      // ANSWERED — so a rollback journal is decided on the first ask and never
      // re-asked. Counting issuances is the only thing that pins it: turning that
      // throw into a `continue` would re-issue the pragma up to the budget, and
      // every other WAL-refusal test in this file would still pass.
      const db = new RecordingDatabase(() => false, {
        journalModeRow: { journal_mode: 'delete' },
        databaseList: [fileBackedMain()],
      });

      const err = await failureOf(
        () =>
          new NativeSqlDriver(recordingConnection(db), {
            busyTimeoutMs: 0,
            maxBusyRetries: 10,
            busyRetryBaseMs: 1,
          }),
      );

      expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
      expect(db.walConversionAttempts).toBe(1);
    });

    it('exhausts the budget against a real writer holding the database', async () => {
      // The double proves the loop's SHAPE; this proves the loop fires against
      // real SQLite. A second connection holds RESERVED, which is precisely the
      // cold-start race — and precisely the transition SQLite refuses without
      // consulting the busy handler, so `busy_timeout` is no defence and each
      // attempt fails in well under a millisecond.
      //
      // The database must start on a rollback journal: `PRAGMA journal_mode = WAL`
      // against a database ALREADY in WAL is a no-op that takes no write lock and
      // would make this test vacuous.
      const dbPath = path.join(dir, 'wal-conversion-contended.db');
      const holder = new DatabaseSync(dbPath);
      holder.exec('PRAGMA journal_mode = DELETE');
      holder.exec('CREATE TABLE t (x)');
      holder.exec('BEGIN IMMEDIATE');
      holder.exec('INSERT INTO t VALUES (1)');

      const prepareSpy = jest.spyOn(DatabaseSync.prototype, 'prepare');
      try {
        const err = await failureOf(() =>
          openNativeDriver(dbPath, {
            busyTimeoutMs: 0,
            maxBusyRetries: 2,
            busyRetryBaseMs: 5,
          }),
        );

        expect(isSqliteBusy(err)).toBe(true);
        expect(getErrorMessage(err)).toMatch(/database is locked/i);
        // Counted through the real connection, not a fixture: one initial attempt
        // plus exactly maxBusyRetries retries actually reached SQLite.
        const issued = prepareSpy.mock.calls.filter(([sql]) => sql === WAL_PRAGMA).length;
        expect(issued).toBe(3);
      } finally {
        prepareSpy.mockRestore();
        holder.exec('ROLLBACK');
        holder.close();
      }
    });
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

  it('classifies extended busy codes by their primary code', () => {
    expect(isSqliteBusy(sqliteError('busy snapshot', 5 | (2 << 8)))).toBe(true);
    expect(isSqliteBusy(sqliteError('locked shared cache', 6 | (1 << 8)))).toBe(true);
  });

  it.each([
    ['a fractional code', 5.5],
    ['a negative code', -251],
    ['a signed-overflow code', 0x8000_0005],
    ['an oversized code', 0x1_0000_0006],
    ['a bigint code', 5n],
    ['a string code', '5'],
  ])('rejects %s', (_label, errcode) => {
    const err = Object.assign(new Error('malformed SQLite code'), {
      code: 'ERR_SQLITE_ERROR',
      errcode,
    });
    expect(isSqliteBusy(err)).toBe(false);
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
    // Asserted against the constant, not a literal: this pair has already been
    // flipped 1<->2 once by the replayed commits, and a literal makes every
    // future DDL bump a two-file change that silently rots if missed.
    expect(version).toBe(SCHEMA_VERSION);
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
    // Asserted against the constant, not a literal: this pair has already been
    // flipped 1<->2 once by the replayed commits, and a literal makes every
    // future DDL bump a two-file change that silently rots if missed.
    expect(version).toBe(SCHEMA_VERSION);
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

  it('surfaces the WAL refusal itself rather than the native-unavailable wrapper', async () => {
    // node:sqlite is present and the connection opened: only the journal mode is
    // wrong. Wrapping this one in NativeSqliteUnavailableError would assert a
    // diagnosis that is false ("node:sqlite is unavailable on this host") AND
    // bury the typed class a front end classifies on one `cause` deep, dropping
    // the refusal back to RD-999. Patching the prototype is what lets a REAL
    // connection take the refusal path — no host reports a rollback journal for
    // a genuine file-backed database (see the WAL refusal suite).
    const prepareSpy = jest
      .spyOn(DatabaseSync.prototype, 'prepare')
      .mockReturnValue({ get: () => ({ journal_mode: 'delete' }) } as unknown as ReturnType<
        DatabaseSync['prepare']
      >);

    try {
      const err = await failureOf(() =>
        openRunbookDriver(path.join(dir, 'wal-refused.db'), { runtime: 'native' }),
      );

      expect(err).toBeInstanceOf(WalJournalModeUnavailableError);
      expect(err).not.toBeInstanceOf(NativeSqliteUnavailableError);
      expect((err as WalJournalModeUnavailableError).effectiveMode).toBe('delete');
      // The wrapper's framing must not survive on the message either.
      expect(getErrorMessage(err)).not.toMatch(/node:sqlite/);
    } finally {
      prepareSpy.mockRestore();
    }
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
    // The name must carry the full minted shape (`.export-<uuid>.tmp`), since
    // that — not a bare prefix/suffix pair — is what reclamation now matches.
    await fs.mkdir(path.join(dir, `stuck.db.export-${crypto.randomUUID()}.tmp`));
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

  it('leaves a concurrent writer’s lock staging file intact while reclaiming its own orphan', async () => {
    // file-lock.ts stages its atomic populated-create as
    // `<lockFile>.<pid>.<uuid>.tmp` and then link()s it into place. The driver's
    // adapter lock is `<dbPath>.lock`, so that staging file lands in this very
    // directory as `<dbname>.lock.<pid>.<uuid>.tmp` — which an orphan sweep
    // keyed on `<dbname>.` + `.tmp` matches. Unlinking it makes the owning
    // writer's fs.link() throw an unhandled ENOENT and kill the process.
    const dbPath = path.join(dir, 'neighbour.db');
    await seed(dbPath);

    const lockStaging = `${dbPath}.lock.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(lockStaging, '{"pid":1,"created_at":"now"}', 'utf8');
    // A genuine crash remnant from this driver, to prove the narrowed filter
    // still reclaims what it owns rather than being disabled outright.
    const ownOrphan = path.join(dir, `neighbour.db.export-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(ownOrphan, 'partial image', 'utf8');

    {
      await using driver = await openSqljsDriver(dbPath);
      await driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 7, k: 'seed' });
      });
    }

    await expect(fs.readFile(lockStaging, 'utf8')).resolves.toBe('{"pid":1,"created_at":"now"}');
    await expect(fs.access(ownOrphan)).rejects.toThrow();
    expect(await readSeed(dbPath)).toBe(7);
  });

  it('reclaims only a full UUID-shaped export body, not any .export-*.tmp neighbour', async () => {
    // The prefix/suffix pair is not the safety boundary — the minted SHAPE is.
    // A neighbour is free to stage `<dbname>.export-<anything>.tmp`, so matching
    // on `.export-` plus `.tmp` alone would resume deleting foreign in-flight
    // files, which is the very bug the infix was introduced to close. Each name
    // below shares the prefix and suffix and differs only in the body, so the
    // UUID pattern is the sole thing that can distinguish them.
    const dbPath = path.join(dir, 'shape.db');
    await seed(dbPath);

    const foreign = [
      'shape.db.export-.tmp', // empty body
      'shape.db.export-not-a-uuid.tmp', // wrong alphabet and length
      'shape.db.export-0189bd0f-6d3f-7c1a-9b2e-4f8a1c7d2e5.tmp', // final group one short
      'shape.db.export-0189BD0F-6D3F-7C1A-9B2E-4F8A1C7D2E5B.tmp', // uppercase hex
      `shape.db.export-x${crypto.randomUUID()}.tmp`, // UUID with a leading extra char
      // Correct prefix AND a real UUID body, but not a `.tmp`. Both halves of
      // the prefix/suffix guard must hold: if the suffix check degrades to
      // "prefix or suffix" the trailing four characters are trimmed anyway, this
      // name's body reads as a clean UUID, and a neighbour's file is deleted.
      `shape.db.export-${crypto.randomUUID()}.txt`,
    ];
    for (const name of foreign) {
      await fs.writeFile(path.join(dir, name), 'keep', 'utf8');
    }
    // A genuine remnant, so the assertion cannot pass by disabling reclamation.
    const ownOrphan = path.join(dir, `shape.db.export-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(ownOrphan, 'partial image', 'utf8');

    {
      await using driver = await openSqljsDriver(dbPath);
      await driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 11, k: 'seed' });
      });
    }

    const remaining = await fs.readdir(dir);
    for (const name of foreign) {
      expect(remaining).toContain(name);
    }
    await expect(fs.access(ownOrphan)).rejects.toThrow();
    expect(await readSeed(dbPath)).toBe(11);
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

  it('does not let lock cleanup failure mask an already durable write', async () => {
    const dbPath = path.join(dir, 'release-failure.db');
    await seed(dbPath);
    let releaseAttempted = false;
    const options: SqljsDriverOptions = {
      releaseLock: async () => {
        releaseAttempted = true;
        throw new Error('unlink denied');
      },
    };
    await using driver = await openSqljsDriver(dbPath, options);

    await expect(
      driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 30, k: 'seed' });
        return 'committed-result';
      }),
    ).resolves.toBe('committed-result');
    expect(releaseAttempted).toBe(true);
  });

  it('propagates a real directory fsync failure after rename', async () => {
    const dbPath = path.join(dir, 'dir-fsync-eio.db');
    await seed(dbPath);
    const originalOpen = fs.open;
    const syncFailure = Object.assign(new Error('storage I/O failure'), { code: 'EIO' });
    const options: SqljsDriverOptions = {
      directoryOpen: async () =>
        Object.assign(await originalOpen(dir, 'r'), {
          sync: async () => Promise.reject(syncFailure),
        }),
    };

    await using driver = await openSqljsDriver(dbPath, options);
    await expect(
      driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 40, k: 'seed' });
      }),
    ).rejects.toBe(syncFailure);
  });

  it('treats an unsupported directory fsync as non-fatal', async () => {
    const dbPath = path.join(dir, 'dir-fsync-enosys.db');
    await seed(dbPath);
    const originalOpen = fs.open;
    const unsupported = Object.assign(new Error('fsync unavailable'), { code: 'ENOSYS' });
    let directoryOpened = false;
    const options: SqljsDriverOptions = {
      directoryOpen: async () => {
        directoryOpened = true;
        return Object.assign(await originalOpen(dir, 'r'), {
          sync: async () => Promise.reject(unsupported),
        });
      },
    };

    await using driver = await openSqljsDriver(dbPath, options);
    await expect(
      driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 50, k: 'seed' });
      }),
    ).resolves.toBeUndefined();
    expect(directoryOpened).toBe(true);
  });

  it('does not let a directory-handle close failure mask a committed write', async () => {
    const dbPath = path.join(dir, 'dir-close-fails.db');
    await seed(dbPath);
    const originalOpen = fs.open;
    let closeAttempted = false;
    const options: SqljsDriverOptions = {
      directoryOpen: async () => {
        const handle = await originalOpen(dir, 'r');
        // Bound before the override replaces it, so the descriptor is still
        // really released — the test needs a rejecting close, not a leaked fd.
        const realClose = handle.close.bind(handle);
        return Object.assign(handle, {
          close: async () => {
            closeAttempted = true;
            await realClose();
            throw new Error('close denied');
          },
        });
      },
    };

    await using driver = await openSqljsDriver(dbPath, options);
    // Rename and directory fsync both succeeded, so the write is durable. A
    // close rejection is cleanup noise and must never surface as a failed persist.
    await expect(
      driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 60, k: 'seed' });
        return 'committed-result';
      }),
    ).resolves.toBe('committed-result');
    expect(closeAttempted).toBe(true);
    expect(await readSeed(dbPath)).toBe(60);
  });

  it('does not let a directory-handle close failure mask a real fsync error', async () => {
    const dbPath = path.join(dir, 'dir-close-and-fsync-fail.db');
    await seed(dbPath);
    const originalOpen = fs.open;
    const syncFailure = Object.assign(new Error('storage I/O failure'), { code: 'EIO' });
    const options: SqljsDriverOptions = {
      directoryOpen: async () => {
        const handle = await originalOpen(dir, 'r');
        const realClose = handle.close.bind(handle);
        return Object.assign(handle, {
          sync: async () => Promise.reject(syncFailure),
          close: async () => {
            await realClose();
            throw new Error('close denied');
          },
        });
      },
    };

    await using driver = await openSqljsDriver(dbPath, options);
    // The fsync error is the one that matters; the close rejection must not
    // replace it on the way out of the `finally`.
    await expect(
      driver.immediate((tx) => {
        tx.prepare('UPDATE kv SET v = :v WHERE k = :k').run({ v: 70, k: 'seed' });
      }),
    ).rejects.toBe(syncFailure);
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
