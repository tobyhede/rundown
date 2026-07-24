/**
 * Test fixtures for seeding persisted run state directly into a project's store.
 *
 * Replaces the pre-SQLite pattern of hand-writing `.rundown/runs/<id>.json`.
 * Tests that need a *valid* run should use `RunbookStateManager.create`; this
 * module exists for the cases that legitimately need to plant state the manager
 * would refuse to write — invalid schema versions, legacy snapshot shapes, or
 * hand-built states asserted against `load`'s rejection contract.
 *
 * The state is inserted as raw `state_json` without validation, which is the
 * whole point: the assertions under test are about how `load` reacts to it.
 *
 * @module testing/state-fixtures
 */

import { getRunbookStore } from '../runbook/storage/store-registry.js';

/**
 * Insert (or replace) a run row carrying arbitrary, unvalidated state JSON.
 *
 * Mirrors how the store reassembles a run on read: `lifecycle` is taken from its
 * own column and resolved completions from their own table, so both are written
 * from the supplied object rather than left inside `state_json`.
 *
 * @param cwd - Project root whose store should receive the run.
 * @param raw - The full state object to persist, including its `id`.
 * @returns Resolves once the row is committed.
 */
export async function seedRawRunState(cwd: string, raw: Record<string, unknown>): Promise<void> {
  const store = await getRunbookStore(cwd);
  const id = String(raw.id);
  const now = typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString();
  const startedAt = typeof raw.startedAt === 'string' ? raw.startedAt : now;
  const lifecycle = typeof raw.lifecycle === 'string' ? raw.lifecycle : 'running';
  const completions =
    typeof raw.resolvedCompletions === 'object' &&
    raw.resolvedCompletions !== null &&
    !Array.isArray(raw.resolvedCompletions)
      ? (raw.resolvedCompletions as Record<string, unknown>)
      : {};

  await store.transaction((txn) => {
    txn.tx
      .prepare(
        `INSERT INTO runs (id, state_version, claim_generation, lifecycle, state_json, created_at, updated_at)
           VALUES (:id, 0, 0, :lifecycle, :json, :startedAt, :now)
         ON CONFLICT(id) DO UPDATE SET state_json = :json, lifecycle = :lifecycle, updated_at = :now`,
      )
      .run({ id, lifecycle, json: JSON.stringify(raw), startedAt, now });
    txn.tx.prepare('DELETE FROM resolved_completions WHERE run_id = :id').run({ id });
    const insert = txn.tx.prepare(
      `INSERT INTO resolved_completions (run_id, completion_key, payload_json, created_at)
         VALUES (:id, :key, :payload, :createdAt)`,
    );
    for (const [key, payload] of Object.entries(completions)) {
      const createdAt =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { completedAt?: unknown }).completedAt === 'string'
          ? (payload as { completedAt: string }).completedAt
          : now;
      insert.run({ id, key, payload: JSON.stringify(payload), createdAt });
    }
  });
}
