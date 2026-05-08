// src/runbook/state.ts
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ArtifactDeclaration, OutputDeclaration } from '@rundown-org/parser';
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
  ArtifactVarValue,
} from './types.js';
import {
  applyOp,
  merge,
  type ArtifactVarsOp,
  type FrameEntriesOp,
  type ResolvedCompletionsOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
import {
  resolveArtifactDeclarations,
  type ArtifactRunEligibility,
} from './artifact-directive-resolver.js';
import type { ClaimRecord } from './claim-id.js';
import type { RunbookRef } from './runbook-ref.js';
import { makeRunbookStateSchema, SessionDataSchema } from '../schemas.js';
import { isNodeError } from '../errors.js';
import { logger } from '../logger.js';
import {
  brandArtifactVars,
  brandInitialTemplateVars,
  brandStoredOutputs,
} from './effective-vars.js';
import { assertRunId, RUN_ID_PREFIX, type RunId } from './run-id.js';
import {
  runsDir as _runsDir,
  sessionPath as _sessionPath,
  statePath as _statePath,
  LEGACY_SESSION_FILE,
} from '../paths.js';

/** Current persisted state schema version. Bump whenever RunbookState shape changes incompatibly. */
const CURRENT_SCHEMA_VERSION = 3;

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

/**
 * Thrown when a persisted state file was written by an older schema version.
 * Callers should surface this to the user with a prompt to run `rd prune --all`.
 */
export class StaleRunbookStateError extends Error {
  /**
   * Create a new StaleRunbookStateError.
   *
   * @param message - Human-readable description of why the state is stale
   */
  constructor(message: string) {
    super(message);
    this.name = 'StaleRunbookStateError';
  }
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

interface CreateOptions {
  readonly runbookPath: string;
  readonly runId?: RunId;
  readonly prompted?: boolean;
  /** Parent linkage when this run is a child (delegation or inline). */
  readonly parentLinkage?: ParentLinkage;
  readonly runbookSrc?: string;
  /** Optional record of template variable replacements to populate placeholders at run time. */
  readonly templateVars?: Record<string, TemplateVarValue>;
  /** Frontmatter `outputs:` declarations seeded into the compiled machine for OUTPUTS evaluation. */
  readonly frontmatterOutputs?: readonly OutputDeclaration[];
}

/**
 * Manager for runbook state persistence and lifecycle.
 *
 * Handles creating, loading, saving, and updating runbook state.
 * State is persisted to `.rundown/runs/` as JSON files.
 * Supports runbook stacks for nested runbooks.
 */
export class RunbookStateManager {
  /**
   * Module-level guard so the legacy-state warning is emitted at most once
   * per process regardless of how many RunbookStateManager instances exist.
   */
  private static legacyWarningEmitted = false;
  private readonly _cwd: string;

  /**
   * Per-process registry of run ids whose `RunbookActor` is currently running.
   *
   * Maintained by {@link RunbookActorService} via {@link markActorStarted} and
   * {@link markActorStopped}. {@link resolveArtifactsForRun} consults this set
   * to refuse writes that would race with the actor's stale-context replay
   * through `RunbookActorService.updateFromActor`.
   */
  private readonly liveActors = new Set<string>();

  /**
   * Create a new RunbookStateManager.
   *
   * @param cwd - The working directory (project root) for state file paths
   */
  constructor(cwd: string) {
    this._cwd = cwd;
  }

  /**
   * Register a run id as having a live actor in this process.
   *
   * Called by {@link RunbookActorService.createActor} after `actor.start()`.
   * Idempotent: re-registering a live id is a no-op.
   *
   * @param id - Runbook state id
   */
  markActorStarted(id: string): void {
    this.liveActors.add(id);
  }

  /**
   * Deregister a run id whose actor has been stopped.
   *
   * Called by {@link RunbookActorService.stopActor} after `actor.stop()`.
   * Idempotent: removing an unknown id is a no-op.
   *
   * @param id - Runbook state id
   */
  markActorStopped(id: string): void {
    this.liveActors.delete(id);
  }

  /**
   * Whether a `RunbookActor` is currently live for the given run id.
   *
   * @param id - Runbook state id
   * @returns `true` if {@link markActorStarted} was called without a matching
   *   {@link markActorStopped}
   */
  isActorLive(id: string): boolean {
    return this.liveActors.has(id);
  }

  /**
   * Project root directory used for all state file paths.
   *
   * @returns The working directory passed to the constructor
   */
  get cwd(): string {
    return this._cwd;
  }

  private get stateDir(): string {
    return _runsDir(this.cwd);
  }

  /**
   * Return a canonicalized form of `this.cwd` by resolving symlinks.
   *
   * On macOS, `/tmp` is a symlink to `/private/tmp`. JsonArrayStream paths are
   * stored in canonical form (resolved via `fs.realpath` at write time), so the
   * project-root boundary check in `makeRunbookStateSchema` must compare against
   * the same canonical path.
   *
   * Falls back to the raw `cwd` on `fs.realpath` failure with failure-mode
   * discrimination:
   * - `ENOENT`: the directory no longer exists; falls back silently (the run will
   *   fail at a more meaningful point shortly after).
   * - Any other error (e.g. `EPERM`, `EACCES`): logs a warn with the specific
   *   error code and a note that `JsonArrayStream` path validation may produce
   *   false boundary-check failures if the project root is a symlink.
   *
   * @returns The canonicalized working directory path
   */
  private async canonicalCwd(): Promise<string> {
    try {
      return await fs.realpath(this.cwd);
    } catch (err) {
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        void logger.warn(
          `canonicalCwd: fs.realpath("${this.cwd}") failed (${isNodeError(err) ? (err.code ?? 'unknown') : 'unknown'}), ` +
            `using raw path — JsonArrayStream path validation may produce false failures. Check permissions on project root.`,
        );
      }
      return this.cwd;
    }
  }

  private get sessionPath(): string {
    return _sessionPath(this.cwd);
  }

  private statePath(id: string): string {
    return _statePath(this.cwd, id);
  }

  /** Emit a process-wide one-time warning when legacy `.claude/rundown/` state is detected. */
  private async warnIfLegacyStateExists(): Promise<void> {
    if (RunbookStateManager.legacyWarningEmitted) return;
    try {
      await fs.access(path.join(this.cwd, LEGACY_SESSION_FILE));
      RunbookStateManager.legacyWarningEmitted = true;
      process.stderr.write(
        '[rundown] Warning: State from a previous installation was found at .claude/rundown/.\n' +
          '  State is now stored in .rundown/. Complete or abort any in-flight runbooks\n' +
          '  from the old location, then remove the .claude/rundown/ directory.\n',
      );
    } catch {
      // No legacy state — normal startup.
    }
  }

  /**
   * Create a new runbook state and persist it to disk.
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
      variables: brandStoredOutputs({}),
      steps: [],
      resolvedCompletions: {},
      frameEntries: {},
      parentLinkage: options.parentLinkage,
      startedAt: now,
      updatedAt: now,
      prompted: options.prompted,
      runbookSrc: options.runbookSrc,
      templateVars:
        options.templateVars === undefined
          ? undefined
          : brandInitialTemplateVars(options.templateVars),
      frontmatterOutputs: options.frontmatterOutputs ?? [],
      lifecycle: 'running',
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    await this.save(state);
    return state;
  }

  /**
   * Load a runbook state from disk by ID.
   *
   * @param id - The runbook state ID (e.g., 'rd_0123456789abcdef0123456789abcdef')
   * @returns The loaded RunbookState, or null if file not found
   * @throws {Error} If the state file exists but fails schema validation (stale state)
   * @throws {Error} If the runbook state uses deprecated dynamic-step snapshots
   */
  async load(id: string): Promise<RunbookState | null> {
    let content: string;
    try {
      content = await fs.readFile(this.statePath(id), 'utf8');
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return null; // File not found — genuinely missing
      }
      throw error; // Permission denied, disk errors, etc. — propagate
    }

    const parsed = JSON.parse(content) as unknown;

    // Reject legacy dynamic-step snapshots: GOTO_NEXT action or instance field
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      const lastAction = obj.lastAction;
      if (
        typeof lastAction === 'object' &&
        lastAction !== null &&
        (lastAction as Record<string, unknown>).type === 'GOTO_NEXT'
      ) {
        throw new Error(
          'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported. ' +
            'Please restart execution from the runbook entrypoint.',
        );
      }
      if (obj.instance !== undefined) {
        throw new Error(
          'This runbook used dynamic-step snapshots (instance field), which are no longer supported. ' +
            'Please restart execution from the runbook entrypoint.',
        );
      }
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>).schemaVersion !== CURRENT_SCHEMA_VERSION
    ) {
      throw new StaleRunbookStateError(
        `Runbook state for "${id}" was persisted under a previous schema version. ` +
          'Run `rd prune --all` to clear stale state before continuing.',
      );
    }

    const canonicalized = await this.canonicalCwd();
    const result = makeRunbookStateSchema(canonicalized).safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Stale runbook state for "${id}": schema validation failed. ` +
          'Run `rundown prune` and restart execution.',
      );
    }
    // Zod's .regex() refinement narrows at runtime but infers as `string` at the type level.
    // The schema guarantees GOTO `at` matches TEMPLATE_VAR_PATTERN; cast to the stricter TS type.
    return result.data as RunbookState;
  }

  /**
   * Save a runbook state to disk.
   *
   * Creates the state directory if it does not exist and writes the state
   * as a JSON file, automatically updating the `updatedAt` timestamp.
   *
   * @param state - The runbook state to persist
   */
  async save(state: RunbookState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const updated: RunbookState = {
      ...state,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    const content = JSON.stringify(updated, null, 2);
    await fs.writeFile(this.statePath(state.id), content, { mode: 0o600 }); // Owner read/write only
  }

  /**
   * Update an existing runbook state with partial changes.
   *
   * Per-field semantics:
   * - `variables` — `merge(...)` shallow-merges OUTPUTS (merge-only)
   * - `templateVars` — `replace(...)` wholesale-replaces (replace-only; seeded once)
   * - `artifactVars` — `merge(...)` adds entries; `replace(...)` mirrors the full set
   * - `resolvedCompletions` — `merge(...)` adds one entry; `replace(...)` rewrites the map
   * - `frameEntries` — `replace(...)` wholesale-replaces (replace-only)
   * - All other fields — provided value is taken verbatim; omitted fields are preserved
   *
   * Use the {@link merge} and {@link replace} constructors at call sites to make
   * intent visible at the type level; passing a raw record without a tag is a
   * compile error.
   *
   * @param id - The runbook state ID to update
   * @param updates - Partial state updates with tagged ops on record-shaped fields
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   */
  async update(
    id: string,
    updates: Partial<
      Omit<
        RunbookState,
        | 'id'
        | 'startedAt'
        | 'updatedAt'
        | 'schemaVersion'
        | 'variables'
        | 'templateVars'
        | 'artifactVars'
        | 'resolvedCompletions'
        | 'frameEntries'
      >
    > & {
      // Tagged ops on record-shaped fields make merge-vs-replace intent
      // visible at the call site. Internal callers (actor-service sync,
      // compiler reducers) hold the unbranded XState context shape; the
      // manager re-mints persistence brands inside the dispatch below.
      readonly variables?: VariablesOp;
      readonly templateVars?: TemplateVarsOp;
      readonly artifactVars?: ArtifactVarsOp;
      readonly resolvedCompletions?: ResolvedCompletionsOp;
      readonly frameEntries?: FrameEntriesOp;
    },
  ): Promise<RunbookState> {
    const existing = await this.load(id);
    if (!existing) {
      throw new Error(`Runbook ${id} not found`);
    }

    // Pull tagged-op fields out of updates so the subsequent `...updates`
    // spread does not leak the wrapper shapes into the strictly-typed
    // RunbookState literal.
    const {
      variables: variablesOp,
      templateVars: templateVarsOp,
      artifactVars: artifactVarsOp,
      resolvedCompletions: resolvedCompletionsOp,
      frameEntries: frameEntriesOp,
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

    const updated: RunbookState = {
      ...existing,
      ...patchedRestUpdates,
      variables:
        variablesOp !== undefined
          ? brandStoredOutputs(applyOp(existing.variables, variablesOp))
          : existing.variables,
      ...(templateVarsOp !== undefined
        ? { templateVars: brandInitialTemplateVars(templateVarsOp.value) }
        : {}),
      ...(artifactVarsOp !== undefined
        ? { artifactVars: brandArtifactVars(applyOp(existing.artifactVars, artifactVarsOp)) }
        : {}),
      ...(resolvedCompletionsOp !== undefined
        ? { resolvedCompletions: applyOp(existing.resolvedCompletions, resolvedCompletionsOp) }
        : {}),
      ...(frameEntriesOp !== undefined ? { frameEntries: frameEntriesOp.value } : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Resolve one ARTIFACTS block for a persisted run and merge the result into
   * `RunbookState.artifactVars`.
   *
   * This method is intentionally explicit: it does not inspect the active step
   * or emit events. Phase 4 owns deciding when to call it at step/substep entry.
   *
   * @remarks
   * Refuses to run while a live `RunbookActor` exists for the same `id` (as
   * tracked by {@link markActorStarted}/{@link markActorStopped}). The actor
   * seeds `context.artifactVars` once at compile time (`actor-service.ts`
   * `compileMachineFromState`); a later `RunbookActorService.updateFromActor`
   * mirrors the actor's stale view back to disk via `replace(...)`
   * (`actor-service.ts` artifactVars patches), which would overwrite this
   * method's writes. Phase 4 will replace the refusal with a machine-mediated
   * write path so resolver output flows through the actor's context.
   *
   * @param id - Current run id
   * @param declarations - Parser-owned artifact declarations for one execution unit
   * @returns The current execution unit's resolved artifact working set
   * @throws {Error} If a live `RunbookActor` exists for `id`, the run is not
   * found, is missing required built-ins (`WorkPath`, `ContextId`), has
   * corrupt artifact manifests, or encounters unexpected artifact filesystem
   * failures
   */
  async resolveArtifactsForRun(
    id: string,
    declarations: readonly ArtifactDeclaration[],
  ): Promise<Record<string, ArtifactVarValue>> {
    if (this.liveActors.has(id)) {
      throw new Error(
        `Refusing to resolve artifacts for "${id}": a live RunbookActor exists for this run. ` +
          `Stop the actor (RunbookActorService.stopActor) before calling resolveArtifactsForRun, ` +
          `or wait for Phase 4 machine-mediated artifact resolution.`,
      );
    }
    const state = await this.load(id);
    if (!state) {
      throw new Error(`Runbook ${id} not found`);
    }
    const workPath = state.templateVars?.WorkPath;
    const contextId = state.templateVars?.ContextId;
    if (typeof workPath !== 'string') {
      throw new Error(`Runbook ${id} cannot resolve ARTIFACTS without string WorkPath`);
    }
    if (typeof contextId !== 'string') {
      throw new Error(`Runbook ${id} cannot resolve ARTIFACTS without string ContextId`);
    }

    const runId: RunId = assertRunId(state.id);
    const resolved = await resolveArtifactDeclarations(declarations, {
      cwd: this.cwd,
      workPath,
      contextId,
      runId,
      runbook: state.runbook,
      loadRunEligibility: async (otherRunId: RunId): Promise<ArtifactRunEligibility | null> => {
        const other = await this.load(otherRunId);
        if (!other) return null;
        if (other.id === state.id) return null;
        if (other.lifecycle === 'completed' && other.updatedAt) {
          return { runId: otherRunId, terminalAt: other.updatedAt };
        }
        return null;
      },
    });

    await this.update(id, {
      artifactVars: merge(resolved),
    });
    return resolved;
  }

  /**
   * Delete a runbook state file and its per-run outputs directory from disk.
   *
   * Removes both `.rundown/runs/<id>.json` and the captured-output directory
   * `.rundown/runs/<id>/` if it exists. Silently ignores errors when either
   * path is absent — `delete` must be idempotent.
   *
   * @param id - The runbook state ID to delete
   */
  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.statePath(id));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      // The per-run outputs directory shares the run id with the state file.
      // Use rm -rf semantics so a non-empty directory is removed cleanly.
      const runDir = this.statePath(id).replace(/\.json$/, '');
      await fs.rm(runDir, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * List all persisted runbook states.
   *
   * Reads all runbook state JSON files from the state directory.
   *
   * @returns An array of all runbook states, or an empty array if none exist
   */
  async list(): Promise<RunbookState[]> {
    try {
      const files = await fs.readdir(this.stateDir);
      const states: RunbookState[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const id = file.replace('.json', '');
          try {
            const state = await this.load(id);
            if (state) states.push(state);
          } catch (err) {
            if (err instanceof StaleRunbookStateError) {
              process.stderr.write(`[rundown] Warning: ${err.message}\n`);
            }
            // Other errors (corrupt JSON, missing files) — skip silently
          }
        }
      }
      return states;
    } catch {
      return [];
    }
  }

  /**
   * Load the session data from disk.
   *
   * @returns The parsed session data, or a default empty session if the file doesn't exist
   */
  async loadSession(): Promise<SessionData> {
    let content: string;
    try {
      content = await fs.readFile(this.sessionPath, 'utf8');
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        await this.warnIfLegacyStateExists();
        return { defaultStack: [], claims: {} };
      }
      throw err;
    }

    const raw = JSON.parse(content) as Record<string, unknown>;

    if ('ownedRunbooks' in raw || 'stashedRunbookOwnership' in raw || 'stacks' in raw) {
      throw new Error(
        'Legacy session ownership format detected. Finish or prune active runbooks and restart.',
      );
    }

    const result = SessionDataSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        'Session file contains invalid runbook targeting data. Delete .rundown/session.json and restart active runbooks.',
      );
    }

    return result.data;
  }

  /**
   * Persist session data to disk.
   *
   * @param session - The session data to write
   */
  async saveSession(session: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
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
    const state = await this.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    const newEntries: SubstepState[] = substeps.map((s) => ({
      id: s.id,
      frameKey,
      status: 'pending',
      result: undefined,
    }));

    const existing = state.substepStates ?? [];
    const preserved = existing.filter((ss) => ss.frameKey !== frameKey);

    await this.update(id, { substepStates: [...preserved, ...newEntries] });
  }

  /**
   * Update the FOR loop context for a runbook.
   *
   * Use {@link ForIterationService.prepareIteration} instead of calling this directly.
   *
   * @internal
   * @param id - The runbook state ID
   * @param forStack - The updated FOR loop stack
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   */
  async updateForContext(id: string, forStack: ForContext[]): Promise<RunbookState> {
    const state = await this.load(id);
    if (!state) {
      throw new Error(`Runbook ${id} not found`);
    }

    const snapshot = state.snapshot as Record<string, unknown> | undefined;
    const patchedSnapshot =
      snapshot && typeof snapshot === 'object' && 'context' in snapshot
        ? {
            ...snapshot,
            context: { ...(snapshot.context as Record<string, unknown>), forStack },
          }
        : snapshot;

    return await this.update(id, { forStack, snapshot: patchedSnapshot });
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
    const state = await this.load(runbookId);
    if (!state) throw new Error(`Runbook ${runbookId} not found`);

    const substepStates = state.substepStates ?? [];
    const updated = substepStates.map((s) =>
      s.id === substepId && s.frameKey === frameKey ? { ...s, status: 'done' as const, result } : s,
    );

    await this.update(runbookId, { substepStates: updated });
  }
}
