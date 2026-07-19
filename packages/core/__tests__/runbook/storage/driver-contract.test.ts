import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

const CREATE_KV = 'CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)';

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
