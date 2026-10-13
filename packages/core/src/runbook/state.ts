// src/runbook/state.ts
import { randomBytes } from 'node:crypto';
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
import { findUnsupportedComposition, RunbookCompositionUnsupportedError } from './run-authority.js';
import { makeRunbookStateSchema } from '../schemas.js';
import { isError, isNodeError } from '../errors.js';
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
import type {
  AcquireExecutionLeaseResult,
  RunbookStore,
  SaveRunResult,
  VersionedRunState,
} from './storage/runbook-store.js';
import type { ExecutionLease, ExecutionLeaseHolder } from './execution-lease.js';
import type { StateVersion } from './storage/mutation-result.js';
import type { OpenRunbookDriverOptions } from './storage/driver-factory.js';
import {
  assertCurrentSchemaVersion,
  assertLoadablePersistedRun,
  parsePersistedRunState,
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

/**
 * Generate a concrete Rundown run identifier.
 *
 * @returns Run ID in canonical `rd_<32 lowercase hex>` form
 */
export function generateRunId(): RunId {
  return assertRunId(`${RUN_ID_PREFIX}${randomBytes(16).toString('hex')}`);
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
   * @throws {RunbookCompositionUnsupportedError} When the runbook composes
   *   other runbooks (a `DELEGATE` or runbook-list substep). Raised before any
   *   store access, so no run row is written.
   * @throws {StoreInvariantError} When a run already carries the id or the
   *   owner token hash.
   */
  async create(
    runbookRef: RunbookRef,
    runbook: Runbook | ResolvedRunbook,
    options: CreateOptions,
  ): Promise<RunbookState> {
    // The compiled machine has no state for a composing substep, so no run of
    // one may exist. Refused here, the seam every run is created through,
    // rather than by each frontend.
    const composing = findUnsupportedComposition(runbook.steps);
    if (composing.length > 0) {
      throw new RunbookCompositionUnsupportedError(composing);
    }

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
      frameEntryCounts: {},
      startedAt: now,
      updatedAt: now,
      // Always written, `false` when the caller names no mode: `load` refuses a
      // persisted row without `prompted` rather than defaulting one.
      prompted: options.prompted ?? false,
      runbookSrc: options.runbookSrc,
      // Always written, `{}` when the caller supplies none: `load` refuses a
      // persisted row without templateVars rather than reconstructing it.
      templateVars: brandInitialTemplateVars(options.templateVars ?? {}),
      frontmatterOutputs: options.frontmatterOutputs ?? [],
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    const store = await this.store();
    await store.createRun(state, options.ownerTokenHash);
    void logger.debug('lifecycle-write', { runId: id, next: 'running' });
    return state;
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

    // Legacy dynamic-step snapshots, foreign schema versions, and the two
    // required fields no reader may default, in that order. Shared with
    // `RunbookStore.readRun` so both readers refuse the same shapes with the
    // same message.
    assertLoadablePersistedRun(raw, id);
    return parsePersistedRunState(raw, id, makeRunbookStateSchema(this.cwd));
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
   * List the execution lease of every run that holds one, for status.
   *
   * @returns Each leased run's lease, keyed by run id
   */
  async listExecutionLeases(): Promise<ReadonlyMap<RunId, ExecutionLease>> {
    const store = await this.store();
    return store.listExecutionLeases();
  }

  /**
   * Persist a complete runbook state if and only if its row is still at
   * `expectedVersion`.
   *
   * Stamps the current schema version and a fresh `updatedAt`. One conditional
   * write, one outcome: the caller narrows the result and renders the refusal.
   * The write clears the execution lease `expectedVersion` carries, so a seam
   * that saves has already applied the lease rule to what it read.
   * For the throwing form see {@link update} and {@link mutate}.
   *
   * @param state - The complete state to persist
   * @param expectedVersion - The version the caller read the run at
   * @returns `committed` with the persisted state, or a typed refusal
   * @throws {StoreInvariantError} When `state.id` is not a canonical run id
   */
  async save(state: RunbookState, expectedVersion: StateVersion): Promise<SaveRunResult> {
    const store = await this.store();
    const updated: RunbookState = {
      ...state,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const result = await store.saveRun(state.id, expectedVersion, updated);
    if (result.kind === 'committed' && updated.lifecycle !== undefined) {
      // Diagnostic trail for lifecycle transitions (#536 was found with this
      // signal). Enable with RUNDOWN_LOG_LEVEL=debug; the logger stamps pid.
      void logger.debug('lifecycle-write', { runId: state.id, next: updated.lifecycle });
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
   * @param id - The runbook state ID to mutate
   * @param build - Derives the patch from the current state; `null` means leave the state alone
   * @returns The resulting state (the current state when the builder declined)
   * @throws {Error} If the runbook with the given ID is not found
   * @throws {ConcurrentStateModificationError} If another write landed between
   *   the read and the save
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
    const updates = await build(current.state);
    if (updates === null) {
      return current.state;
    }
    const next = applyRunbookStateUpdate(current.state, updates, new Date().toISOString());
    const result = await this.save(next, current.stateVersion);
    switch (result.kind) {
      case 'committed':
        return result.state;
      case 'missing':
        throw new Error(`Runbook ${id} not found`);
      case 'concurrent_modification':
        throw new ConcurrentStateModificationError(
          id,
          `Run ${id} was modified concurrently by another writer.`,
        );
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
    await this.mutate(id, (state) => {
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
    });
  }
}
