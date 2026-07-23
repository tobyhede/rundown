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
  state_json: '{}',
  exec_pid: null,
  exec_token: null,
  exec_epoch: null,
  exec_start_id: null,
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
    `INSERT INTO runs (id, lifecycle, state_json, exec_pid, exec_token, exec_epoch,
       exec_start_id, created_at, updated_at)
     VALUES (:id, :lifecycle, :state_json, :exec_pid, :exec_token, :exec_epoch,
       :exec_start_id, :created_at, :updated_at)`,
  ).run(row);
}

const CLAIM_DEFAULTS = {
  key: 'ck_test',
  controlled_run: RUN_DEFAULTS.id,
  secret_hash: 'hash',
  issued_generation: 0,
  status: 'active',
  grants_json: '{}',
  issued_at: 'now',
  updated_at: 'now',
  last_seen_at: 'now',
} as const satisfies SqlParams;

/**
 * Insert a `claims` row, overriding only the columns a constraint test varies.
 *
 * @param tx - Open writing transaction.
 * @param overrides - Column values replacing {@link CLAIM_DEFAULTS}.
 */
function insertClaim(tx: SqlTransaction, overrides: SqlParams = {}): void {
  const row = { ...CLAIM_DEFAULTS, ...overrides };
  tx.prepare(
    `INSERT INTO claims (key, controlled_run, secret_hash, issued_generation, status,
       grants_json, issued_at, updated_at, last_seen_at)
     VALUES (:key, :controlled_run, :secret_hash, :issued_generation, :status,
       :grants_json, :issued_at, :updated_at, :last_seen_at)`,
  ).run(row);
}

const ATTEMPT_DEFAULTS = {
  run_id: RUN_DEFAULTS.id,
  exec_epoch: 1,
  exec_token: 'hashed',
  phase: 'claimed',
  owner_pid: 4242,
  owner_start_id: null,
  started_at: 'now',
} as const satisfies SqlParams;

/**
 * Insert an `execution_attempts` row, overriding only the columns a constraint
 * test varies.
 *
 * @param tx - Open writing transaction.
 * @param overrides - Column values replacing {@link ATTEMPT_DEFAULTS}.
 */
function insertAttempt(tx: SqlTransaction, overrides: SqlParams = {}): void {
  const row = { ...ATTEMPT_DEFAULTS, ...overrides };
  tx.prepare(
    `INSERT INTO execution_attempts (run_id, exec_epoch, exec_token, phase, owner_pid,
       owner_start_id, started_at)
     VALUES (:run_id, :exec_epoch, :exec_token, :phase, :owner_pid,
       :owner_start_id, :started_at)`,
  ).run(row);
}

const EXPECTED_TABLES = [
  'runs',
  'claims',
  'session_stack',
  'stash_slot',
  'resolved_completions',
  'execution_attempts',
] as const;

describe('storage schema', () => {
  it('installs schema version 1 with all six coordinated tables', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });

    const tables = await driver.read((tx) =>
      tx
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all<{ readonly name: string }>()
        .map((row) => row.name),
    );

    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
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
    // database exactly as it found it. A refusal that had already rewritten the
    // version or re-run the DDL would be a migration by another name.
    const [version, tables] = await driver.read((tx) => [
      readSchemaVersion(tx),
      tx
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all<{ readonly name: string }>()
        .map((row) => row.name),
    ]);
    expect(version).toBe(future);
    expect(tables).toEqual([...EXPECTED_TABLES].sort());
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

  it('accepts every lifecycle value the machine persists', async () => {
    await using driver = await schemaDriver();
    for (const lifecycle of ['running', 'completed', 'stopped']) {
      await expect(
        driver.immediate((tx) => {
          insertRun(tx, { id: `rd_${lifecycle}`, lifecycle });
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects a claim status outside the closed union', async () => {
    await using driver = await schemaDriver();
    await driver.immediate((tx) => {
      insertRun(tx);
    });
    await expect(
      driver.immediate((tx) => {
        insertClaim(tx, { status: 'revoked' });
      }),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      driver.immediate((tx) => {
        insertClaim(tx, { key: 'ck_active', status: 'active' });
        insertClaim(tx, { key: 'ck_superseded', status: 'superseded' });
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an execution phase outside the closed union', async () => {
    await using driver = await schemaDriver();
    await driver.immediate((tx) => {
      insertRun(tx);
    });
    await expect(
      driver.immediate((tx) => {
        insertAttempt(tx, { phase: 'started' });
      }),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it('accepts every execution phase the attempt lifecycle uses', async () => {
    await using driver = await schemaDriver();
    await driver.immediate((tx) => {
      insertRun(tx);
    });
    const phases = ['claimed', 'effect_started', 'recovery_pending', 'committed'];
    await expect(
      driver.immediate((tx) => {
        phases.forEach((phase, i) => {
          insertAttempt(tx, { exec_epoch: i + 1, phase });
        });
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a partially populated execution identity on runs', async () => {
    await using driver = await schemaDriver();
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, { exec_pid: 4242 });
      }),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it('rejects an execution identity that names no attempt row', async () => {
    await using driver = await schemaDriver();
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, {
          exec_pid: 4242,
          exec_token: 'hashed',
          exec_epoch: 7,
          exec_start_id: 'start-7',
        });
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('accepts an execution identity referencing its active attempt', async () => {
    await using driver = await schemaDriver();
    await expect(
      driver.immediate((tx) => {
        insertRun(tx, {
          exec_pid: 4242,
          exec_token: 'hashed',
          exec_epoch: 7,
          // A host without a process start id still owns the run: start id is
          // optional on the attempt row, so it must stay optional here too.
          exec_start_id: null,
        });
        insertAttempt(tx, { exec_epoch: 7 });
      }),
    ).resolves.toBeUndefined();
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

  it('records the #519 last_seen_at claim-activity column', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });
    const columns = await driver.read((tx) =>
      tx
        .prepare('PRAGMA table_info(claims)')
        .all<{ readonly name: string }>()
        .map((row) => row.name),
    );
    expect(columns).toContain('last_seen_at');
    expect(columns).toContain('issued_generation');
  });

  it('keeps execution phase only on execution_attempts, not on runs', async () => {
    await using driver = memoryDriver();
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });
    const [runCols, attemptCols] = await driver.read((tx) => [
      tx
        .prepare('PRAGMA table_info(runs)')
        .all<{ readonly name: string }>()
        .map((r) => r.name),
      tx
        .prepare('PRAGMA table_info(execution_attempts)')
        .all<{ readonly name: string }>()
        .map((r) => r.name),
    ]);
    expect(runCols).not.toContain('phase');
    expect(attemptCols).toContain('phase');
    expect(attemptCols).toContain('exec_token');
  });
});
