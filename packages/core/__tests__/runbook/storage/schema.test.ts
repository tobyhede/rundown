import { describe, it, expect } from '@jest/globals';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  IncompatibleSchemaError,
  ensureSchema,
  installSchema,
  readSchemaVersion,
} from '../../../src/runbook/storage/schema.js';
import { NativeSqlDriver } from '../../../src/runbook/storage/native-sqlite-driver.js';
import type {
  SqlParams,
  SqlReadTransaction,
  SqlTransaction,
} from '../../../src/runbook/storage/sql-driver.js';

/**
 * Open an in-memory native driver. `:memory:` is per-connection, which is
 * exactly what these single-connection schema tests want.
 */
function memoryDriver(): NativeSqlDriver {
  return new NativeSqlDriver(new DatabaseSync(':memory:'));
}

/** Open an in-memory driver with the current schema already installed. */
async function schemaDriver(): Promise<NativeSqlDriver> {
  const driver = memoryDriver();
  await driver.immediate((tx) => {
    ensureSchema(tx);
  });
  return driver;
}

const RUN_DEFAULTS = {
  id: 'rd_test',
  lifecycle: 'running',
  owner_token_hash: 'a'.repeat(64),
  parent_run_id: null,
  parent_step: null,
  parent_frame_key: null,
  parent_entry: null,
  parent_kind: null,
  lease_attempt: null,
  lease_pid: null,
  lease_start_id: null,
  lease_started_at: null,
  state_json: '{}',
  created_at: 'now',
  updated_at: 'now',
} as const satisfies SqlParams;

/**
 * Insert a `runs` row, overriding only the columns a constraint test varies.
 *
 * @param tx - Open writing transaction.
 * @param overrides - Column values replacing {@link RUN_DEFAULTS}.
 */
function insertRun(tx: SqlTransaction, overrides: SqlParams = {}): void {
  const row = { ...RUN_DEFAULTS, ...overrides };
  tx.prepare(
    `INSERT INTO runs (id, lifecycle, owner_token_hash,
       parent_run_id, parent_step, parent_frame_key, parent_entry, parent_kind,
       lease_attempt, lease_pid, lease_start_id, lease_started_at,
       state_json, created_at, updated_at)
     VALUES (:id, :lifecycle, :owner_token_hash,
       :parent_run_id, :parent_step, :parent_frame_key, :parent_entry, :parent_kind,
       :lease_attempt, :lease_pid, :lease_start_id, :lease_started_at,
       :state_json, :created_at, :updated_at)`,
  ).run(row);
}

/** A complete child linkage pointing at {@link RUN_DEFAULTS}. */
const CHILD_LINK = {
  id: 'rd_child',
  owner_token_hash: 'b'.repeat(64),
  parent_run_id: RUN_DEFAULTS.id,
  parent_step: '2',
  parent_frame_key: '2|',
  parent_entry: 1,
  parent_kind: 'delegation',
} as const satisfies SqlParams;

/** Read the columns of a table in declaration order. */
function columnsOf(driver: NativeSqlDriver, table: string): Promise<readonly string[]> {
  return driver.read((tx) =>
    tx
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ readonly name: string }>()
      .map((row) => row.name),
  );
}

describe('storage schema', () => {
  it('installs the current schema version with the single runs table', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });

    const tables = await driver.read((tx) =>
      tx
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all<{ readonly name: string }>()
        .map((row) => row.name),
    );

    // One table and nothing else for authority (ADR 0005): no claims, no
    // session stack, no stash slot, no completion mailbox, no attempts ledger.
    expect(tables).toEqual(['runs']);
  });

  it('carries the owner token hash, child linkage, lease and version columns', async () => {
    await using driver = await schemaDriver();
    expect(await columnsOf(driver, 'runs')).toEqual([
      'id',
      'lifecycle',
      'owner_token_hash',
      'parent_run_id',
      'parent_step',
      'parent_frame_key',
      'parent_entry',
      'parent_kind',
      'lease_attempt',
      'lease_pid',
      'lease_start_id',
      'lease_started_at',
      'state_version',
      'state_json',
      'created_at',
      'updated_at',
    ]);
  });

  it('stamps user_version to SCHEMA_VERSION on install', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      expect(readSchemaVersion(tx)).toBe(0);
      installSchema(tx);
      expect(readSchemaVersion(tx)).toBe(SCHEMA_VERSION);
    });
  });

  it('is idempotent when the database is already at the current version', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });
    // A second ensure must not throw and must not attempt reinstall (which would
    // fail with "table runs already exists").
    await expect(
      driver.immediate((tx) => {
        ensureSchema(tx);
      }),
    ).resolves.toBeUndefined();
  });

  it.each([1, 2])(
    'rejects a version-%i multi-writer database without migrating it',
    async (foundVersion) => {
      await using driver = memoryDriver();
      // The older schemas are not reproduced here; what matters is that the
      // version gate refuses before any DDL runs, leaving the file untouched.
      await driver.immediate((tx) => {
        tx.exec('CREATE TABLE claims (key TEXT PRIMARY KEY NOT NULL)');
        tx.exec(`PRAGMA user_version = ${String(foundVersion)}`);
      });

      let refusal: unknown;
      try {
        await driver.immediate((tx) => {
          ensureSchema(tx);
        });
      } catch (err) {
        refusal = err;
      }

      expect(refusal).toBeInstanceOf(IncompatibleSchemaError);
      expect(refusal).toMatchObject({ foundVersion, expectedVersion: SCHEMA_VERSION });

      const [version, tables] = await driver.read((tx) => [
        readSchemaVersion(tx),
        tx
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all<{ readonly name: string }>()
          .map((row) => row.name),
      ]);
      expect(version).toBe(foundVersion);
      expect(tables).toEqual(['claims']);
    },
  );

  it('rejects an incompatible future schema version, never migrating', async () => {
    await using driver = memoryDriver();
    const future = SCHEMA_VERSION + 1;
    await driver.immediate((tx) => {
      installSchema(tx);
      tx.exec(`PRAGMA user_version = ${String(future)}`);
    });

    await expect(
      driver.immediate((tx) => {
        ensureSchema(tx);
      }),
    ).rejects.toBeInstanceOf(IncompatibleSchemaError);

    // Refusing is only half the contract: the rejected open must leave the
    // database exactly as it found it.
    const [version, tables] = await driver.read((tx) => [
      readSchemaVersion(tx),
      tx
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all<{ readonly name: string }>()
        .map((row) => row.name),
    ]);
    expect(version).toBe(future);
    expect(tables).toEqual(['runs']);
  });

  it('carries the observed and expected versions on the refusal', async () => {
    await using driver = memoryDriver();

    // expect.assertions is what makes the catch mandatory: without it, a build
    // that stopped refusing would skip the block and pass silently.
    expect.assertions(3);
    try {
      await driver.immediate((tx) => {
        tx.exec('PRAGMA user_version = 999');
        ensureSchema(tx);
      });
    } catch (err) {
      expect(err).toBeInstanceOf(IncompatibleSchemaError);
      expect((err as IncompatibleSchemaError).foundVersion).toBe(999);
      expect((err as IncompatibleSchemaError).expectedVersion).toBe(SCHEMA_VERSION);
    }
  });

  it('rejects a lifecycle value outside the closed union', async () => {
    await using driver = await schemaDriver();
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, { lifecycle: 'recoveryRequired' });
      }),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it('accepts every lifecycle value the machine persists, abandoned included', async () => {
    await using driver = await schemaDriver();
    const lifecycles = ['running', 'completed', 'stopped', 'abandoned'];
    for (const [i, lifecycle] of lifecycles.entries()) {
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, {
            id: `rd_${lifecycle}`,
            lifecycle,
            owner_token_hash: String(i).repeat(64),
          });
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('requires an owner token hash on every row', async () => {
    await using driver = await schemaDriver();
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, { owner_token_hash: null });
      }),
    ).rejects.toThrow(/NOT NULL constraint/i);
  });

  it('refuses two rows carrying the same owner token hash', async () => {
    await using driver = await schemaDriver();
    await driver.immediate((tx) => {
      insertRun(tx);
    });
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, { id: 'rd_other' });
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: runs\.owner_token_hash/);
  });

  describe('child linkage group', () => {
    it('accepts a complete linkage naming an existing parent', async () => {
      await using driver = await schemaDriver();
      await expect(
        driver.immediate((tx) => {
          insertRun(tx);
          insertRun(tx, CHILD_LINK);
        }),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['parent_run_id', { ...CHILD_LINK, parent_run_id: null }],
      ['parent_step', { ...CHILD_LINK, parent_step: null }],
      ['parent_frame_key', { ...CHILD_LINK, parent_frame_key: null }],
      ['parent_entry', { ...CHILD_LINK, parent_entry: null }],
      ['parent_kind', { ...CHILD_LINK, parent_kind: null }],
    ])('rejects a linkage missing %s (all-or-none)', async (_column, row) => {
      await using driver = await schemaDriver();
      await driver.immediate((tx) => {
        insertRun(tx);
      });
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, row);
        }),
      ).rejects.toThrow(/CHECK constraint/i);
    });

    it('rejects a parent kind outside the closed union', async () => {
      await using driver = await schemaDriver();
      await driver.immediate((tx) => {
        insertRun(tx);
      });
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, { ...CHILD_LINK, parent_kind: 'nested' });
        }),
      ).rejects.toThrow(/CHECK constraint/i);
    });

    it('rejects a linkage naming a parent that does not exist', async () => {
      await using driver = await schemaDriver();
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, CHILD_LINK);
        }),
      ).rejects.toThrow(/FOREIGN KEY/i);
    });

    it('clears the whole linkage group when the parent row is deleted', async () => {
      // The plan's `ON DELETE SET NULL` cannot coexist with the all-or-none
      // CHECK: nulling `parent_run_id` alone fails the constraint and the parent
      // could never be pruned. The trigger clears the group as one write.
      await using driver = await schemaDriver();
      await driver.immediate((tx) => {
        insertRun(tx);
        insertRun(tx, CHILD_LINK);
      });
      await expect(
        driver.immediate((tx) => {
          tx.prepare('DELETE FROM runs WHERE id = :id').run({ id: RUN_DEFAULTS.id });
        }),
      ).resolves.toBeUndefined();
      const child = await driver.read((tx) =>
        tx
          .prepare(
            'SELECT parent_run_id, parent_step, parent_frame_key, parent_entry, parent_kind FROM runs WHERE id = :id',
          )
          .get<Record<string, unknown>>({ id: CHILD_LINK.id }),
      );
      expect(child).toEqual({
        parent_run_id: null,
        parent_step: null,
        parent_frame_key: null,
        parent_entry: null,
        parent_kind: null,
      });
    });
  });

  describe('execution lease group', () => {
    const LEASE = {
      lease_attempt: 1,
      lease_pid: 4242,
      lease_start_id: 'start-1',
      lease_started_at: 'now',
    } as const satisfies SqlParams;

    it('accepts a complete lease, with or without a start id', async () => {
      await using driver = await schemaDriver();
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, LEASE);
          insertRun(tx, {
            ...LEASE,
            id: 'rd_no_start_id',
            owner_token_hash: 'c'.repeat(64),
            lease_start_id: null,
          });
        }),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['lease_attempt', { ...LEASE, lease_attempt: null }],
      ['lease_pid', { ...LEASE, lease_pid: null }],
      ['lease_started_at', { ...LEASE, lease_started_at: null }],
    ])('rejects a lease missing %s (all-or-none)', async (_column, row) => {
      await using driver = await schemaDriver();
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, row);
        }),
      ).rejects.toThrow(/CHECK constraint/i);
    });

    it('rejects a start id with no lease around it', async () => {
      await using driver = await schemaDriver();
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, { lease_start_id: 'orphan' });
        }),
      ).rejects.toThrow(/CHECK constraint/i);
    });
  });

  describe('state_version trigger', () => {
    it('bumps state_version on every state_json or lease write and on nothing else', async () => {
      await using driver = await schemaDriver();
      await driver.immediate((tx) => {
        insertRun(tx);
      });
      const version = (): Promise<number | undefined> =>
        driver.read(
          (tx) =>
            tx
              .prepare('SELECT state_version FROM runs WHERE id = :id')
              .get<{ readonly state_version: number }>({ id: RUN_DEFAULTS.id })?.state_version,
        );
      expect(await version()).toBe(0);
      await driver.immediate((tx) => {
        tx.prepare("UPDATE runs SET lifecycle = 'completed' WHERE id = :id").run({
          id: RUN_DEFAULTS.id,
        });
      });
      expect(await version()).toBe(0);
      // Setting the execution lease moves the version (#902): a reader from
      // before the lease cannot write after it.
      await driver.immediate((tx) => {
        tx.prepare(
          "UPDATE runs SET lease_attempt = 1, lease_pid = 1, lease_started_at = 'now' WHERE id = :id",
        ).run({
          id: RUN_DEFAULTS.id,
        });
      });
      expect(await version()).toBe(1);
      await driver.immediate((tx) => {
        tx.prepare('UPDATE runs SET state_json = \'{"a":1}\' WHERE id = :id').run({
          id: RUN_DEFAULTS.id,
        });
        tx.prepare('UPDATE runs SET state_json = \'{"a":2}\' WHERE id = :id').run({
          id: RUN_DEFAULTS.id,
        });
      });
      expect(await version()).toBe(3);
      // One statement writing both columns is one bump.
      await driver.immediate((tx) => {
        tx.prepare(
          'UPDATE runs SET state_json = \'{"a":3}\', lease_attempt = NULL, lease_pid = NULL, lease_started_at = NULL WHERE id = :id',
        ).run({ id: RUN_DEFAULTS.id });
      });
      expect(await version()).toBe(4);
    });
  });

  it('reads a missing user_version row as an uninitialized database', () => {
    // PRAGMA user_version always returns a row against a real connection, so the
    // fallback is only reachable through a transaction that yields none. It is
    // load-bearing: reporting `undefined` as a version would make ensureSchema
    // take the reject-never-migrate path against a database that is merely new.
    const emptyTx: SqlReadTransaction = {
      prepare: () => ({
        get: () => undefined,
        all: () => [],
      }),
    };
    expect(readSchemaVersion(emptyTx)).toBe(0);
  });
});
