/**
 * Test fixtures for seeding and inspecting session-scoped run state.
 *
 * Before `.rundown/rundown.db`, tests seeded state by writing
 * `.rundown/runs/<id>.json` and `.rundown/session.json` by hand. The store
 * ignores those files, and the database enforces invariants the JSON layout
 * could not — notably `claims.controlled_run` FOREIGN KEY -> `runs(id)`, which
 * makes a claim for a non-existent run unrepresentable.
 *
 * Every seeding helper here therefore drives the REAL core APIs
 * (`RunbookStateManager`, `SessionService`) in the same order production uses:
 * persist the run, push it onto the default stack, then mint claims. Fixtures
 * that skipped that ordering are exactly what the FK now rejects.
 *
 * The inspection/mutation helpers (`readPersistedRunState`,
 * `patchPersistedRunState`, `deletePersistedRunState`,
 * `writeRawRunJson`, `listPersistedRunIds`) replace the `readFile`/`writeFile`/
 * `unlink` pairs tests used against `.rundown/runs/`. They deliberately bypass
 * validation on write, because a large share of the suites that touched those
 * files were asserting how the CLI *rejects* invalid persisted state.
 *
 * @module testing/session-fixtures
 */

import { parseRunbookDocument, type Runbook } from '@rundown-org/parser';
import { RunbookStateManager } from '../runbook/state.js';
import { SessionService } from '../runbook/session-service.js';
import { assertRunId, type RunId } from '../runbook/run-id.js';
import type { ClaimId } from '../runbook/claim-id.js';
import type { RunbookRef } from '../runbook/runbook-ref.js';
import type { ParentLinkage, RunbookState } from '../runbook/types.js';
import type { VariableValue } from '../runbook/effective-vars.js';
import { getRunbookStore } from '../runbook/storage/store-registry.js';
import { seedRawRunState } from './state-fixtures.js';

export { seedRawRunState };

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
 * Options accepted by {@link seedRun} and {@link seedActiveRun}.
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
  /** Parent linkage recorded when the seeded run is a delegated/inline child. */
  readonly parentLinkage?: ParentLinkage;
  /** Marks the run as agent-prompted, matching `rundown run --prompted`. */
  readonly prompted?: boolean;
}

/**
 * A run persisted by one of the seeding helpers.
 */
export interface SeededRun {
  /** The persisted state as the manager wrote it. */
  readonly state: RunbookState;
  /** Convenience alias for `state.id`. */
  readonly runId: RunId;
  /**
   * Bearer claim id minted for the run.
   *
   * Present only when the helper was asked to mint run-control authority.
   */
  readonly claimId?: ClaimId;
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
 * Persist a run WITHOUT touching the session (no stack push, no claim).
 *
 * This is the "run exists but nothing targets it" shape — an orphan, a
 * delegated child before it is claimed, or a second run used only as a
 * `--run` selector target.
 *
 * @param cwd - Project root whose store receives the run.
 * @param options - Run identity and content.
 * @returns The persisted run.
 */
export async function seedRun(cwd: string, options: SeedRunOptions = {}): Promise<SeededRun> {
  const manager = new RunbookStateManager(cwd);
  const { runbook, runbookRef, runbookPath } = resolveRunbook(options);
  const state = await manager.create(runbookRef, runbook, {
    runbookPath,
    runId: options.runId,
    prompted: options.prompted,
    parentLinkage: options.parentLinkage,
    initialVariables: options.variables,
  });
  return { state, runId: state.id };
}

/**
 * Options for {@link seedActiveRun}.
 */
export interface SeedActiveRunOptions extends SeedRunOptions {
  /**
   * Mint a run-control bearer claim for the run.
   *
   * Defaults to `true`, matching `rundown run`, which hands the orchestrator a
   * bearer via `pushRunbookWithRunControlClaim`. Set `false` for the rarer
   * "on the stack, no claim" shape.
   */
  readonly withRunControlClaim?: boolean;
}

/**
 * Persist a run and make it the active run on the default stack.
 *
 * Follows production ordering exactly: `create` persists the run row first, then
 * `pushRunbookWithRunControlClaim` pushes and mints the claim in one session
 * mutation. The push-before-persist ordering the old JSON fixtures used is
 * rejected by the `claims.controlled_run` foreign key.
 *
 * @param cwd - Project root whose store receives the run.
 * @param options - Run identity, content, and claim minting.
 * @returns The persisted run, including `claimId` unless claim minting was disabled.
 */
export async function seedActiveRun(
  cwd: string,
  options: SeedActiveRunOptions = {},
): Promise<SeededRun> {
  const manager = new RunbookStateManager(cwd);
  const sessions = new SessionService(manager);
  const seeded = await seedRun(cwd, options);

  if (options.withRunControlClaim === false) {
    await sessions.pushRunbook(seeded.runId);
    return seeded;
  }

  const activation = await sessions.pushRunbookWithRunControlClaim(seeded.runId);
  if (activation.status !== 'committed') {
    throw new Error(activation.message);
  }
  return { ...seeded, claimId: activation.value.claimId };
}

/**
 * Persist a run and move it straight into the session's single stash slot.
 *
 * The run is pushed (and claimed, unless disabled) before being stashed, because
 * `stashRunbook` refuses a run nothing targets — the same refusal production
 * relies on.
 *
 * @param cwd - Project root whose store receives the run.
 * @param options - Run identity, content, and claim minting.
 * @returns The persisted, stashed run.
 * @throws {Error} When the stash slot is already occupied, since a silently
 *   un-stashed fixture would make the assertions under test vacuous.
 */
export async function seedStashedRun(
  cwd: string,
  options: SeedActiveRunOptions = {},
): Promise<SeededRun> {
  const seeded = await seedActiveRun(cwd, options);
  const sessions = new SessionService(new RunbookStateManager(cwd));
  const stashed = await sessions.stashRunbook(seeded.runId);
  if (stashed.status !== 'committed') {
    throw new Error(stashed.message);
  }
  if (stashed.value === null) {
    throw new Error(`seedStashedRun: stash slot unavailable for ${seeded.runId}`);
  }
  return seeded;
}

/**
 * Mint a run-control bearer claim for an already-persisted run.
 *
 * @param cwd - Project root whose store holds the run.
 * @param runId - Run the claim controls; it MUST already exist.
 * @returns The bearer claim id.
 */
export async function issueRunControlClaimFor(cwd: string, runId: RunId): Promise<ClaimId> {
  const sessions = new SessionService(new RunbookStateManager(cwd));
  const issued = await sessions.issueRunControlClaim(runId);
  if (issued.status !== 'committed') {
    throw new Error(issued.message);
  }
  return issued.value.claimId;
}

/**
 * Replace the session's default stack and stash slot.
 *
 * Preserves the existing claim registry, so callers cannot accidentally orphan
 * bearers they still hold. Every id must already exist as a run.
 *
 * @param cwd - Project root whose store receives the session.
 * @param session - Fields to write; omitted fields are left as persisted.
 * @param session.defaultStack - Replacement default stack, bottom to top.
 * @param session.stashedRunbookId - Replacement stash slot, or `null` to clear it.
 * @returns Resolves once the session is committed.
 */
export async function seedSession(
  cwd: string,
  session: {
    readonly defaultStack?: readonly RunId[];
    readonly stashedRunbookId?: RunId | null;
  },
): Promise<void> {
  const manager = new RunbookStateManager(cwd);
  const current = await manager.loadSession();
  await manager.saveSession({
    ...current,
    defaultStack:
      session.defaultStack !== undefined ? [...session.defaultStack] : current.defaultStack,
    stashedRunbookId:
      session.stashedRunbookId !== undefined
        ? (session.stashedRunbookId ?? undefined)
        : current.stashedRunbookId,
  });
}

/**
 * Read a run's persisted state as raw, UNVALIDATED JSON.
 *
 * The direct replacement for `JSON.parse(await readFile('.rundown/runs/<id>.json'))`.
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
 * The direct replacement for the read-modify-write `writeFile` pattern. The
 * write is unvalidated on purpose: the most common use is planting state the
 * CLI must reject (`{ schemaVersion: 2 }`, a terminal `lifecycle`, and so on).
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
 * For the handful of suites that wrote literal garbage (`'{invalid'`) to assert
 * the CLI's parse-failure envelope. Bypasses both JSON and schema validation.
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
  await store.transaction((txn) => {
    txn.tx
      .prepare(
        `INSERT INTO runs (id, state_version, claim_generation, lifecycle, state_json, created_at, updated_at)
           VALUES (:id, 0, 0, 'running', :json, :now, :now)
         ON CONFLICT(id) DO UPDATE SET state_json = :json, updated_at = :now`,
      )
      .run({ id, json, now });
  });
}

/**
 * Delete a run row, simulating the pre-SQLite `unlink('.rundown/runs/<id>.json')`.
 *
 * Cascades to the run's claims via the `claims.controlled_run` foreign key, which
 * is what makes this the faithful analogue of deleting the old state file while a
 * session still referenced it.
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
 * The replacement for `readdir('.rundown/runs/')`. Unlike
 * `RunbookStateManager.list`, it does NOT drop invalid rows — suites asserting
 * that `prune` reaches unparseable state depend on seeing them.
 *
 * @param cwd - Project root whose store is enumerated.
 * @returns Run ids in store order.
 */
export async function listPersistedRunIds(cwd: string): Promise<readonly RunId[]> {
  const store = await getRunbookStore(cwd);
  return store.listRunIds();
}
