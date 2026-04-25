// src/runbook/state.ts
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
} from './types.js';
import { makeRunbookStateSchema } from '../schemas.js';
import { isNodeError } from '../errors.js';
import { logger } from '../logger.js';
import { brandInitialTemplateVars, brandStoredOutputs } from './effective-vars.js';
import {
  runsDir as _runsDir,
  sessionPath as _sessionPath,
  statePath as _statePath,
  LEGACY_SESSION_FILE,
} from '../paths.js';

/** Current persisted state schema version. Bump whenever RunbookState shape changes incompatibly. */
const CURRENT_SCHEMA_VERSION = 2;

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

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const random = Math.random().toString(36).slice(2, 8);
  return `wf-${date}-${random}`;
}

/**
 * Persisted session state tracking the active runbook stack.
 *
 * A single shared stash slot allows temporarily parking a runbook.
 */
export interface SessionData {
  /** Active runbook stack */
  defaultStack: string[];
  /** ID of a temporarily stashed runbook, if any */
  stashedRunbookId?: string;
}

interface CreateOptions {
  readonly runbookPath: string;
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
  private readonly cwd: string;

  /**
   * Create a new RunbookStateManager.
   *
   * @param cwd - The working directory (project root) for state file paths
   */
  constructor(cwd: string) {
    this.cwd = cwd;
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
   * @param runbookFile - Path to the runbook source file
   * @param runbook - The parsed runbook definition
   * @param options - Configuration including agentId, parent runbook info, prompted flag, and templateVars for template variable replacements
   * @returns The newly created RunbookState
   */
  async create(
    runbookFile: string,
    runbook: Runbook | ResolvedRunbook,
    options: CreateOptions,
  ): Promise<RunbookState> {
    const id = generateId();
    const now = new Date().toISOString();

    const initialStep = runbook.steps[0];

    const state: RunbookState = {
      id,
      runbook: runbookFile,
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
   * @param id - The runbook state ID (e.g., 'wf-2025-01-12-abc123')
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
   * Merges the provided updates with the existing state. Variables are
   * shallow-merged rather than replaced entirely.
   *
   * @param id - The runbook state ID to update
   * @param updates - Partial state updates to apply (id and startedAt cannot be changed)
   * @returns The updated runbook state
   * @throws {Error} If the runbook with the given ID is not found
   */
  async update(
    id: string,
    updates: Partial<Omit<RunbookState, 'id' | 'startedAt' | 'variables' | 'templateVars'>> & {
      // Accept unbranded records on the update path; the manager re-mints
      // the brand inside the merge below. Internal callers (actor-service
      // sync, compiler reducers) hold the unbranded XState context shape
      // and shouldn't need to know about the persistence-layer brand.
      readonly variables?: Readonly<Record<string, string>>;
      readonly templateVars?: Readonly<Record<string, TemplateVarValue>>;
    },
  ): Promise<RunbookState> {
    const existing = await this.load(id);
    if (!existing) {
      throw new Error(`Runbook ${id} not found`);
    }

    // Pull branded/unbranded fields out of updates so the subsequent
    // `...updates` spread does not leak the unbranded types into the
    // strictly-typed RunbookState literal.
    const {
      variables: updatesVariables,
      templateVars: updatesTemplateVars,
      ...restUpdates
    } = updates;

    const updated: RunbookState = {
      ...existing,
      ...restUpdates,
      variables: brandStoredOutputs({ ...existing.variables, ...(updatesVariables ?? {}) }),
      ...(updatesTemplateVars !== undefined
        ? { templateVars: brandInitialTemplateVars(updatesTemplateVars) }
        : {}),
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
    } catch {
      /* intentionally ignored */
    }
    try {
      // The per-run outputs directory shares the run id with the state file.
      // Use rm -rf semantics so a non-empty directory is removed cleanly.
      const runDir = this.statePath(id).replace(/\.json$/, '');
      await fs.rm(runDir, { recursive: true, force: true });
    } catch {
      /* intentionally ignored */
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.warnIfLegacyStateExists();
        return { defaultStack: [] };
      }
      throw err;
    }

    const raw = JSON.parse(content) as Record<string, unknown>;

    if ('stacks' in raw) {
      throw new Error(
        'Legacy per-agent session format detected. Delete the session file and restart.',
      );
    }

    const rawStack = Array.isArray(raw.defaultStack) ? raw.defaultStack : [];
    const defaultStack = rawStack.filter((e): e is string => typeof e === 'string');
    if (rawStack.length > 0 && defaultStack.length !== rawStack.length) {
      throw new Error(
        'Session file contains invalid entries in defaultStack. Delete the session file and restart.',
      );
    }

    return {
      defaultStack,
      ...(typeof raw.stashedRunbookId === 'string'
        ? { stashedRunbookId: raw.stashedRunbookId }
        : {}),
    };
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
