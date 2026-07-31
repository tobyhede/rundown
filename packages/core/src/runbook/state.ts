// src/runbook/state.ts
import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { FrameKey } from './targeting.js';
import type {
  RunbookState,
  ForContext,
  Substep,
  SubstepState,
  Runbook,
  ResolvedRunbook,
  ParentLinkage,
  TemplateVarValue,
  ResolvedCompletion,
} from './types.js';
import {
  applyOp,
  type FrameEntryCountsOp,
  type ResolvedCompletionsOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
import type { ClaimLookupKey, ClaimRecord } from './claim-id.js';
import type { RunbookRef } from './runbook-ref.js';
import { makeRunbookStateSchema, SessionDataSchema } from '../schemas.js';
import { getErrorMessage, isError, isNodeError, type InvalidRunStateDefect } from '../errors.js';
import { logger } from '../logger.js';
import {
  brandInitialTemplateVars,
  brandStoredOutputs,
  isTrustedArtifactValue,
  type VariableValue,
} from './effective-vars.js';
import { isArtifactRecord } from './artifact-schema.js';
import { assertRunId, RUN_ID_PREFIX, type RunId } from './run-id.js';
import { runsDir as _runsDir, assertSafeId } from '../paths.js';
import { getRunbookStore } from './storage/store-registry.js';
import {
  guardOptions,
  type ParentAdvanceGuard,
  type CapturedRunStateResult,
  type PresentedClaim,
  type RunbookStore,
  type SessionMutationResult,
  type SessionMutationTxn,
  type StateMutationResult,
} from './storage/runbook-store.js';
import type { OpenRunbookDriverOptions } from './storage/driver-factory.js';
import type { SyncWork } from './storage/sql-driver.js';
import {
  assertCurrentSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  InvalidRunbookStateError,
} from './state-schema-version.js';

// Re-exported from their leaf module so this file stays the import site every
// existing consumer already names, while `storage/runbook-store.ts` can reach
// the same gate without closing an import cycle back through this module.
export { CURRENT_SCHEMA_VERSION, InvalidRunbookStateError };

function patchSnapshotSubstepStates(
  snapshot: unknown,
  substepStates: readonly SubstepState[] | undefined,
): unknown {
  if (!snapshot || typeof snapshot !== 'object' || !('context' in snapshot)) {
    return snapshot;
  }
  const context = (snapshot as { context?: unknown }).context;
  if (!context || typeof context !== 'object') {
    return snapshot;
  }
  return {
    ...(snapshot as Record<string, unknown>),
    context: {
      ...(context as Record<string, unknown>),
      substepStates,
    },
  };
}

function assertTrustedArtifactValues(
  vars: Readonly<Record<string, VariableValue>>,
): Readonly<Record<string, VariableValue>> {
  for (const [key, value] of Object.entries(vars)) {
    if (isTrustedArtifactValue(value)) {
      continue;
    }
    if (
      isArtifactRecord(value) ||
      (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord))
    ) {
      throw new Error(
        `Artifact record value for "${key}" is not trusted. Pass an artifact URI so Rundown can resolve it.`,
      );
    }
  }

  return vars;
}

function assertTrustedResolvedCompletions(
  completions: Readonly<Record<string, ResolvedCompletion>> | undefined,
): Readonly<Record<string, ResolvedCompletion>> | undefined {
  if (completions === undefined) {
    return undefined;
  }
  for (const [key, completion] of Object.entries(completions)) {
    if (completion.finalVars !== undefined) {
      try {
        assertTrustedArtifactValues(completion.finalVars);
      } catch (err: unknown) {
        throw new Error(
          `Resolved completion "${key}" carries invalid finalVars: ${getErrorMessage(err)}`,
        );
      }
    }
  }
  return completions;
}

/**
 * Thrown when persisted state uses the deprecated dynamic-step snapshot
 * shape (`GOTO_NEXT` last action or `instance` field), which the current
 * runtime rejects per the no-migration rule.
 *
 * A dedicated class so consumers (e.g. the CLI's orphaned-active-stack
 * recovery) classify by type rather than matching message wording.
 */
export class LegacySnapshotError extends Error {
  /**
   * Structured facts about the refusal, lifted from the throw site.
   *
   * Surfaces as RD-309's `context` so a consumer never has to parse the run id
   * out of `message`. `undefined` only where a construction site supplies none
   * — every production throw site does.
   */
  readonly defect: InvalidRunStateDefect | undefined;

  /**
   * Create a new LegacySnapshotError.
   *
   * @param message - Human-readable description of the rejected legacy shape
   * @param defect - Structured facts about the refused run
   */
  constructor(message: string, defect?: InvalidRunStateDefect) {
    super(message);
    this.name = 'LegacySnapshotError';
    this.defect = defect;
  }
}

/**
 * Thrown when a guarded run-state read-modify-write spent its optimistic
 * compare-and-swap budget without landing.
 *
 * This is the throwing face of {@link StateMutationResult}'s
 * `concurrent_modification` arm. The CAS that replaced the per-run file lock
 * replays at most 8 times with no backoff, so a few-way concurrent writer can
 * exhaust the budget where the lock would have waited and won — CLAUDE.md
 * therefore requires callers to handle or retry it, which is only implementable
 * against a type. A bare `Error` forced message matching and reached the CLI as
 * RD-999 "Unknown error".
 *
 * Distinct from every other 3xx state condition in that it is **transient**:
 * nothing was written, the persisted state is intact, and the same command
 * retried unchanged is expected to succeed. {@link retryable} states that at the
 * type level so a consumer branches on a property rather than on the class name.
 */
export class ConcurrentStateModificationError extends Error {
  /**
   * The run whose state write was lost.
   *
   * A caller retrying a batch needs to know which run to replay, and the run id
   * is not recoverable from the message without parsing it.
   */
  readonly runId: string;

  /**
   * Always `true`, as a literal type.
   *
   * The discriminant that separates this from the refusals that share its
   * throwing seam (`missing`, `execution_in_progress`), where retrying is
   * pointless. A caller narrows on this rather than re-deriving "is this the
   * retryable one?" from the class.
   */
  readonly retryable = true as const;

  /**
   * Create a new ConcurrentStateModificationError.
   *
   * @param runId - The run whose state write was lost.
   * @param message - The store's description of the lost cycle.
   */
  constructor(runId: string, message: string) {
    super(message);
    this.name = 'ConcurrentStateModificationError';
    this.runId = runId;
  }
}

/**
 * Narrow an unknown thrown value to {@link ConcurrentStateModificationError}.
 *
 * Provided so a consumer that catches from a different realm — or that only has
 * the value typed as `unknown` — can classify the retryable outcome without an
 * `instanceof` against an import it would otherwise not need.
 *
 * @param error - The caught value.
 * @returns True when `error` is a {@link ConcurrentStateModificationError}, narrowing it.
 */
export function isConcurrentStateModificationError(
  error: unknown,
): error is ConcurrentStateModificationError {
  return error instanceof ConcurrentStateModificationError;
}

/**
 * Generate a concrete Rundown run identifier.
 *
 * @returns Run ID in canonical `rd_<32 lowercase hex>` form
 */
export function generateRunId(): RunId {
  return assertRunId(`${RUN_ID_PREFIX}${randomBytes(16).toString('hex')}`);
}

/**
 * Persisted session state tracking the active runbook stack.
 *
 * A single shared stash slot allows temporarily parking a runbook.
 */
export interface SessionData {
  /** Active runbook stack for default targeting. */
  defaultStack: RunId[];
  /** ID of a temporarily stashed runbook, if any. */
  stashedRunbookId?: RunId;
  /** Explicit claim-id records for delegated child runbook targeting. */
  claims: Record<string, ClaimRecord>;
}

/**
 * Typed patch accepted by {@link RunbookStateManager.update}.
 *
 * Record-shaped fields use tagged operations so callers must choose merge or
 * replacement semantics explicitly.
 */
export type RunbookStateUpdate = Partial<
  Omit<
    RunbookState,
    | 'id'
    | 'startedAt'
    | 'updatedAt'
    | 'schemaVersion'
    | 'variables'
    | 'templateVars'
    | 'resolvedCompletions'
    | 'frameEntryCounts'
  >
> & {
  /** Merge or replace persisted runtime variables. */
  readonly variables?: VariablesOp;
  /** Replace initial template variables. */
  readonly templateVars?: TemplateVarsOp;
  /** Merge or replace resolved completion records. */
  readonly resolvedCompletions?: ResolvedCompletionsOp;
  /** Replace per-frame entry counters. */
  readonly frameEntryCounts?: FrameEntryCountsOp;
};

/**
 * Apply a {@link RunbookStateUpdate} patch to a state value, purely.
 *
 * The single application of tagged merge/replace ops, artifact/completion trust
 * re-assertion, and the {@link CURRENT_SCHEMA_VERSION} stamp. Shared by
 * {@link RunbookStateManager}'s guarded write path and by the actor
 * compute/commit seam, which derives the next state without persisting, so both
 * apply identical patch semantics.
 *
 * Two things are deliberately NOT identical between the two paths:
 * - `updatedAt` is stamped independently by each persistence layer, so the value
 *   returned by `update` and the value the fenced seam commits differ. Compare
 *   states modulo `updatedAt`.
 * - The resolved-completion consumption patch is read from the store on the
 *   manager path and from the captured state on the fenced path — under a fence
 *   the captured state is the authority, so a concurrent write must not change
 *   what the fenced mutation consumes.
 *
 * @param existing - The state to patch.
 * @param updates - The typed patch with tagged ops on record-shaped fields.
 * @param now - The ISO timestamp to stamp as `updatedAt`.
 * @returns The patched state (not persisted), stamped with the current schema version.
 * @throws {InvalidRunbookStateError} When `existing` carries a schema version
 *   other than {@link CURRENT_SCHEMA_VERSION}. Deriving from invalid state would
 *   silently migrate it; the sanctioned recovery is prune/restart.
 */
export function applyRunbookStateUpdate(
  existing: RunbookState,
  updates: RunbookStateUpdate,
  now: string,
): RunbookState {
  // Refuse invalid state; never migrate it. Deriving from a state whose version
  // is not current would rewrite it to current on the next commit — precisely the
  // silent migration the no-migration rule forbids, whose only sanctioned
  // recovery is explicit user action. An ABSENT version is refused for the same
  // reason and on the same terms as a wrong one: `load` rejects both, so
  // exempting absent would make this derivation more permissive than the loader
  // and launder a state `load` refuses into one it accepts. Absent is also the
  // only shape the store can hand over unvalidated — its schema leaves the field
  // optional so `load` can parse far enough to reach its own check — which makes
  // it the shape most in need of refusing, not least.
  assertCurrentSchemaVersion(existing.schemaVersion, existing.id);
  // Pull tagged-op fields out of updates so the subsequent `...updates` spread
  // does not leak the wrapper shapes into the strictly-typed RunbookState literal.
  const {
    variables: variablesOp,
    templateVars: templateVarsOp,
    resolvedCompletions: resolvedCompletionsOp,
    frameEntryCounts: frameEntryCountsOp,
    ...restUpdates
  } = updates;
  const shouldPatchSnapshotSubstepStates =
    restUpdates.substepStates !== undefined && restUpdates.snapshot === undefined;
  const patchedRestUpdates = shouldPatchSnapshotSubstepStates
    ? {
        ...restUpdates,
        snapshot: patchSnapshotSubstepStates(existing.snapshot, restUpdates.substepStates),
      }
    : restUpdates;

  return {
    ...existing,
    ...patchedRestUpdates,
    ...(patchedRestUpdates.finalVars !== undefined
      ? { finalVars: assertTrustedArtifactValues(patchedRestUpdates.finalVars) }
      : {}),
    variables:
      variablesOp !== undefined
        ? brandStoredOutputs(assertTrustedArtifactValues(applyOp(existing.variables, variablesOp)))
        : existing.variables,
    ...(templateVarsOp !== undefined
      ? { templateVars: brandInitialTemplateVars(templateVarsOp.value) }
      : {}),
    ...(resolvedCompletionsOp !== undefined
      ? {
          resolvedCompletions: assertTrustedResolvedCompletions(
            applyOp(existing.resolvedCompletions, resolvedCompletionsOp),
          ),
        }
      : {}),
    ...(frameEntryCountsOp !== undefined ? { frameEntryCounts: frameEntryCountsOp.value } : {}),
    // Stamp the current model version on the newly derived state. Not a
    // migration: the derived state IS the current model, and `existing` has
    // already been validated (`load` rejects any other version). Without this
    // the fenced compute half inherits `existing.schemaVersion` verbatim —
    // including `undefined` from a store-loaded state, where the field is
    // optional — and the fenced committer persists `nextState` as-is, leaving a
    // run that `load` refuses with no recovery short of prune/restart.
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: now,
  };
}

interface CreateOptions {
  readonly runbookPath: string;
  readonly runId?: RunId;
  readonly prompted?: boolean;
  /** Parent linkage when this run is a child (delegation or inline). */
  readonly parentLinkage?: ParentLinkage;
  readonly runbookSrc?: string;
  /** Optional record of template variable replacements to populate placeholders at run time. */
  readonly templateVars?: Record<string, TemplateVarValue>;
  /** Optional runtime variables to seed into RunbookState.variables at creation. */
  readonly initialVariables?: Readonly<Record<string, VariableValue>>;
  /** Frontmatter `outputs:` declarations seeded into the compiled machine for OUTPUTS evaluation. */
  readonly frontmatterOutputs?: readonly OutputDeclaration[];
}

/**
 * Construction options for {@link RunbookStateManager}.
 */
export interface RunbookStateManagerOptions {
  /**
   * Driver options for the project's store (runtime override, adapter settings).
   * Tests pin `runtime: 'native'`; production relies on capability selection.
   */
  readonly storeOptions?: OpenRunbookDriverOptions;
}

/**
 * Manager for runbook state persistence and lifecycle.
 *
 * Handles creating, loading, saving, and updating runbook state.
 * State is persisted in the project's shared SQLite store.
 * Supports runbook stacks for nested runbooks.
 */
export class RunbookStateManager {
  private readonly _cwd: string;
  private readonly storeOptions: OpenRunbookDriverOptions;

  /**
   * Create a new RunbookStateManager.
   *
   * @param cwd - The working directory (project root) for state persistence
   * @param options - Optional overrides, including store driver options
   */
  constructor(cwd: string, options: RunbookStateManagerOptions = {}) {
    this.storeOptions = options.storeOptions ?? {};
    try {
      this._cwd = fsSync.realpathSync(cwd);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        void logger.warn(
          `RunbookStateManager: fs.realpathSync("${cwd}") failed (${isNodeError(err) ? (err.code ?? 'unknown') : 'unknown'}), ` +
            `using raw path — JsonArrayStream / artifact path validation may produce false failures. Check permissions on project root.`,
        );
      }
      this._cwd = cwd;
    }
  }

  /**
   * Project root directory used for storage and artifact path resolution.
   *
   * @returns The working directory passed to the constructor
   */
  get cwd(): string {
    return this._cwd;
  }

  /**
   * The project's shared store, opened on first use.
   *
   * @returns The shared {@link RunbookStore} for this project root.
   */
  private store(): Promise<RunbookStore> {
    return getRunbookStore(this._cwd, this.storeOptions);
  }

  /**
   * Narrow a caller-supplied id to a {@link RunId}.
   *
   * Rejects traversal-unsafe ids exactly as the old path builder did. A safe but
   * non-canonical id cannot name a run, so it resolves to `null` — the caller
   * treats that as "genuinely missing", matching the old file-not-found path.
   *
   * @param id - Caller-supplied runbook id.
   * @returns The branded run id, or null when the id cannot name a run.
   * @throws {Error} When the id is unsafe (path traversal).
   */
  private toRunId(id: string): RunId | null {
    assertSafeId(id, 'runbook id');
    try {
      return assertRunId(id);
    } catch {
      return null;
    }
  }

  /**
   * Unwrap a committed mutation, mapping refusals to the manager's error contract.
   *
   * The `concurrent_modification` arm is separated from the rest because it is
   * the only transient one: nothing was written, and retrying is the correct
   * response. It gets a dedicated type so callers can act on that (and so the
   * CLI reports RD-308 rather than collapsing it into RD-999) instead of
   * matching the store's message text.
   *
   * @param result - The store mutation outcome.
   * @param id - Runbook id, for the error message.
   * @returns The committed (or unchanged) state.
   * @throws {ConcurrentStateModificationError} When the optimistic CAS budget was
   *   spent because another writer committed first. Transient and retryable.
   * @throws {Error} When the run is missing or owned by a live execution. Neither
   *   is retryable.
   */
  private requireCommitted(result: StateMutationResult, id: string): RunbookState {
    switch (result.kind) {
      case 'committed':
      case 'unchanged':
        return result.value;
      case 'missing':
        throw new Error(`Runbook ${id} not found`);
      case 'concurrent_modification':
        throw new ConcurrentStateModificationError(result.runId, result.message);
      default:
        throw new Error(result.message);
    }
  }

  /**
   * Create a new runbook state and insert it as a row in the project's store.
   *
   * The state is committed through {@link save}, which inserts the run row into
   * the shared SQLite database. No per-run directory is created here: the
   * filesystem-backed `.rundown/runs/<id>/outputs/` tree holds captured command
   * output only, and is created on demand by the capture path.
   *
   * `templateVars` is always written — `{}` when the caller supplies none — because
   * {@link load} refuses a persisted row without it.
   *
   * @param runbookRef - Canonical runbook identity
   * @param runbook - The parsed runbook definition
   * @param options - Configuration including agentId, parent runbook info, prompted flag, and templateVars for template variable replacements
   * @returns The newly created RunbookState
   */
  async create(
    runbookRef: RunbookRef,
    runbook: Runbook | ResolvedRunbook,
    options: CreateOptions,
  ): Promise<RunbookState> {
    const id = options.runId ?? generateRunId();
    const now = new Date().toISOString();

    const initialStep = runbook.steps[0];

    const state: RunbookState = {
      id,
      runbook: runbookRef,
      runbookPath: options.runbookPath,
      title: runbook.title,
      description: runbook.description,
      step: initialStep.name,
      stepName: initialStep.description,
      retryCount: 0,
      variables: brandStoredOutputs(assertTrustedArtifactValues(options.initialVariables ?? {})),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: {},
      parentLinkage: options.parentLinkage,
      startedAt: now,
      updatedAt: now,
      prompted: options.prompted,
      runbookSrc: options.runbookSrc,
      // Always written, `{}` when the caller supplies none: `load` refuses a
      // persisted row without templateVars rather than reconstructing it, so a
      // run created without one would be unreadable the moment it is saved.
      templateVars: brandInitialTemplateVars(options.templateVars ?? {}),
      frontmatterOutputs: options.frontmatterOutputs ?? [],
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    await this.save(state);
    return state;
  }

  /**
   * Read a runbook state back from the project's store by ID.
   *
   * Reassembles the run's `state_json` from its row and validates it. Returns
   * `null` when a traversal-safe id has no matching record, which also covers a
   * safe id that cannot name a run at all. A traversal-unsafe id never reaches
   * the store: {@link RunbookStateManager.toRunId} rejects it first. Anything
   * else is invalid persisted state and is refused rather than adapted: there is
   * no migration path, and the caller's recovery is always to finish, stop,
   * prune, or restart the run.
   *
   * @param id - The runbook state ID (e.g., 'rd_0123456789abcdef0123456789abcdef')
   * @returns The loaded RunbookState, or null when a traversal-safe `id` has no record
   * @throws {Error} If `id` is traversal-unsafe — rejected before any store access
   * @throws {InvalidRunbookStateError} If the record exists but its `state_json`
   *   is unparseable, fails schema validation, has an incompatible schemaVersion,
   *   or is missing `templateVars`
   * @throws {LegacySnapshotError} If the runbook state uses deprecated dynamic-step snapshots
   */
  async load(id: string): Promise<RunbookState | null> {
    const runId = this.toRunId(id);
    if (runId === null) {
      return null; // Not a run identifier — genuinely missing.
    }
    const store = await this.store();
    // Unparseable `state_json` is invalid persisted state, not an unknown internal
    // fault: surface it in this method's own taxonomy rather than letting a bare
    // SyntaxError escape and surface to users as RD-999 / "Unknown error".
    let raw: Record<string, unknown> | null;
    try {
      raw = await store.readRunJson(runId);
    } catch (error) {
      if (isError(error) && error.name === 'SyntaxError') {
        throw new InvalidRunbookStateError(
          `Invalid runbook state for "${id}": persisted state is not valid JSON.`,
          { runId, reason: 'unparseable_json' },
        );
      }
      throw error;
    }
    if (raw === null) {
      return null;
    }

    // Reject legacy dynamic-step snapshots: GOTO_NEXT action or instance field.
    const obj = raw;
    const lastAction = obj.lastAction;
    if (
      typeof lastAction === 'object' &&
      lastAction !== null &&
      (lastAction as Record<string, unknown>).type === 'GOTO_NEXT'
    ) {
      throw new LegacySnapshotError(
        'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported. ' +
          'Please restart execution from the runbook entrypoint.',
        { runId, reason: 'legacy_dynamic_step_snapshot' },
      );
    }
    if (obj.instance !== undefined) {
      throw new LegacySnapshotError(
        'This runbook used dynamic-step snapshots (instance field), which are no longer supported. ' +
          'Please restart execution from the runbook entrypoint.',
        { runId, reason: 'legacy_dynamic_step_snapshot' },
      );
    }

    assertCurrentSchemaVersion(obj.schemaVersion, id);

    // A current-schema row without templateVars is incompatible state. Readers
    // substitute `runbookSrc` against it on every resume; re-parsing the stored
    // source to stand in for it would be a silent migration. Named explicitly
    // rather than left to the schema parse below so the refusal says which field
    // is missing and what to do about it.
    if (obj.templateVars === undefined) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": missing templateVars. ` +
          `Prune this run and re-run the runbook.`,
        { runId, reason: 'missing_template_vars' },
      );
    }

    const result = makeRunbookStateSchema(this.cwd).safeParse(raw);
    if (!result.success) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": schema validation failed.`,
        { runId, reason: 'schema_validation_failed' },
      );
    }
    // Zod's .regex() refinement narrows at runtime but infers as `string` at the type level.
    // The schema guarantees GOTO `at` matches TEMPLATE_VAR_PATTERN; cast to the stricter TS type.
    return result.data as RunbookState;
  }

  /**
   * Write a runbook state to the project's store.
   *
   * Inserts the run row when no record for `state.id` exists yet and otherwise
   * commits a wholesale replacement of the existing one, stamping the current
   * schema version and a fresh `updatedAt` either way. Per-run captured output
   * under `.rundown/runs/<id>/outputs/` is separate filesystem state and is not
   * touched here.
   *
   * @param state - The runbook state to persist
   * @throws {Error} When the run exists but the replacement cannot be committed
   *   because a live execution owns it.
   * @throws {ConcurrentStateModificationError} When another writer committed to
   *   the same run first and the optimistic CAS budget was spent. Retryable.
   */
  async save(state: RunbookState): Promise<void> {
    const store = await this.store();
    const updated: RunbookState = {
      ...state,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const existing = await store.readRunJson(state.id);
    if (existing === null) {
      await store.createRun(updated);
    } else {
      this.requireCommitted(await store.mutateState(state.id, () => updated), state.id);
    }
    const next = updated.lifecycle ?? null;
    if (next !== null) {
      // Diagnostic trail for lifecycle transitions (#536 was found with this
      // signal). Enable with RUNDOWN_LOG_LEVEL=debug; the logger stamps pid.
      void logger.debug('lifecycle-write', { runId: state.id, next });
    }
  }

  /**
   * Update an existing runbook state with partial changes.
   *
   * Per-field semantics:
   * - `variables` — `merge(...)` shallow-merges values (merge-only). Accepts
   *   strings (OUTPUTS), `ArtifactRecord` (exact ARTIFACT), and
   *   `readonly ArtifactRecord[]` (wildcard ARTIFACT).
   * - `templateVars` — `replace(...)` wholesale-replaces (replace-only; seeded once)
   * - `resolvedCompletions` — `merge(...)` adds one entry; `replace(...)` rewrites the map
   * - `frameEntryCounts` — `replace(...)` wholesale-replaces (replace-only)
   * - All other fields — provided value is taken verbatim; omitted fields are preserved
   *
   * Use the {@link merge} and {@link replace} constructors at call sites to make
   * intent visible at the type level; passing a raw record without a tag is a
   * compile error.
   *
   * @param id - The runbook state ID to update
   * @param updates - Partial state updates with tagged ops on record-shaped fields
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard; when present the write refuses if the run has a live delegated child.
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a live delegated child blocks the advance.
   */
  async update(
    id: string,
    updates: RunbookStateUpdate,
    options: { readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<RunbookState> {
    const state = await this.mutate(id, () => updates, {
      missingIsError: true,
      ...guardOptions(options.guard),
    });
    if (state === null) {
      throw new Error(`Runbook ${id} not found`);
    }
    return state;
  }

  /**
   * Update an existing runbook state with a patch computed from the current
   * state captured by the guarded store cycle.
   *
   * Use this for read-modify-write operations that replace whole fields such
   * as `substepStates` or `resolvedCompletions`. The callback runs against the
   * state read at the start of the cycle and the write commits only if that
   * state's version is unchanged, so a concurrent writer cannot overwrite this
   * one; a version that moved reruns the callback against fresh state.
   *
   * Returning `null` leaves the current state unchanged and writes nothing.
   *
   * @param id - The runbook state ID to update
   * @param buildUpdates - Callback that derives a patch from current state
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard; when present the write refuses if the run has a live delegated child.
   * @returns The updated state, or current state when the callback returns `null`
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a live delegated child blocks the advance.
   */
  async updateWithState(
    id: string,
    buildUpdates: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
    options: { readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<RunbookState> {
    const updated = await this.updateWithStateIfExists(id, buildUpdates, options);
    if (updated === null) {
      throw new Error(`Runbook ${id} not found`);
    }
    return updated;
  }

  /**
   * Like {@link updateWithState}, but returns `null` when the runbook does not
   * exist instead of throwing.
   *
   * Use this for guarded read-modify-write operations where a missing runbook is
   * a legitimate "nothing to do" outcome rather than an error (for example,
   * consuming a resolved completion). The callback only runs when the runbook
   * exists, so it always receives a non-null {@link RunbookState}.
   *
   * @param id - The runbook state ID to update
   * @param buildUpdates - Callback that derives a patch from current state
   * @param options - Optional write options.
   * @param options.guard - Parent-advance guard; when present the write refuses if the run has a live delegated child.
   * @returns The updated state, the current state when the callback returns
   *   `null`, or `null` when the runbook does not exist
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a live delegated child blocks the advance.
   */
  async updateWithStateIfExists(
    id: string,
    buildUpdates: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
    options: { readonly guard?: ParentAdvanceGuard } = {},
  ): Promise<RunbookState | null> {
    return await this.mutate(id, buildUpdates, {
      missingIsError: false,
      ...guardOptions(options.guard),
    });
  }

  /**
   * Like {@link updateWithStateIfExists}, but the callback additionally returns
   * a typed value that flows out through the result instead of through a
   * captured closure variable.
   *
   * Use this for guarded read-modify-write operations that must also report
   * something they computed from the captured current state (for example,
   * consuming and returning a resolved completion). The patch and the reported
   * value are derived in the same callback against the same captured state, and
   * the value is recaptured on every retry, so the reported value is always
   * consistent with the patch that actually committed.
   *
   * When the runbook does not exist the callback never runs; the result is
   * `{ state: null, value: null }`.
   *
   * @template R - Type of the value the callback reports.
   * @param id - The runbook state ID to update.
   * @param buildResult - Callback deriving `{ updates, value }` from current state.
   * @returns The updated state (or `null` when missing) and the reported value
   *   (or `null` when the runbook does not exist).
   */
  async updateWithStateReturning<R>(
    id: string,
    buildResult: (
      current: RunbookState,
    ) =>
      | { updates: RunbookStateUpdate | null; value: R }
      | Promise<{ updates: RunbookStateUpdate | null; value: R }>,
  ): Promise<{ state: RunbookState | null; value: R | null }> {
    const runId = this.toRunId(id);
    if (runId === null) {
      return { state: null, value: null };
    }
    const store = await this.store();
    let captured: R | null = null;
    const result = await store.mutateState(runId, async (current) => {
      const { updates, value } = await buildResult(current);
      // Captured on every attempt, so a retry against fresh state reports the
      // value derived from the state that actually committed.
      captured = value;
      return updates === null
        ? null
        : applyRunbookStateUpdate(current, updates, new Date().toISOString());
    });
    if (result.kind === 'missing') {
      return { state: null, value: null };
    }
    return { state: this.requireCommitted(result, id), value: captured };
  }

  /**
   * Apply a derived patch to a run inside one guarded store cycle.
   *
   * The builder runs against the state read at the start of the cycle and reruns
   * on a stale-version retry, which is what replaces holding the per-run lock
   * across the read-modify-write.
   *
   * @param id - Runbook id.
   * @param buildUpdates - Derives the patch; `null` means leave the state alone.
   * @param options - Whether a missing run throws or resolves to null, and an optional guard.
   * @param options.missingIsError - When true, a missing run throws; when false, it resolves to null.
   * @param options.guard - Parent-advance guard forwarded to the store; when
   *   present the write refuses if the run still has a live delegated child.
   * @returns The resulting state, or null when missing and tolerated.
   * @throws {Error} When the run is missing (and not tolerated) or owned by an
   *   execution.
   * @throws {ConcurrentStateModificationError} When the cycle lost to a
   *   concurrent writer and the CAS budget was spent. Retryable.
   * @throws {OpenDelegatedChildrenError} When `options.guard` is supplied and a
   *   live delegated child blocks the advance.
   */
  private async mutate(
    id: string,
    buildUpdates: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
    options: { readonly missingIsError: boolean; readonly guard?: ParentAdvanceGuard },
  ): Promise<RunbookState | null> {
    const runId = this.toRunId(id);
    if (runId === null) {
      if (options.missingIsError) {
        throw new Error(`Runbook ${id} not found`);
      }
      return null;
    }
    const store = await this.store();
    const result = await store.mutateState(
      runId,
      async (current) => {
        const updates = await buildUpdates(current);
        return updates === null
          ? null
          : applyRunbookStateUpdate(current, updates, new Date().toISOString());
      },
      guardOptions(options.guard),
    );
    if (result.kind === 'missing' && !options.missingIsError) {
      return null;
    }
    return this.requireCommitted(result, id);
  }

  /**
   * Delete a persisted run and its per-run outputs directory.
   *
   * Removes the authoritative SQLite row and the captured-output directory
   * `.rundown/runs/<id>/` if it exists. Missing state is ignored so deletion is
   * idempotent.
   *
   * @param id - The runbook state ID to delete
   */
  async delete(id: string): Promise<void> {
    const runId = this.toRunId(id);
    if (runId !== null) {
      const store = await this.store();
      // The row delete cascades to claims, stack, stash, completions, and
      // attempts, and refuses while an execution owns the run.
      await store.deleteRun(runId);
      // Logged immediately after the row is confirmed removed — and before the
      // outputs-dir cleanup below — so a later `fs.rm` failure cannot suppress
      // the trail of a deletion that actually committed.
      void logger.debug('lifecycle-write', { runId: id, kind: 'delete' });
    }
    try {
      // The per-run captured-output directory is still filesystem state.
      // Use rm -rf semantics so a non-empty directory is removed cleanly.
      await fs.rm(path.join(_runsDir(this.cwd), id), { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * List the ids of every persisted run, including runs whose state is invalid.
   *
   * Distinct from {@link list}, which validates each run and silently skips the
   * ones that fail. Callers that must see invalid runs in order to act on them —
   * `rundown prune` is the motivating case — need the raw ids.
   *
   * @returns All persisted run ids in ascending order.
   */
  async listRunIds(): Promise<readonly RunId[]> {
    const store = await this.store();
    return await store.listRunIds();
  }

  /**
   * Load every persisted run in the project, applying the same validation and
   * error taxonomy as a direct {@link load}.
   *
   * @returns All runbook states currently persisted for this project root.
   */
  async list(): Promise<RunbookState[]> {
    const store = await this.store();
    const ids = await store.listRunIds();
    const states: RunbookState[] = [];
    for (const id of ids) {
      try {
        // Route each row through `load` so listing applies the same validation
        // and error taxonomy as a direct read rather than a second, laxer path.
        const state = await this.load(id);
        if (state) states.push(state);
      } catch (err) {
        if (err instanceof InvalidRunbookStateError) {
          process.stderr.write(`[rundown] Warning: ${err.message}\n`);
        }
        // Other errors (invalid rows, legacy snapshots) — skip silently
      }
    }
    return states;
  }

  /**
   * Load session data from the shared SQLite store.
   *
   * @returns Validated session data, or the default empty session when the
   *   database has no session rows.
   * @throws {Error} When the reconstructed session is incompatible with the
   *   current schema.
   */
  async loadSession(): Promise<SessionData> {
    const store = await this.store();
    const session = await store.loadSession();
    // The store reconstructs the session from typed columns. An incompatible
    // database is rejected by schema version at open, not adapted per read.
    const result = SessionDataSchema.safeParse(session);
    if (!result.success) {
      throw new Error(
        'Session data is invalid for this runbook schema. Finish or prune active runbooks and restart.',
      );
    }
    return result.data;
  }

  /**
   * Load a single claim by key, tombstones included.
   *
   * {@link loadSession} surfaces only active claims. This is the read a caller
   * uses to tell a superseded bearer apart from an unknown one.
   *
   * @param key - Claim lookup key derived from the presented bearer.
   * @returns The claim and its status, or null when no row carries that key.
   */
  async loadClaim(key: ClaimLookupKey): Promise<PresentedClaim | null> {
    const store = await this.store();
    return store.loadClaim(key);
  }

  /**
   * Capture a run's current authority counters and state atomically.
   *
   * @param runId - Run whose bare controlling authority is required.
   * @returns Captured authority plus the exact state read with it, or a typed refusal.
   * @throws {Error} When persisted run state fails schema validation.
   */
  async captureRunAuthorityState(runId: RunId): Promise<CapturedRunStateResult> {
    const store = await this.store();
    return store.captureRunAuthorityState(runId);
  }

  /**
   * Persist session data.
   *
   * @remarks
   * The write is one short transaction, so a concurrent reader never observes a
   * partial session. It is still a wholesale replace: a caller that loads,
   * mutates, and saves can lose a concurrent writer's change. Callers doing
   * read-modify-write on session state should mutate inside a single store
   * transaction rather than round-tripping through load/save.
   *
   * @param session - The session data to write
   */
  async saveSession(session: SessionData): Promise<void> {
    const store = await this.store();
    await store.saveSession(session);
  }

  /**
   * Read-modify-write the session inside a single store transaction.
   *
   * The atomic replacement for `loadSession` -> mutate -> `saveSession`, which is
   * lossy under concurrency. Session mutations MUST use this: it is what makes the
   * workspace session lock unnecessary.
   *
   * `work` is synchronous by type ({@link SyncWork}): a transaction must never be
   * held across an `await`.
   *
   * @template T - Value the mutation returns to its caller.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The work's return value, once committed.
   */
  async mutateSession<T>(work: (ctx: SessionMutationTxn) => SyncWork<T>): Promise<T> {
    const store = await this.store();
    return store.mutateSession(work);
  }

  /**
   * {@link mutateSession} with typed execution-ownership refusals.
   *
   * Session mutations that can touch a run another process is executing use this
   * form, so an ownership refusal reaches the caller as a distinct result arm
   * rather than as a domain `null` or an opaque trigger-abort `Error`.
   *
   * @template T - Value the mutation returns to its caller.
   * @param runIds - Affected runs in deterministic refusal order, or a selector
   *   reading them off the session snapshot inside the transaction.
   * @param work - Mutates `ctx.session` in place and returns the caller's result.
   * @returns The committed value, or the first ownership refusal.
   */
  async mutateSessionGuarded<T>(
    runIds: readonly RunId[] | ((session: SessionData) => readonly RunId[]),
    work: (ctx: SessionMutationTxn) => SyncWork<T>,
  ): Promise<SessionMutationResult<T>> {
    const store = await this.store();
    return store.mutateSessionGuarded(runIds, work);
  }

  /**
   * Initialize substep tracking state for a runbook step.
   *
   * Creates SubstepState entries for all substeps with 'pending' status.
   * When `frameKey` is provided, entries from other frames are preserved
   * (append semantics for FOR loop iterations).
   *
   * @param id - The runbook state ID
   * @param substeps - The substep definitions from the step
   * @param frameKey - Frame key scoping these entries to a FOR iteration
   * @throws {Error} If the runbook with the given ID is not found
   */
  async initializeSubsteps(
    id: string,
    substeps: readonly Substep[],
    frameKey: FrameKey,
  ): Promise<void> {
    await this.mutate(
      id,
      (state) => {
        const existing = state.substepStates ?? [];
        const authoredIds = new Set(substeps.map((substep) => substep.id));
        const preserved = existing.filter(
          (substepState) => substepState.frameKey !== frameKey || authoredIds.has(substepState.id),
        );
        const existingSameFrameIds = new Set(
          preserved
            .filter((substepState) => substepState.frameKey === frameKey)
            .map((substepState) => substepState.id),
        );
        const initialized: SubstepState[] = substeps
          .filter((substep) => !existingSameFrameIds.has(substep.id))
          .map((substep) => ({ id: substep.id, frameKey, status: 'pending' }));

        return { substepStates: [...preserved, ...initialized] };
      },
      { missingIsError: true },
    );
  }

  /**
   * Update the FOR loop context for a runbook.
   *
   * FOR iteration advancement is owned by the core state machine. This method
   * exists for direct state repairs and tests; runtime execution should mutate
   * FOR context through actor-service sync.
   *
   * @internal
   * @param id - The runbook state ID
   * @param forStack - The updated FOR loop stack
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   */
  async updateForContext(id: string, forStack: ForContext[]): Promise<RunbookState> {
    const state = await this.mutate(
      id,
      (current) => {
        const snapshot = current.snapshot as Record<string, unknown> | undefined;
        const patchedSnapshot =
          snapshot && typeof snapshot === 'object' && 'context' in snapshot
            ? {
                ...snapshot,
                context: { ...(snapshot.context as Record<string, unknown>), forStack },
              }
            : snapshot;

        return { forStack, snapshot: patchedSnapshot };
      },
      { missingIsError: true },
    );
    if (state === null) {
      throw new Error(`Runbook ${id} not found`);
    }
    return state;
  }

  /**
   * Mark a substep as completed with a result.
   *
   * Updates the substep's status to 'done' and records the pass/fail result.
   *
   * @param runbookId - The runbook state ID
   * @param substepId - The substep ID to complete
   * @param result - The substep result ('pass' or 'fail')
   * @param frameKey - Frame key to scope the match
   * @throws {Error} If the runbook with the given ID is not found
   */
  async completeSubstep(
    runbookId: string,
    substepId: string,
    result: 'pass' | 'fail',
    frameKey: FrameKey,
  ): Promise<void> {
    await this.mutate(
      runbookId,
      (state) => {
        const substepStates = state.substepStates ?? [];
        const updated = substepStates.map((s) =>
          s.id === substepId && s.frameKey === frameKey
            ? { ...s, status: 'done' as const, result }
            : s,
        );

        return { substepStates: updated };
      },
      { missingIsError: true },
    );
  }
}
