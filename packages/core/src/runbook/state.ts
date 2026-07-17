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
  Lifecycle,
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
import {
  defaultRunStateLockFactory,
  type RunStateLockFactory,
  type RunStateLockLike,
} from './run-state-lock.js';
import { heldLock } from './file-lock.js';

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

async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  // Unique per-write temp name so concurrent writers targeting the same final
  // path never collide on the temp file; atomicity of the rename then does not
  // depend on an external lock for collision-freedom. `randomBytes` (not
  // `Math.random`) is a robust uniqueness source available on every runtime we
  // support, including WebContainer's Node 22.x.
  const tempPath = `${filePath}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  const content = JSON.stringify(value, null, 2);

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best effort cleanup only. The caller-visible error is the failed write/rename.
    }
    throw error;
  }
}

/**
 * Thrown when a persisted state file uses the deprecated dynamic-step snapshot
 * shape (`GOTO_NEXT` last action or `instance` field), which the current
 * runtime rejects per the no-migration rule.
 *
 * A dedicated class so consumers (e.g. the CLI's orphaned-active-stack
 * recovery) classify by type rather than matching message wording.
 */
export class LegacySnapshotError extends Error {
  /**
   * Create a new LegacySnapshotError.
   *
   * @param message - Human-readable description of the rejected legacy shape
   */
  constructor(message: string) {
    super(message);
    this.name = 'LegacySnapshotError';
  }
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
   * Factory producing the per-run state lock. Defaults to the real
   * filesystem-backed lock; tests inject a deterministic fake.
   */
  readonly lockFactory?: RunStateLockFactory;
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
  private readonly lockFactory: RunStateLockFactory;

  /**
   * Create a new RunbookStateManager.
   *
   * @param cwd - The working directory (project root) for state file paths
   * @param options - Optional overrides, including an injectable lock factory
   */
  constructor(cwd: string, options: RunbookStateManagerOptions = {}) {
    this.lockFactory = options.lockFactory ?? defaultRunStateLockFactory;
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

  private async withRunStateLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const lock: RunStateLockLike = this.lockFactory(this.cwd);
    await lock.acquire(id);
    // Best-effort scoped release: a failed unlink only leaks a self-healing lock
    // and must never mask the committed state mutation that `fn()` returns.
    //
    // Unlike the completion/delegation/session locks, this lock is consumed
    // through the narrow `RunStateLockLike` DI interface (acquire/release only,
    // so test fakes stay trivial), so there is no `held()`/`scope()` method to
    // call here — wrapping `heldLock` inline is the correct adaptation.
    await using _guard = heldLock(
      () => lock.release(id),
      () => ({ lock: 'run-state', runId: id }),
    );
    return await fn();
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
      frameEntryCounts: {},
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
   * @throws {LegacySnapshotError} If the runbook state uses deprecated dynamic-step snapshots
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
        throw new LegacySnapshotError(
          'This runbook used dynamic-step snapshots (GOTO_NEXT), which are no longer supported. ' +
            'Please restart execution from the runbook entrypoint.',
        );
      }
      if (obj.instance !== undefined) {
        throw new LegacySnapshotError(
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
    await this.withRunStateLock(state.id, async () => {
      // `save` is only reached for fresh states (its sole core caller is
      // `create`), so the prior lifecycle is always absent.
      await this.saveUnlocked(state, null);
    });
  }

  private async saveUnlocked(state: RunbookState, prev: Lifecycle | null): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const updated: RunbookState = {
      ...state,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFileAtomic(this.statePath(state.id), updated);
    const next = updated.lifecycle ?? null;
    if (next !== null && next !== prev) {
      // Diagnostic trail for lifecycle transitions (#536 was found with this
      // signal). Enable with RUNDOWN_LOG_LEVEL=debug; the logger stamps pid.
      void logger.debug('lifecycle-write', { runId: state.id, prev, next });
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
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   */
  async update(id: string, updates: RunbookStateUpdate): Promise<RunbookState> {
    return await this.withRunStateLock(id, async () => this.updateUnlocked(id, updates));
  }

  /**
   * Update an existing runbook state with a patch computed from the locked
   * current state.
   *
   * Use this for read-modify-write operations that replace whole fields such
   * as `substepStates` or `resolvedCompletions`. The callback runs while the
   * per-run state lock is held, so concurrent writers cannot compute from the
   * same stale snapshot and overwrite each other.
   *
   * Returning `null` leaves the current state unchanged and releases the lock.
   *
   * @param id - The runbook state ID to update
   * @param buildUpdates - Callback that derives a patch from current state
   * @returns The updated state, or current state when the callback returns `null`
   * @throws {Error} If the runbook with the given ID is not found
   */
  async updateWithState(
    id: string,
    buildUpdates: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
  ): Promise<RunbookState> {
    const updated = await this.updateWithStateIfExists(id, buildUpdates);
    if (updated === null) {
      throw new Error(`Runbook ${id} not found`);
    }
    return updated;
  }

  /**
   * Like {@link updateWithState}, but returns `null` when the runbook does not
   * exist instead of throwing.
   *
   * Use this for locked read-modify-write operations where a missing runbook is
   * a legitimate "nothing to do" outcome rather than an error (for example,
   * consuming a resolved completion). The callback only runs when the runbook
   * exists, so it always receives a non-null {@link RunbookState}.
   *
   * @param id - The runbook state ID to update
   * @param buildUpdates - Callback that derives a patch from current state
   * @returns The updated state, the current state when the callback returns
   *   `null`, or `null` when the runbook does not exist
   */
  async updateWithStateIfExists(
    id: string,
    buildUpdates: (
      current: RunbookState,
    ) => RunbookStateUpdate | null | Promise<RunbookStateUpdate | null>,
  ): Promise<RunbookState | null> {
    return await this.withRunStateLock(id, async () => {
      const existing = await this.load(id);
      if (!existing) {
        return null;
      }
      const updates = await buildUpdates(existing);
      if (updates === null) {
        return existing;
      }
      return await this.updateUnlockedFromExisting(existing, updates);
    });
  }

  /**
   * Like {@link updateWithStateIfExists}, but the callback additionally returns
   * a typed value that flows out through the result instead of through a
   * captured closure variable.
   *
   * Use this for locked read-modify-write operations that must also report
   * something they computed from the locked current state (for example,
   * consuming and returning a resolved completion). The patch and the reported
   * value are derived in the same callback under the same lock, so the reported
   * value is always consistent with the persisted patch.
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
    return await this.withRunStateLock(id, async () => {
      const existing = await this.load(id);
      if (!existing) {
        return { state: null, value: null };
      }
      const { updates, value } = await buildResult(existing);
      if (updates === null) {
        return { state: existing, value };
      }
      const state = await this.updateUnlockedFromExisting(existing, updates);
      return { state, value };
    });
  }

  private async updateUnlocked(id: string, updates: RunbookStateUpdate): Promise<RunbookState> {
    const existing = await this.load(id);
    if (!existing) {
      throw new Error(`Runbook ${id} not found`);
    }

    return await this.updateUnlockedFromExisting(existing, updates);
  }

  private async updateUnlockedFromExisting(
    existing: RunbookState,
    updates: RunbookStateUpdate,
  ): Promise<RunbookState> {
    // Pull tagged-op fields out of updates so the subsequent `...updates`
    // spread does not leak the wrapper shapes into the strictly-typed
    // RunbookState literal.
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
      ...(frameEntryCountsOp !== undefined ? { frameEntryCounts: frameEntryCountsOp.value } : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.saveUnlocked(updated, existing.lifecycle ?? null);
    return updated;
  }

  /**
   * Delete a runbook state file and its per-run outputs directory from disk.
   *
   * Removes both `.rundown/runs/<id>.json` and the captured-output directory
   * `.rundown/runs/<id>/` if it exists. Silently ignores errors when either
   * path is absent — `delete` must be idempotent.
   *
   * Held under the per-run state lock so a concurrent `save`/`update` cannot
   * recreate the state file or write into the outputs directory mid-removal.
   *
   * @param id - The runbook state ID to delete
   */
  async delete(id: string): Promise<void> {
    await this.withRunStateLock(id, async () => {
      let removed = false;
      try {
        await fs.unlink(this.statePath(id));
        removed = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (removed) {
        // Logged immediately after the state file is confirmed removed — and
        // before the outputs-dir cleanup below — so a later `fs.rm` failure
        // cannot suppress the trail of a deletion that actually committed.
        void logger.debug('lifecycle-write', { runId: id, kind: 'delete' });
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
    });
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

    // #519: `ClaimRecord.lastProgressAt` is required. A session persisted before
    // it existed is INVALID, not upgradable — CLAUDE.md forbids runtime migration,
    // fallback parsers, legacy field hydration, and warning-only adapters for
    // persisted runbook state. This guard runs BEFORE `safeParse` purely to route
    // this cause to the correct recovery path: Zod's failure message tells the user
    // to delete session.json, while the sanctioned recovery here — as for the legacy
    // ownership format above — is to finish or prune the active runbooks and restart.
    const rawClaims = raw['claims'];
    if (typeof rawClaims === 'object' && rawClaims !== null && !Array.isArray(rawClaims)) {
      const missingProgress = Object.values(rawClaims as Record<string, unknown>).some(
        (claim) =>
          typeof claim === 'object' &&
          claim !== null &&
          !Array.isArray(claim) &&
          !('lastProgressAt' in claim),
      );
      if (missingProgress) {
        throw new Error(
          'Legacy claim record format detected. Finish or prune active runbooks and restart.',
        );
      }
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
   * @remarks
   * The write uses {@link writeJsonFileAtomic} (temp file + atomic rename), so a
   * concurrent reader never observes a torn or partially written
   * `session.json`. This atomicity does NOT serialize read-modify-write across
   * processes: this method is not protected by the per-run `withRunStateLock`
   * (that lock guards a single run-state file, not the shared session file), so
   * two processes that load, mutate, and save the session concurrently can still
   * lose updates. Callers that mutate session state concurrently must hold the
   * higher-level `SessionLock` (`packages/core/src/runbook/session-lock.ts`).
   *
   * @param session - The session data to write
   */
  async saveSession(session: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await writeJsonFileAtomic(this.sessionPath, session);
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
    await this.withRunStateLock(id, async () => {
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

      await this.updateUnlocked(id, { substepStates: [...preserved, ...initialized] });
    });
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
    return await this.withRunStateLock(id, async () => {
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

      return await this.updateUnlocked(id, { forStack, snapshot: patchedSnapshot });
    });
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
    await this.withRunStateLock(runbookId, async () => {
      const state = await this.load(runbookId);
      if (!state) throw new Error(`Runbook ${runbookId} not found`);

      const substepStates = state.substepStates ?? [];
      const updated = substepStates.map((s) =>
        s.id === substepId && s.frameKey === frameKey
          ? { ...s, status: 'done' as const, result }
          : s,
      );

      await this.updateUnlocked(runbookId, { substepStates: updated });
    });
  }
}
