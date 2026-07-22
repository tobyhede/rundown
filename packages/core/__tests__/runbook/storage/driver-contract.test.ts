import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';
import {
  NativeSqlDriver,
  openNativeDriver,
  isSqliteBusy,
} from '../../../src/runbook/storage/native-sqlite-driver.js';
import {
  openSqljsDriver,
  type SqljsDriverOptions,
  type SqljsPersistStage,
} from '../../../src/runbook/storage/sqljs-driver.js';
import { ensureSchema, IncompatibleSchemaError } from '../../../src/runbook/storage/schema.js';
import {
  isWebContainerRuntime,
  selectStorageRuntime,
  openRunbookDriver,
  STORAGE_RUNTIME_ENV,
} from '../../../src/runbook/storage/driver-factory.js';
import { RunbookStore } from '../../../src/runbook/storage/runbook-store.js';
import { RunbookStateManager } from '../../../src/runbook/state.js';
import { isError } from '../../../src/errors.js';
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

  it('exposes the exact execution ownership trigger-abort shape', async () => {
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

    let thrown: unknown;
    try {
      await driver.immediate((tx) => {
        tx.prepare('INSERT INTO guarded_claims VALUES (:runId)').run({ runId: 'rd_owned' });
      });
    } catch (error) {
      thrown = error;
    }

    expect(isError(thrown)).toBe(true);
    if (!isError(thrown)) throw new Error('expected an Error from the ownership trigger');
    expect(thrown.message).toBe('execution_in_progress');
    expect((thrown as Error & { readonly code?: string }).code).toBe(
      adapter.name === 'native' ? 'ERR_SQLITE_ERROR' : undefined,
    );
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

describe('native adapter SQLITE_BUSY handling', () => {
  it('classifies a busy error', () => {
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5,
    });
    expect(isSqliteBusy(busy)).toBe(true);
    expect(isSqliteBusy(new Error('unrelated'))).toBe(false);
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

  it('preserves a cross-realm Error thrown by read() work and still rolls back', async () => {
    await using driver = openNativeDriver(path.join(dir, 'read-normalize.db'));
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });

    // A cross-realm Error is not an `instanceof Error` of this realm but IS an
    // Error by `Error.isError` — the exact case `instanceof` narrowing drops.
    const crossRealm = vm.runInNewContext('new Error("cross-realm read failure")') as Error;
    expect(crossRealm instanceof Error).toBe(false);

    const rejection = await driver
      .read<void>(() => {
        throw crossRealm;
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isError(rejection)).toBe(true);
    // The original error object is surfaced as-is, not re-wrapped into a
    // this-realm Error that would flatten it to "Error: cross-realm read failure".
    expect(rejection).toBe(crossRealm);

    // A leaked (un-rolled-back) BEGIN would make the next transaction throw
    // "cannot start a transaction within a transaction"; its success proves the
    // rollback ran.
    await expect(
      driver.immediate((tx) => {
        tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'z', v: 9 });
      }),
    ).resolves.toBeUndefined();
  });

  it('normalizes a non-Error thrown by immediate() work and still rolls back', async () => {
    await using driver = openNativeDriver(path.join(dir, 'immediate-normalize.db'));
    await driver.immediate((tx) => {
      tx.exec(CREATE_KV);
    });

    const rejection = await driver
      .immediate<void>((tx) => {
        tx.prepare('INSERT INTO kv VALUES(:k, :v)').run({ k: 'a', v: 1 });
        // Deliberately a non-Error throw: the whole point is that the driver
        // normalizes it into an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'immediate string failure';
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isError(rejection)).toBe(true);
    expect((rejection as Error).message).toBe('immediate string failure');

    // The failed write must have rolled back, and the connection stays usable.
    const count = await driver.read(
      (tx) => tx.prepare('SELECT count(*) AS c FROM kv').get<{ readonly c: number }>()?.c,
    );
    expect(count).toBe(0);
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
  });

  it('selects sqljs only for WebContainer, native otherwise', () => {
    expect(selectStorageRuntime({ SHELL: '/bin/jsh' })).toBe('sqljs');
    expect(selectStorageRuntime({ SHELL: '/bin/bash' })).toBe('native');
    expect(selectStorageRuntime({})).toBe('native');
  });

  it('honors an explicit runtime override', () => {
    expect(
      selectStorageRuntime({
        [STORAGE_RUNTIME_ENV]: 'sqljs',
        SHELL: '/bin/bash',
      }),
    ).toBe('sqljs');
    expect(
      selectStorageRuntime({
        [STORAGE_RUNTIME_ENV]: 'native',
        SHELL: '/bin/jsh',
      }),
    ).toBe('native');
    expect(() => selectStorageRuntime({ [STORAGE_RUNTIME_ENV]: 'wat' })).toThrow();
  });

  it('opens a schema-ensured native driver from the factory', async () => {
    await using driver = await openRunbookDriver(path.join(dir, 'factory.db'), {
      runtime: 'native',
    });
    const version = await driver.read(
      (tx) =>
        tx.prepare('PRAGMA user_version').get<{ readonly user_version: number }>()?.user_version,
    );
    expect(version).toBe(1);
  });

  it('disposes the just-opened driver and rethrows when schema init fails', async () => {
    const dbFile = path.join(dir, 'schema-init-fail.db');
    // Seed an incompatible schema version so ensureSchema throws during the
    // factory's schema-init transaction, exercising the failure path.
    const seed = new DatabaseSync(dbFile);
    seed.exec('PRAGMA user_version = 4242');
    seed.close();

    const disposeSpy = jest.spyOn(NativeSqlDriver.prototype, Symbol.asyncDispose);
    try {
      await expect(openRunbookDriver(dbFile, { runtime: 'native' })).rejects.toBeInstanceOf(
        IncompatibleSchemaError,
      );
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
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
});
