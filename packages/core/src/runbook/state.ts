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
  type FrameEntriesOp,
  type ResolvedCompletionsOp,
  type TemplateVarsOp,
  type VariablesOp,
} from './state-update-ops.js';
import type { ClaimRecord } from './claim-id.js';
import type { RunbookRef } from './runbook-ref.js';
import { makeRunbookStateSchema, SessionDataSchema } from '../schemas.js';
import { getErrorMessage, isNodeError } from '../errors.js';
import { logger } from '../logger.js';
import {
  brandInitialTemplateVars,
  brandStoredOutputs,
  isTrustedArtifactValue,
  type VariableValue,
} from './effective-vars.js';
import { isArtifactRecord } from './artifact-schema.js';
import { assertRunId, RUN_ID_PREFIX, type RunId } from './run-id.js';
import {
  runsDir as _runsDir,
  sessionPath as _sessionPath,
  statePath as _statePath,
  LEGACY_SESSION_FILE,
} from '../paths.js';

/** Current persisted state schema version for the v1 release. */
const CURRENT_SCHEMA_VERSION = 1;

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
 * Thrown when a persisted state file does not match the current schema contract.
 */
export class InvalidRunbookStateError extends Error {
  /**
   * Create a new InvalidRunbookStateError.
   *
   * @param message - Human-readable description of why the state is invalid
   */
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRunbookStateError';
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
  /** Optional runtime variables to seed into RunbookState.variables at creation. */
  readonly initialVariables?: Readonly<Record<string, VariableValue>>;
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
   * Create a new RunbookStateManager.
   *
   * @param cwd - The working directory (project root) for state file paths
   */
  constructor(cwd: string) {
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
      variables: brandStoredOutputs(assertTrustedArtifactValues(options.initialVariables ?? {})),
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
   * @throws {InvalidRunbookStateError} If the state file exists but fails schema validation
   *   or has an incompatible schemaVersion
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
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": invalid schemaVersion; expected schema version 1.`,
      );
    }

    const result = makeRunbookStateSchema(this.cwd).safeParse(parsed);
    if (!result.success) {
      throw new InvalidRunbookStateError(
        `Invalid runbook state for "${id}": schema validation failed.`,
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
   * - `variables` — `merge(...)` shallow-merges values (merge-only). Accepts
   *   strings (OUTPUTS), `ArtifactRecord` (exact ARTIFACT), and
   *   `readonly ArtifactRecord[]` (wildcard ARTIFACT).
   * - `templateVars` — `replace(...)` wholesale-replaces (replace-only; seeded once)
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
      ...(patchedRestUpdates.finalVars !== undefined
        ? { finalVars: assertTrustedArtifactValues(patchedRestUpdates.finalVars) }
        : {}),
      variables:
        variablesOp !== undefined
          ? brandStoredOutputs(
              assertTrustedArtifactValues(applyOp(existing.variables, variablesOp)),
            )
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
      ...(frameEntriesOp !== undefined ? { frameEntries: frameEntriesOp.value } : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
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
            if (err instanceof InvalidRunbookStateError) {
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

    await this.update(id, { substepStates: [...preserved, ...initialized] });
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
