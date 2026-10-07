/**
 * Test fixtures for seeding and inspecting persisted run state.
 *
 * Every seeding helper here drives the REAL core API (`RunbookStateManager`)
 * the way production does: mint an Owner Token, persist the run with the
 * token's hash, hand the plaintext back to the test exactly as `rundown run`
 * hands it to the orchestrator on `runbook_started`.
 *
 * The inspection/mutation helpers (`readPersistedRunState`,
 * `patchPersistedRunState`, `deletePersistedRunState`, `writeRawRunJson`,
 * `listPersistedRunIds`) deliberately bypass validation on write, because a
 * large share of the suites that use them assert how the CLI *rejects* invalid
 * persisted state.
 *
 * @module testing/run-fixtures
 */

import { parseRunbookDocument, type Runbook } from '@rundown-org/parser';
import { RunbookStateManager } from '../runbook/state.js';
import { assertRunId, type RunId } from '../runbook/run-id.js';
import {
  generateOwnerToken,
  hashRunSecret,
  type OwnerToken,
  type SecretHash,
} from '../runbook/run-secrets.js';
import type { RunbookRef } from '../runbook/runbook-ref.js';
import type { RunbookState } from '../runbook/types.js';
import type { VariableValue } from '../runbook/effective-vars.js';
import { getRunbookStore } from '../runbook/storage/store-registry.js';
import { seedRawRunState } from './state-fixtures.js';
import { CURRENT_SCHEMA_VERSION } from '../runbook/persisted-state-guards.js';

export { seedRawRunState };

/**
 * A schema version no build writes, so a row carrying it is refused by the
 * version gate rather than parsed.
 *
 * Derived rather than hard-coded, which is the whole of #775: a literal
 * "foreign" version that {@link CURRENT_SCHEMA_VERSION} later catches up to
 * plants VALID state, and every assertion about the refusal it was meant to
 * provoke silently stops testing anything while still passing.
 *
 * Exported so every fixture that plants state the build must refuse shares one
 * definition across packages. A per-file copy is the same duplication that let
 * the literal `1` go stale in forty places at once.
 */
export const FOREIGN_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION + 1;

/**
 * Markdown used when a caller does not supply its own runbook source.
 *
 * Two steps, so a seeded run can be advanced once without completing.
 */
const DEFAULT_RUNBOOK_MARKDOWN = `# Seeded Runbook

## 1. First step

First step body.

## 2. Second step

Second step body.
`;

/**
 * Options accepted by {@link seedRun}.
 */
export interface SeedRunOptions {
  /**
   * Runbook markdown to parse into the run's step graph.
   *
   * Defaults to a two-step runbook. Supply real markdown when the assertions
   * depend on step names, handlers, or substeps.
   */
  readonly markdown?: string;
  /**
   * Canonical runbook reference persisted on the state.
   *
   * Defaults to `{ source: 'project', path: 'seeded.runbook.md' }`.
   */
  readonly runbookRef?: RunbookRef;
  /**
   * Filesystem path recorded as `state.runbookPath`.
   *
   * Defaults to the `path` of {@link SeedRunOptions.runbookRef}.
   */
  readonly runbookPath?: string;
  /** Explicit run id; defaults to a freshly generated one. */
  readonly runId?: RunId;
  /** Runtime variables seeded into `state.variables`. */
  readonly variables?: Readonly<Record<string, VariableValue>>;
  /** Marks the run as agent-prompted, matching `rundown run --prompted`. */
  readonly prompted?: boolean;
  /**
   * Owner Token to persist (hashed) instead of a freshly minted one.
   *
   * For the rare test that must plant a known token; everything else lets the
   * fixture mint one and reads it back from {@link SeededRun.ownerToken}.
   */
  readonly ownerToken?: OwnerToken;
}

/**
 * A run persisted by {@link seedRun}.
 */
export interface SeededRun {
  /** The persisted state as the manager wrote it. */
  readonly state: RunbookState;
  /** Convenience alias for `state.id`. */
  readonly runId: RunId;
  /**
   * The run's Owner Token in plaintext — what `rundown run` prints once and a
   * test passes as `--token`.
   */
  readonly ownerToken: OwnerToken;
  /** The hash of {@link SeededRun.ownerToken}, exactly as stored on the row. */
  readonly ownerTokenHash: SecretHash;
}

/**
 * Resolve the parsed runbook and identity fields shared by the seeders.
 *
 * @param options - Caller-supplied seeding options.
 * @returns The parsed runbook plus its reference and on-disk path.
 * @throws {Error} When the supplied markdown parses to zero steps, which would
 *   otherwise produce a state whose `step` cursor points at nothing.
 */
function resolveRunbook(options: SeedRunOptions): {
  runbook: Runbook;
  runbookRef: RunbookRef;
  runbookPath: string;
} {
  const runbookRef: RunbookRef = options.runbookRef ?? {
    source: 'project',
    path: 'seeded.runbook.md',
  };
  const parsed = parseRunbookDocument(options.markdown ?? DEFAULT_RUNBOOK_MARKDOWN);
  if (parsed.runbook.steps.length === 0) {
    throw new Error('seedRun: runbook markdown parsed to zero steps');
  }
  return {
    runbook: parsed.runbook,
    runbookRef,
    runbookPath: options.runbookPath ?? runbookRef.path,
  };
}

/**
 * Persist a run owned by a fresh Owner Token.
 *
 * The one seeding shape under one writer per run: there is no stack to push
 * onto and no claim to mint. The plaintext token is returned so the test can
 * drive the run exactly as the orchestrator would.
 *
 * @param cwd - Project root whose store receives the run.
 * @param options - Run identity and content.
 * @returns The persisted run with its Owner Token.
 */
export async function seedRun(cwd: string, options: SeedRunOptions = {}): Promise<SeededRun> {
  const manager = new RunbookStateManager(cwd);
  const { runbook, runbookRef, runbookPath } = resolveRunbook(options);
  const ownerToken = options.ownerToken ?? generateOwnerToken();
  const ownerTokenHash = hashRunSecret(ownerToken);
  const state = await manager.create(runbookRef, runbook, {
    runbookPath,
    ownerTokenHash,
    runId: options.runId,
    prompted: options.prompted,
    initialVariables: options.variables,
  });
  return { state, runId: state.id, ownerToken, ownerTokenHash };
}

/**
 * Read a run's persisted state as raw, UNVALIDATED JSON.
 *
 * Returns the stored object without routing it through schema validation, so a
 * test can round-trip state the manager would refuse to load.
 *
 * @param cwd - Project root whose store holds the run.
 * @param runId - Run to read.
 * @returns The stored object, or `null` when no such run row exists.
 */
export async function readPersistedRunState(
  cwd: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const store = await getRunbookStore(cwd);
  return store.readRunJson(assertRunId(runId));
}

/**
 * Read a run's persisted state, apply a shallow patch, and write it back raw.
 *
 * The write is unvalidated on purpose: the most common use is planting state
 * the CLI must reject (`{ schemaVersion: FOREIGN_SCHEMA_VERSION }`, a terminal
 * `lifecycle`, and so on). Derive such a version from the constant rather than
 * writing a literal: a literal that the constant later catches up to plants
 * VALID state under a name that says otherwise, and nothing fails.
 *
 * @param cwd - Project root whose store holds the run.
 * @param runId - Run to patch.
 * @param patch - Fields merged over the stored object, or a function returning
 *   the complete replacement object.
 * @returns The object as written.
 * @throws {Error} When the run does not exist, so a typo cannot silently no-op.
 */
export async function patchPersistedRunState(
  cwd: string,
  runId: string,
  patch: Record<string, unknown> | ((current: Record<string, unknown>) => Record<string, unknown>),
): Promise<Record<string, unknown>> {
  const current = await readPersistedRunState(cwd, runId);
  if (current === null) {
    throw new Error(`patchPersistedRunState: no persisted run ${runId}`);
  }
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  await seedRawRunState(cwd, next);
  return next;
}

/**
 * Overwrite a run's stored state JSON with an arbitrary string.
 *
 * For the handful of suites that write literal garbage (`'{invalid'`) to assert
 * the CLI's parse-failure envelope. Bypasses both JSON and schema validation.
 * A run that does not exist yet is inserted with a freshly minted owner token
 * hash, since the column is required.
 *
 * @param cwd - Project root whose store holds the run.
 * @param runId - Run whose `state_json` column is replaced.
 * @param json - Raw text to store, valid JSON or not.
 * @returns Resolves once the row is committed.
 */
export async function writeRawRunJson(cwd: string, runId: string, json: string): Promise<void> {
  const store = await getRunbookStore(cwd);
  const id = assertRunId(runId);
  const now = new Date().toISOString();
  const ownerTokenHash = hashRunSecret(generateOwnerToken());
  await store.transaction((txn) => {
    txn.tx
      .prepare(
        `INSERT INTO runs (id, lifecycle, owner_token_hash, state_version, state_json, created_at, updated_at)
           VALUES (:id, 'running', :ownerTokenHash, 0, :json, :now, :now)
         ON CONFLICT(id) DO UPDATE SET state_json = :json, updated_at = :now`,
      )
      .run({ id, ownerTokenHash, json, now });
  });
}

/**
 * Delete a run row.
 *
 * @param cwd - Project root whose store holds the run.
 * @param runId - Run to delete.
 * @returns Resolves once the row is gone.
 */
export async function deletePersistedRunState(cwd: string, runId: string): Promise<void> {
  const store = await getRunbookStore(cwd);
  await store.deleteRun(assertRunId(runId));
}

/**
 * List every persisted run id, including rows whose state fails validation.
 *
 * Unlike `RunbookStateManager.list`, it does NOT drop invalid rows — suites
 * asserting that `prune` reaches unparseable state depend on seeing them.
 *
 * @param cwd - Project root whose store is enumerated.
 * @returns Run ids in store order.
 */
export async function listPersistedRunIds(cwd: string): Promise<readonly RunId[]> {
  const store = await getRunbookStore(cwd);
  return store.listRunIds();
}
