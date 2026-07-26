/**
 * Test fixtures for seeding persisted run state directly into a project's store.
 *
 * Replaces the pre-SQLite pattern of hand-writing `.rundown/runs/<id>.json`.
 * Two seeders, and the choice matters:
 *
 * - {@link seedRunState} takes a typed {@link RunbookState} and validates it
 *   before writing. Use it for any fixture that stands in for a *real* run.
 * - {@link seedRawRunState} takes `Record<string, unknown>` and writes it
 *   unvalidated. Use it only when the assertion is about how `load` reacts to
 *   state the manager would refuse to write — invalid schema versions, legacy
 *   snapshot shapes, deliberate corruption.
 *
 * Reaching for the raw seeder by default is the trap: nothing type-checks the
 * payload and nothing validates it on write, so a missing or misnamed field is
 * only caught when the state is read back, surfacing as whatever the reader does
 * with unreadable state (a refusal, a non-zero exit) rather than as an error
 * naming the field. Prefer `RunbookStateManager.create`, `seedRun`, or
 * `seedRunState`; see `testing/delegation-fixtures` for the parent-side
 * delegation shapes a delegating parent must carry.
 *
 * @module testing/state-fixtures
 */

import { makeRunbookStateSchema } from '../schemas.js';
import type { RunbookState } from '../runbook/types.js';
import { getRunbookStore } from '../runbook/storage/store-registry.js';

/**
 * Insert (or replace) a run row from a typed, validated run state.
 *
 * The default seeder for a fixture representing a real run. `state` is typed, so
 * a missing or misnamed field fails to compile, and it is parsed against the
 * persisted-state schema before the write, so a cast that evades the type still
 * fails here — naming the offending field — instead of at read time.
 *
 * @param cwd - Project root whose store should receive the run.
 * @param state - The run state to persist.
 * @returns Resolves once the row is committed.
 * @throws {Error} When `state` does not satisfy the persisted-state schema.
 */
export async function seedRunState(cwd: string, state: RunbookState): Promise<void> {
  const parsed = makeRunbookStateSchema(cwd).safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `seedRunState received state that is not persistable: ${parsed.error.message}. ` +
        'Fix the fixture, or use seedRawRunState if the test is specifically about invalid state.',
    );
  }
  await seedRawRunState(cwd, state as unknown as Record<string, unknown>);
}

/**
 * Insert (or replace) a run row carrying arbitrary, unvalidated state JSON.
 *
 * Deliberately unvalidated — see the module remarks. If the fixture is meant to
 * be a valid run, use {@link seedRunState} instead.
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
