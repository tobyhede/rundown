// src/runbook/state.ts
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { FrameKey } from './targeting.js';
import type {
  RunbookState,
  Substep,
  SubstepState,
  Runbook,
  ResolvedRunbook,
  TemplateVarValue,
} from './types.js';
import {
  applyOp,
  type FrameEntryCountsOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
import type { RunbookRef } from './runbook-ref.js';
import type { SecretHash } from './run-secrets.js';
import type { ChildLinkage } from './child-linkage.js';
import { findUnsupportedComposition, RunbookCompositionUnsupportedError } from './run-authority.js';
import { isNodeError } from '../errors.js';
import { logger } from '../logger.js';
import {
  brandInitialTemplateVars,
  brandStoredOutputs,
  isTrustedArtifactValue,
  type VariableValue,
} from './effective-vars.js';
import { isArtifactRecord } from './artifact-schema.js';
import { assertRunId, generateRunId, type RunId } from './run-id.js';
import { runsDir as _runsDir, assertSafeId } from '../paths.js';
import { getRunbookStore } from './storage/store-registry.js';
import type {
  AcquireExecutionLeaseResult,
  ClaimDelegationChildResult,
  DeleteRunResult,
  RunAtVersion,
  RunbookStore,
  RunWriteAtVersion,
  SaveRunResult,
  SaveRunsResult,
  VersionedRunState,
} from './storage/runbook-store.js';
import type { ExecutionLease, ExecutionLeaseHolder } from './execution-lease.js';
import type { StateVersion } from './storage/mutation-result.js';
import type { OpenRunbookDriverOptions } from './storage/driver-factory.js';
import {
  assertCurrentSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  InvalidRunbookStateError,
  LegacySnapshotError,
} from './persisted-state-guards.js';

// Re-exported from their leaf module so this file stays the import site every
// existing consumer already names, while `storage/runbook-store.ts` can reach
// the same gates without closing an import cycle back through this module.
export { CURRENT_SCHEMA_VERSION, InvalidRunbookStateError, LegacySnapshotError };

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

/**
 * Thrown when a run-state write found the row's `state_version` moved since
 * the caller read it.
 *
 * This is the throwing face of {@link SaveRunResult}'s `concurrent_modification`
 * arm. Under one writer per run (ADR 0005) it means two of the owner's own
 * commands raced on the same run. The write is refused once — nothing was
 * written, the persisted state is intact — and it is never retried on the
 * caller's behalf: a second command landing silently behind the first is the
 * confusion the refusal exists to make visible. The CLI reports it as RD-308 /
 * `CONCURRENT_MODIFICATION`.
 *
 * {@link retryable} is `true` as a literal type because the persisted state is
 * consistent and the same command, re-issued by the operator after reading the
 * refusal, is expected to succeed. That is a statement about the state, not an
 * instruction to any caller to loop.
 */
export class ConcurrentStateModificationError extends Error {
  /**
   * The run whose state write was refused.
   *
   * The run id is not recoverable from the message without parsing it.
   */
  readonly runId: string;

  /**
   * Always `true`, as a literal type.
   *
   * The discriminant that separates this from the refusals that share its
   * throwing seam (a missing run), where re-issuing the command is pointless.
   */
  readonly retryable = true as const;

  /**
   * Create a new ConcurrentStateModificationError.
   *
   * @param runId - The run whose state write was refused.
   * @param message - Description of the refused write.
   */
  constructor(runId: string, message: string) {
    super(message);
    this.name = 'ConcurrentStateModificationError';
    this.runId = runId;
  }
}

/**
 * Raised when a write that is not a decision about the execution lease meets a
 * run whose lease is held.
 *
 * Only the owner's decision (`pass`/`fail`/`goto`/`stop`/`complete`, through
 * the lifecycle seam's lease rule) or the attempt's own finish may clear a
 * lease. Any other read-derive-save on a leased run is refused before anything
 * is written: clearing the lease there would erase an Interrupted marker
 * without the explicit decision the lease rule demands.
 */
export class ExecutionLeaseHeldError extends Error {
  /** The run whose lease is held. */
  readonly runId: RunId;
  /** The held lease. */
  readonly lease: ExecutionLease;

  /**
   * Construct the refusal.
   *
   * @param runId - The run whose lease is held.
   * @param lease - The held lease.
   */
  constructor(runId: RunId, lease: ExecutionLease) {
    super(
      `Run ${runId} holds an execution lease (attempt ${String(lease.attempt)}, process ${String(lease.pid)}, started ${lease.startedAt}); only the owner's decision or the attempt's finish may write it. Nothing was written.`,
    );
    this.name = 'ExecutionLeaseHeldError';
    this.runId = runId;
    this.lease = lease;
  }
}

/**
 * Narrow an unknown thrown value to {@link ConcurrentStateModificationError}.
 *
 * Provided so a consumer that catches from a different realm — or that only has
 * the value typed as `unknown` — can classify the refusal without an
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

// Re-exported from its leaf module, the import site every consumer names.
export { generateRunId };

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
    | 'frameEntryCounts'
  >
> & {
  /** Merge or replace persisted runtime variables. */
  readonly variables?: VariablesOp;
  /** Replace initial template variables. */
  readonly templateVars?: TemplateVarsOp;
  /** Replace per-frame entry counters. */
  readonly frameEntryCounts?: FrameEntryCountsOp;
};

/**
 * Apply a {@link RunbookStateUpdate} patch to a state value, purely.
 *
 * The single application of tagged merge/replace ops, artifact trust
 * re-assertion, and the {@link CURRENT_SCHEMA_VERSION} stamp. Shared by
 * {@link RunbookStateManager.update} and by the actor compute/commit seam, which
 * derives the next state without persisting, so both apply identical patch
 * semantics. `updatedAt` is stamped by each caller, so compare states modulo
 * `updatedAt`.
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
  // and launder a state `load` refuses into one it accepts.
  assertCurrentSchemaVersion(existing.schemaVersion, existing.id);
  // Pull tagged-op fields out of updates so the subsequent `...updates` spread
  // does not leak the wrapper shapes into the strictly-typed RunbookState literal.
  const {
    variables: variablesOp,
    templateVars: templateVarsOp,
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
    ...(frameEntryCountsOp !== undefined ? { frameEntryCounts: frameEntryCountsOp.value } : {}),
    // Stamp the current model version on the newly derived state. Not a
    // migration: the derived state IS the current model, and `existing` has
    // already been validated (`load` rejects any other version).
    schemaVersion: CURRENT_SCHEMA_VERSION,
    updatedAt: now,
  };
}

/** Options accepted by {@link RunbookStateManager.create}. */
export interface CreateOptions {
  /** Repo-relative resolved runbook file path recorded on the state. */
  readonly runbookPath: string;
  /**
   * Hash of the Owner Token minted for this run.
   *
   * The caller mints the token (`generateOwnerToken`), prints it once on
   * `runbook_started`, and hands only its hash here. The store never sees the
   * plaintext.
   */
  readonly ownerTokenHash: SecretHash;
  /** Explicit run id; defaults to a freshly generated one. */
  readonly runId?: RunId;
  /** Whether the run announces its commands rather than executing them. */
  readonly prompted?: boolean;
  /** Runbook source content, frozen at run time. */
  readonly runbookSrc?: string;
  /** Optional record of template variable replacements to populate placeholders at run time. */
  readonly templateVars?: Record<string, TemplateVarValue>;
  /** Optional runtime variables to seed into RunbookState.variables at creation. */
  readonly initialVariables?: Readonly<Record<string, VariableValue>>;
  /** Frontmatter `outputs:` declarations seeded into the compiled machine for OUTPUTS evaluation. */
  readonly frontmatterOutputs?: readonly OutputDeclaration[];
}

/**
 * Options accepted by {@link RunbookStateManager.createInlineChild}.
 *
 * Everything {@link CreateOptions} carries except the Owner Token hash — an
 * Inline Child has no token of its own (#903) — plus the preallocated id its
 * parent reserved and the linkage naming that reservation.
 */
export interface CreateInlineChildOptions extends Omit<CreateOptions, 'ownerTokenHash' | 'runId'> {
  /** The child run id the parent's reservation preallocated. */
  readonly runId: RunId;
  /** The parent coordinate; its `kind` is `inline`. */
  readonly linkage: ChildLinkage;
}

/**
 * Options accepted by {@link RunbookStateManager.claimDelegationChild}.
 *
 * Everything {@link CreateOptions} carries, plus the preallocated id the
 * parent's reservation names and the linkage naming that reservation. A
 * Delegation carries its own Owner Token, unlike an Inline Child.
 */
export interface ClaimDelegationChildOptions extends Omit<CreateOptions, 'runId'> {
  /** The child run id the parent's reservation preallocated. */
  readonly runId: RunId;
  /** The parent coordinate; its `kind` is `delegation`. */
  readonly linkage: ChildLinkage;
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
 * Stamp a state for persistence: the current schema version and a fresh
 * `updatedAt`.
 *
 * @param state - The state to persist.
 * @returns The stamped state.
 */
function stampForSave(state: RunbookState): RunbookState {
  return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
}

/**
 * Build the initial state of a new run, applying the composition refusal.
 *
 * `templateVars` is always written — `{}` when the caller supplies none — and
 * so is `prompted` (`false` when the caller names no mode), because `load`
 * refuses a persisted row without either.
 *
 * @param runbookRef - Canonical runbook identity
 * @param runbook - The parsed runbook definition
 * @param id - The run id
 * @param options - Path, prompted flag, source and variables
 * @returns The initial state, not yet persisted
 * @throws {RunbookCompositionUnsupportedError} When a substep lists more than
 *   one runbook: the machine reserves one Current Child per substep.
 */
function initialRunState(
  runbookRef: RunbookRef,
  runbook: Runbook | ResolvedRunbook,
  id: RunId,
  options: Omit<CreateOptions, 'ownerTokenHash' | 'runId'>,
): RunbookState {
  // Refused here, below the seam every run — inline children included — is
  // created through, rather than by each frontend.
  const composing = findUnsupportedComposition(runbook.steps);
  if (composing.length > 0) {
    throw new RunbookCompositionUnsupportedError(composing);
  }
  const now = new Date().toISOString();
  const initialStep = runbook.steps[0];
  return {
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
    frameEntryCounts: {},
    startedAt: now,
    updatedAt: now,
    prompted: options.prompted ?? false,
    runbookSrc: options.runbookSrc,
    templateVars: brandInitialTemplateVars(options.templateVars ?? {}),
    frontmatterOutputs: options.frontmatterOutputs ?? [],
    lifecycle: 'running',
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

/**
 * Substep tracking for one frame: a `pending` entry for every authored substep
 * the frame does not track yet.
 *
 * Entries from other frames are preserved (append semantics for FOR loop
 * iterations), existing same-frame entries for still-authored substeps keep
 * their state, and same-frame entries for substeps no longer authored drop.
 *
 * @param existing - The run's substep states.
 * @param substeps - The substep definitions from the step.
 * @param frameKey - Frame key scoping these entries to a FOR iteration.
 * @returns The substep states with the frame initialised.
 */
export function initializeSubstepStates(
  existing: readonly SubstepState[],
  substeps: readonly Substep[],
  frameKey: FrameKey,
): SubstepState[] {
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
  return [...preserved, ...initialized];
}

/**
 * Record a committed state write on the lifecycle diagnostic trail.
 *
 * Enable with RUNDOWN_LOG_LEVEL=debug; the logger stamps pid (#536 was found
 * with this signal).
 *
 * @param state - The committed state.
 */
function logLifecycleWrite(state: RunbookState): void {
  if (state.lifecycle !== undefined) {
    void logger.debug('lifecycle-write', { runId: state.id, next: state.lifecycle });
  }
}

/**
 * Manager for runbook state persistence and lifecycle.
 *
 * A thin async facade over {@link RunbookStore}: creating, loading, saving and
 * patching run state in the project's shared SQLite store. Every write is one
 * conditional save against the `state_version` the caller read; a mismatch is
 * refused as {@link ConcurrentStateModificationError} and never retried.
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
   * Rejects traversal-unsafe ids. A safe but non-canonical id cannot name a
   * run, so it resolves to `null` — the caller treats that as "genuinely
   * missing".
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
   * Create a new runbook state and insert it as a row in the project's store.
   *
   * `templateVars` is always written — `{}` when the caller supplies none — and
   * so is `prompted` (`false` when the caller names no mode), because {@link load}
   * refuses a persisted row without either.
   *
   * @param runbookRef - Canonical runbook identity
   * @param runbook - The parsed runbook definition
   * @param options - Owner token hash, run identity, prompted flag, variables
   * @returns The newly created RunbookState
   * @throws {RunbookCompositionUnsupportedError} When a substep lists more
   *   than one runbook. Raised before any store access, so no run row is
   *   written.
   * @throws {StoreInvariantError} When a run already carries the id or the
   *   owner token hash.
   */
  async create(
    runbookRef: RunbookRef,
    runbook: Runbook | ResolvedRunbook,
    options: CreateOptions,
  ): Promise<RunbookState> {
    const state = initialRunState(runbookRef, runbook, options.runId ?? generateRunId(), options);
    const store = await this.store();
    await store.createRun(state, options.ownerTokenHash);
    void logger.debug('lifecycle-write', { runId: state.id, next: 'running' });
    return state;
  }

  /**
   * Create an Inline Child (#903) under the id its parent reserved.
   *
   * The parent owner's command creates the child row; the row records its
   * linkage and carries no Owner Token hash, because the parent's token
   * authorizes it. The same composition refusal as {@link create} applies.
   *
   * The row lands already initialised, in one write: `initialize` derives the
   * child's initialised state (its machine snapshot, active substeps) from the
   * draft in memory, and only its result is inserted. A launch therefore either
   * creates a child its owner can drive or writes nothing — there is no row
   * without a machine.
   *
   * @param runbookRef - Canonical identity of the child runbook
   * @param runbook - The parsed child runbook definition
   * @param options - Preallocated id, linkage, prompted flag and variables
   * @param initialize - Derives the initialised state from the draft without
   *   persisting it (`RunbookActorService.deriveInitialState` in production)
   * @returns The newly created child state
   * @throws {RunbookCompositionUnsupportedError} When a substep of the child
   *   runbook lists more than one runbook. No row is written.
   * @throws {Error} Whatever `initialize` throws (a machine that cannot be
   *   compiled, say), or when it returns a different run. No row is written.
   * @throws {StoreInvariantError} When a run already carries the id.
   */
  async createInlineChild(
    runbookRef: RunbookRef,
    runbook: Runbook | ResolvedRunbook,
    options: CreateInlineChildOptions,
    initialize: (draft: RunbookState) => Promise<RunbookState>,
  ): Promise<RunbookState> {
    const draft = initialRunState(runbookRef, runbook, options.runId, options);
    const state = await initialize(draft);
    if (state.id !== draft.id) {
      throw new Error(`Inline child ${draft.id} was initialised as run ${state.id}`);
    }
    const store = await this.store();
    await store.createInlineChildRun(state, options.linkage);
    void logger.debug('lifecycle-write', { runId: state.id, next: 'running' });
    return state;
  }

  /**
   * Claim a Delegation (#904): create its row under the id its parent reserved,
   * if — in the same transaction — `verify` finds the reservation still
   * claimable on the parent as read there.
   *
   * The row lands already initialised, in one write, exactly as
   * {@link createInlineChild}'s does; a second claim of the same reservation
   * is refused by the row's primary key.
   *
   * @template R - The caller's refusal type.
   * @param runbookRef - Canonical identity of the child runbook
   * @param runbook - The parsed child runbook definition
   * @param options - Preallocated id, linkage, owner token hash and variables
   * @param initialize - Derives the initialised state from the draft without
   *   persisting it (`RunbookActorService.deriveInitialState` in production)
   * @param verify - Decides, on the parent read inside the claim's transaction,
   *   whether the reservation may still be claimed
   * @returns `claimed`, `already_claimed`, or `verify`'s refusal
   * @throws {RunbookCompositionUnsupportedError} When the child runbook
   *   composes in a form this build does not run. No row is written.
   * @throws {Error} Whatever `initialize` throws, or when it returns a
   *   different run. No row is written.
   */
  async claimDelegationChild<R>(
    runbookRef: RunbookRef,
    runbook: Runbook | ResolvedRunbook,
    options: ClaimDelegationChildOptions,
    initialize: (draft: RunbookState) => Promise<RunbookState>,
    verify: (parent: VersionedRunState | null) => R | undefined,
  ): Promise<ClaimDelegationChildResult<R> & { readonly state: RunbookState }> {
    const draft = initialRunState(runbookRef, runbook, options.runId, options);
    const state = await initialize(draft);
    if (state.id !== draft.id) {
      throw new Error(`Delegation ${draft.id} was initialised as run ${state.id}`);
    }
    const store = await this.store();
    const claimed = await store.claimDelegationChild({
      parentRunId: options.linkage.parentRunId,
      verify,
      state,
      ownerTokenHash: options.ownerTokenHash,
      linkage: options.linkage,
    });
    if (claimed.kind === 'claimed') {
      void logger.debug('lifecycle-write', { runId: state.id, next: 'running' });
    }
    return { ...claimed, state };
  }

  /**
   * Read a runbook state back from the project's store by ID.
   *
   * Returns `null` when a traversal-safe id has no matching record, which also
   * covers a safe id that cannot name a run at all. Anything else is invalid
   * persisted state and is refused rather than adapted: there is no migration
   * path, and the caller's recovery is always to finish, stop, prune, or
   * restart the run.
   *
   * @param id - The runbook state ID (e.g., 'rd_0123456789abcdef0123456789abcdef')
   * @returns The loaded RunbookState, or null when a traversal-safe `id` has no record
   * @throws {Error} If `id` is traversal-unsafe — rejected before any store access
   * @throws {InvalidRunbookStateError} If the record exists but its `state_json`
   *   is unparseable, fails schema validation, has an incompatible schemaVersion,
   *   or is missing `templateVars` or `prompted`
   * @throws {LegacySnapshotError} If the runbook state uses deprecated dynamic-step snapshots
   */
  async load(id: string): Promise<RunbookState | null> {
    const runId = this.toRunId(id);
    if (runId === null) {
      return null; // Not a run identifier — genuinely missing.
    }
    // The store's row assembly and gates are the one validation every reader
    // shares: unparseable JSON, legacy snapshots, foreign schema versions, the
    // required fields no reader may default, and the structural parse.
    const store = await this.store();
    return store.loadRun(runId);
  }

  /**
   * Read a runbook state together with the `state_version` it was read at.
   *
   * The read half of a read-derive-save span: hand the returned version to
   * {@link save} and the write lands only if nobody wrote the run in between.
   *
   * @param id - The runbook state ID
   * @returns The state and its version, or null when the run does not exist
   * @throws {Error} If `id` is traversal-unsafe
   * @throws {InvalidRunbookStateError} If the record fails the persisted-state
   *   gates or the structural parse
   * @throws {LegacySnapshotError} If the record uses deprecated dynamic-step snapshots
   */
  async loadWithVersion(id: string): Promise<VersionedRunState | null> {
    const runId = this.toRunId(id);
    if (runId === null) {
      return null;
    }
    const store = await this.store();
    return store.loadRunWithVersion(runId);
  }

  /**
   * Resolve an Owner Token hash to the run it owns.
   *
   * The sole authority lookup for mutating commands: a run id authorizes
   * nothing. Resolves finished runs too, so a late command on one can be told
   * that it finished.
   *
   * @param ownerTokenHash - Hash of the presented Owner Token
   * @returns The owned run and its version, or null when no run carries the hash
   * @throws {InvalidRunbookStateError} If the matching record fails the
   *   persisted-state gates or the structural parse
   * @throws {LegacySnapshotError} If the matching record uses deprecated snapshots
   */
  async findByOwnerTokenHash(ownerTokenHash: SecretHash): Promise<VersionedRunState | null> {
    const store = await this.store();
    return store.findRunByOwnerTokenHash(ownerTokenHash);
  }

  /**
   * Find the run that issued a Claim Ticket, by the ticket's hash (#904).
   *
   * Reads only the runs whose persisted state records the hash, so a claim
   * neither validates nor warns about any other run in the project.
   *
   * @param ticketHash - Hash of the presented Claim Ticket
   * @returns Every run recording the hash, validated (at most one in practice)
   * @throws {InvalidRunbookStateError} If a matching record fails the
   *   persisted-state gates or the structural parse
   * @throws {LegacySnapshotError} If a matching record uses deprecated snapshots
   */
  async findByTicketHash(ticketHash: SecretHash): Promise<readonly VersionedRunState[]> {
    const store = await this.store();
    return store.findRunsByTicketHash(ticketHash);
  }

  /**
   * Set a run's execution lease immediately before an external effect (#902).
   *
   * One conditional update; see `RunbookStore.acquireExecutionLease`. The
   * effect must not start unless this returns `acquired`, and its finish must
   * be saved at the returned `stateVersion`.
   *
   * @param runId - Run whose effect is about to start
   * @param expectedVersion - The version the caller read the run at
   * @param holder - The process starting the effect
   * @returns The acquired lease and its version, or why it was not set
   */
  async acquireExecutionLease(
    runId: RunId,
    expectedVersion: StateVersion,
    holder: ExecutionLeaseHolder,
  ): Promise<AcquireExecutionLeaseResult> {
    const store = await this.store();
    return store.acquireExecutionLease(runId, expectedVersion, holder);
  }

  /**
   * Persist the owner's decision about a run, or a leased attempt's finish, if
   * and only if its row is still at `expectedVersion`.
   *
   * Stamps the current schema version and a fresh `updatedAt`. One conditional
   * write, one outcome: the caller narrows the result and renders the refusal.
   * This is the one manager write that clears the execution lease
   * `expectedVersion` carries, so only a seam that has decided about that lease
   * may call it: the lifecycle seam after applying the lease rule, and Run
   * Progression's commit of a finish at the version its own lease produced.
   * Every other write goes through {@link update} / {@link mutate}, which refuse
   * a leased run.
   *
   * @param state - The complete state to persist
   * @param expectedVersion - The version the caller read the run at
   * @returns `committed` with the persisted state, or a typed refusal
   * @throws {StoreInvariantError} When `state.id` is not a canonical run id
   */
  async save(state: RunbookState, expectedVersion: StateVersion): Promise<SaveRunResult> {
    const store = await this.store();
    const updated = stampForSave(state);
    const result = await store.saveRunResolvingLease(state.id, expectedVersion, updated);
    if (result.kind === 'committed') logLifecycleWrite(updated);
    return result;
  }

  /**
   * Persist several runs that one decision ends together, all or nothing, each
   * at the version the caller read it at (`RunbookStore.saveRunsResolvingLeases`).
   *
   * Stamps each state as {@link save} does, and clears the execution lease each
   * version carries, so only a seam that decided about every one of those
   * leases may call it. A version that moved refuses the whole write; it is
   * never retried.
   *
   * @param writes - Each run's complete next state with the version it was read at
   * @returns `committed` with every persisted state, or the first refusal
   */
  async saveRuns(writes: readonly RunWriteAtVersion[]): Promise<SaveRunsResult> {
    const store = await this.store();
    const stamped = writes.map((write) => ({ ...write, state: stampForSave(write.state) }));
    const result = await store.saveRunsResolvingLeases(stamped);
    if (result.kind === 'committed') {
      for (const write of stamped) logLifecycleWrite(write.state);
    }
    return result;
  }

  /**
   * Update an existing runbook state with partial changes.
   *
   * Per-field semantics:
   * - `variables` — `merge(...)` shallow-merges values (merge-only). Accepts
   *   strings (OUTPUTS), `ArtifactRecord` (exact ARTIFACT), and
   *   `readonly ArtifactRecord[]` (wildcard ARTIFACT).
   * - `templateVars` — `replace(...)` wholesale-replaces (replace-only; seeded once)
   * - `frameEntryCounts` — `replace(...)` wholesale-replaces (replace-only)
   * - All other fields — provided value is taken verbatim; omitted fields are preserved
   *
   * One read, one derivation, one conditional save. A version that moved in
   * between is refused, not retried.
   *
   * @param id - The runbook state ID to update
   * @param updates - Partial state updates with tagged ops on record-shaped fields
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {ConcurrentStateModificationError} If another write landed between
   *   the read and the save
   * @throws {ExecutionLeaseHeldError} If the run holds an execution lease
   */
  async update(id: string, updates: RunbookStateUpdate): Promise<RunbookState> {
    return this.mutate(id, () => updates);
  }

  /**
   * Derive a patch from the current state and persist it, in one
   * read-derive-save cycle.
   *
   * The builder runs exactly once, against the state read at the start of the
   * cycle. Returning `null` leaves the run unchanged and writes nothing. A
   * `state_version` that moved between the read and the save is refused as
   * {@link ConcurrentStateModificationError}; the builder is not re-run.
   *
   * This is not a decision about the execution lease, so a leased run is
   * refused {@link ExecutionLeaseHeldError} before the builder runs, and the
   * save never clears a lease.
   *
   * @param id - The runbook state ID to mutate
   * @param build - Derives the patch from the current state; `null` means leave the state alone
   * @returns The resulting state (the current state when the builder declined)
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {ConcurrentStateModificationError} If another write landed between
   *   the read and the save
   * @throws {ExecutionLeaseHeldError} If the run holds an execution lease
   */
  async mutate(
    id: string,
    build: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
  ): Promise<RunbookState> {
    const current = await this.loadWithVersion(id);
    if (current === null) {
      throw new Error(`Runbook ${id} not found`);
    }
    if (current.lease !== null) {
      throw new ExecutionLeaseHeldError(current.state.id, current.lease);
    }
    const updates = await build(current.state);
    if (updates === null) {
      return current.state;
    }
    const next = stampForSave(
      applyRunbookStateUpdate(current.state, updates, new Date().toISOString()),
    );
    const store = await this.store();
    const result = await store.saveRun(next.id, current.stateVersion, next);
    switch (result.kind) {
      case 'committed':
        logLifecycleWrite(next);
        return result.state;
      case 'missing':
        throw new Error(`Runbook ${id} not found`);
      case 'concurrent_modification':
        throw new ConcurrentStateModificationError(
          id,
          `Run ${id} was modified concurrently by another writer.`,
        );
      case 'execution_leased':
        throw new ExecutionLeaseHeldError(next.id, result.lease);
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
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
      await store.deleteRun(runId);
      // Logged immediately after the row is confirmed removed — and before the
      // outputs-dir cleanup below — so a later `fs.rm` failure cannot suppress
      // the trail of a deletion that actually committed.
      void logger.debug('lifecycle-write', { runId: id, kind: 'delete' });
    }
    await this.removeOutputsDir(id);
  }

  /**
   * Delete a persisted run, and then its per-run outputs directory, if and
   * only if its row is still at the version the caller read it at.
   *
   * For a caller that decided about the run it read — `prune --token` applies
   * the execution-lease rule to the lease that version carries — so a lease
   * taken after that read refuses the delete instead of being discarded with
   * the run. The run's Inline Children go with it (#903), so the delete is
   * conditional on each of them too: the caller names every inline
   * descendant it read, at the version it read it, and decided about their
   * leases as well. Nothing is removed on a refusal, outputs included.
   *
   * @param id - The run to delete
   * @param expectedVersion - The version the caller read the run at
   * @param expectedInlineDescendants - Every inline descendant the caller read,
   *   at the version it read it (`inlineDescendantsOf` in `run-deletion.ts`)
   * @returns `deleted`, or why nothing was deleted (`concurrent_modification`,
   *   `missing`)
   * @throws {Error} If `id` is traversal-unsafe, or when removing an outputs
   *   directory fails for a reason other than its absence
   */
  async deleteAtVersion(
    id: string,
    expectedVersion: StateVersion,
    expectedInlineDescendants: readonly RunAtVersion[],
  ): Promise<DeleteRunResult> {
    const runId = this.toRunId(id);
    if (runId === null) return { kind: 'missing' };
    const store = await this.store();
    const result = await store.deleteRunAtVersion(
      runId,
      expectedVersion,
      expectedInlineDescendants,
    );
    if (result.kind !== 'deleted') return result;
    void logger.debug('lifecycle-write', { runId: id, kind: 'delete' });
    await this.removeOutputsDir(id);
    for (const descendant of expectedInlineDescendants) {
      await this.removeOutputsDir(descendant.runId);
    }
    return result;
  }

  /**
   * Remove a run's captured-output directory, `.rundown/runs/<id>/`, if any.
   *
   * @param id - The run whose outputs directory to remove
   * @throws {Error} When removal fails for a reason other than absence
   */
  private async removeOutputsDir(id: string): Promise<void> {
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
   * An invalid run is skipped, with a warning on stderr when it is
   * `InvalidRunbookStateError`.
   *
   * @returns All valid runbook states currently persisted for this project root.
   */
  async list(): Promise<RunbookState[]> {
    return (await this.listWithVersion()).map((run) => run.state);
  }

  /**
   * Load every valid persisted run with the version and execution lease it was
   * read at, all from one read.
   *
   * Same validation and skipping as {@link list}; the lease rides the listing
   * read, so a caller rendering leases never pairs a run with a lease from a
   * different snapshot.
   *
   * @returns Every valid run with its version and lease, in ascending id order.
   */
  async listWithVersion(): Promise<VersionedRunState[]> {
    const store = await this.store();
    const runs: VersionedRunState[] = [];
    for (const listed of await store.listRunsWithVersion()) {
      if (listed.kind === 'valid') {
        runs.push(listed.run);
      } else if (listed.error instanceof InvalidRunbookStateError) {
        process.stderr.write(`[rundown] Warning: ${listed.error.message}\n`);
      }
      // Other errors (legacy snapshots, unknown lifecycle) — skip silently.
    }
    return runs;
  }

  /**
   * Initialize substep tracking state for a runbook step.
   *
   * Creates SubstepState entries for all substeps with 'pending' status.
   * Entries from other frames are preserved (append semantics for FOR loop
   * iterations), and existing same-frame entries for still-authored substeps
   * keep their state.
   *
   * @param id - The runbook state ID
   * @param substeps - The substep definitions from the step
   * @param frameKey - Frame key scoping these entries to a FOR iteration
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {ConcurrentStateModificationError} If another write landed between
   *   the read and the save
   */
  async initializeSubsteps(
    id: string,
    substeps: readonly Substep[],
    frameKey: FrameKey,
  ): Promise<void> {
    await this.mutate(id, (state) => ({
      substepStates: initializeSubstepStates(state.substepStates ?? [], substeps, frameKey),
    }));
  }
}
