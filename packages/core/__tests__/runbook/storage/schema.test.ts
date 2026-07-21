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

/**
 * Open an in-memory native driver. `:memory:` is per-connection, which is
 * exactly what these single-connection schema tests want.
 */
function memoryDriver(): NativeSqlDriver {
  return new NativeSqlDriver(new DatabaseSync(':memory:'));
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
  it('installs the current schema version with all six coordinated tables', async () => {
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
    await driver.immediate((tx) => {
      installSchema(tx);
      tx.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    });

    await expect(
      driver.immediate((tx) => {
        ensureSchema(tx);
      }),
    ).rejects.toBeInstanceOf(IncompatibleSchemaError);
  });

  it('carries the observed and expected versions on the refusal', async () => {
    await using driver = memoryDriver();
    await driver
      .immediate((tx) => {
        tx.exec('PRAGMA user_version = 999');
        ensureSchema(tx);
      })
      .then(
        () => {
          throw new Error('expected IncompatibleSchemaError');
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(IncompatibleSchemaError);
          const typed = err as IncompatibleSchemaError;
          expect(typed.foundVersion).toBe(999);
          expect(typed.expectedVersion).toBe(SCHEMA_VERSION);
        },
      );
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
