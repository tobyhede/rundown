// src/runbook/state.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  type RunbookState,
  type ForContext,
  type AgentBinding,
  type Substep,
  type SubstepState,
  type Runbook,
  type DataSource,
} from './types.js';
import type { StepId } from './step-id.js';
import { RunbookStateSchema } from '../schemas.js';

const STATE_DIR = '.claude/rundown/runs';
const SESSION_FILE = '.claude/rundown/session.json';

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const random = Math.random().toString(36).slice(2, 8);
  return `wf-${date}-${random}`;
}

export interface SessionData {
  stacks: Partial<Record<string, string[]>>; // agentId → [wf1, wf2, ...]
  defaultStack: string[]; // main agent stack (no agentId)
  stashedRunbookId?: string;
}

interface CreateOptions {
  readonly runbookPath: string;
  readonly agentId?: string;
  readonly parentRunbookId?: string;
  readonly parentStepId?: StepId;
  readonly prompted?: boolean;
  readonly runbookSrc?: string;
  /** Optional record of template variable replacements to populate placeholders at run time. */
  readonly templateVars?: Record<string, string>;
  /** Data source bindings for FOR loop iteration (arrays and file references). */
  readonly sources?: Readonly<Record<string, DataSource>>;
}

/**
 * Manager for runbook state persistence and lifecycle.
 *
 * Handles creating, loading, saving, and updating runbook state.
 * State is persisted to `.claude/rundown/runs/` as JSON files.
 * Supports runbook stacks for per-agent isolation and nested runbooks.
 */
export class RunbookStateManager {
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
    return path.join(this.cwd, STATE_DIR);
  }

  private get sessionPath(): string {
    return path.join(this.cwd, SESSION_FILE);
  }

  private statePath(id: string): string {
    return path.join(this.stateDir, `${id}.json`);
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
    runbook: Runbook,
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
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      agentId: options.agentId,
      parentRunbookId: options.parentRunbookId,
      parentStepId: options.parentStepId,
      startedAt: now,
      updatedAt: now,
      prompted: options.prompted,
      runbookSrc: options.runbookSrc,
      templateVars: options.templateVars,
      sources: options.sources,
    };

    await this.save(state);
    return state;
  }

  /**
   * Load a runbook state from disk by ID.
   *
   * @param id - The runbook state ID (e.g., 'wf-2025-01-12-abc123')
   * @returns The loaded RunbookState, or null if not found or invalid
   * @throws Error if the runbook state uses deprecated dynamic-step snapshots
   */
  async load(id: string): Promise<RunbookState | null> {
    try {
      const content = await fs.readFile(this.statePath(id), 'utf8');
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

      const result = RunbookStateSchema.safeParse(parsed);
      if (!result.success) return null;
      // Zod's .regex() refinement narrows at runtime but infers as `string` at the type level.
      // The schema guarantees GOTO `at` matches TEMPLATE_VAR_PATTERN; cast to the stricter TS type.
      return result.data as RunbookState;
    } catch (e) {
      // Re-throw legacy snapshot errors
      if (e instanceof Error && e.message.includes('dynamic-step snapshots')) {
        throw e;
      }
      return null;
    }
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
   * @throws Error if the runbook with the given ID is not found
   */
  async update(
    id: string,
    updates: Partial<Omit<RunbookState, 'id' | 'startedAt'>>,
  ): Promise<RunbookState> {
    const existing = await this.load(id);
    if (!existing) {
      throw new Error(`Runbook ${id} not found`);
    }

    const updated: RunbookState = {
      ...existing,
      ...updates,
      variables: { ...existing.variables, ...(updates.variables ?? {}) },
      updatedAt: new Date().toISOString(),
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Delete a runbook state file from disk.
   *
   * Silently ignores errors if the file does not exist.
   *
   * @param id - The runbook state ID to delete
   */
  async delete(id: string): Promise<void> {
    try {
      await fs.unlink(this.statePath(id));
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
          const state = await this.load(id);
          if (state) states.push(state);
        }
      }
      return states;
    } catch {
      return [];
    }
  }

  /**
   * Bind an agent to a specific step in the runbook.
   *
   * Creates a new agent binding with 'running' status. Used when a subagent
   * starts working on a step.
   *
   * @param id - The runbook state ID
   * @param agentId - The agent ID to bind
   * @param stepId - The step ID the agent is working on
   * @throws Error if the runbook with the given ID is not found
   */
  async bindAgent(id: string, agentId: string, stepId: StepId): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    const binding: AgentBinding = {
      stepId,
      status: 'running',
    };

    await this.update(id, {
      agentBindings: {
        ...state.agentBindings,
        [agentId]: binding,
      },
    });
  }

  /**
   * Get the agent binding for a specific agent in a runbook.
   *
   * @param id - The runbook state ID
   * @param agentId - The agent ID to look up
   * @returns The agent binding, or null if the agent is not bound
   * @throws Error if the runbook with the given ID is not found
   */
  async getAgentBinding(id: string, agentId: string): Promise<AgentBinding | null> {
    const state = await this.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);
    return state.agentBindings[agentId] ?? null;
  }

  /**
   * Update an existing agent binding with partial changes.
   *
   * @param id - The runbook state ID
   * @param agentId - The agent ID whose binding to update
   * @param updates - Partial binding updates (status, result, childRunbookId)
   * @throws Error if the runbook with the given ID is not found
   * @throws Error if the agent has no existing binding
   */
  async updateAgentBinding(
    id: string,
    agentId: string,
    updates: Partial<Pick<AgentBinding, 'status' | 'result' | 'childRunbookId'>>,
  ): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    const existing = state.agentBindings[agentId];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!existing) throw new Error(`No binding for agent ${agentId}`);

    await this.update(id, {
      agentBindings: {
        ...state.agentBindings,
        [agentId]: { ...existing, ...updates },
      },
    });
  }

  /**
   * Load the session data from disk.
   *
   * @returns The parsed session data, or a default empty session if the file doesn't exist
   */
  async loadSession(): Promise<SessionData> {
    try {
      const content = await fs.readFile(this.sessionPath, 'utf8');
      return JSON.parse(content) as SessionData;
    } catch {
      return { stacks: {}, defaultStack: [] };
    }
  }

  /**
   * Persist session data to disk.
   *
   * @param session - The session data to write
   */
  async saveSession(session: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
  }

  /**
   * Initialize substep tracking state for a runbook step.
   *
   * Creates SubstepState entries for all substeps with 'pending' status.
   *
   * @param id - The runbook state ID
   * @param substeps - The substep definitions from the step
   * @throws Error if the runbook with the given ID is not found
   */
  async initializeSubsteps(id: string, substeps: readonly Substep[]): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Runbook ${id} not found`);

    const substepStates: SubstepState[] = substeps.map((s) => ({
      id: s.id,
      status: 'pending',
      agentId: undefined,
      result: undefined,
    }));

    await this.update(id, { substepStates });
  }

  /**
   * Bind an agent to a specific substep.
   *
   * Updates the substep's status to 'running' and records the agent ID.
   *
   * @param runbookId - The runbook state ID
   * @param substepId - The substep ID to bind to
   * @param agentId - The agent ID to bind
   * @throws Error if the runbook with the given ID is not found
   */
  async bindSubstepAgent(runbookId: string, substepId: string, agentId: string): Promise<void> {
    const state = await this.load(runbookId);
    if (!state) throw new Error(`Runbook ${runbookId} not found`);

    const substepStates = state.substepStates ?? [];
    const updated = substepStates.map((s) =>
      s.id === substepId ? { ...s, status: 'running' as const, agentId } : s,
    );

    await this.update(runbookId, { substepStates: updated });
  }

  /**
   * Update the FOR loop context for a runbook.
   *
   * @internal Used by {@link ForIterationService} — external consumers should
   * use {@link ForIterationService.prepareIteration} instead of calling this directly.
   *
   * @param id - The runbook state ID
   * @param forStack - The updated FOR loop stack
   * @returns The updated runbook state
   * @throws Error if the runbook with the given ID is not found
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
   * @throws Error if the runbook with the given ID is not found
   */
  async completeSubstep(
    runbookId: string,
    substepId: string,
    result: 'pass' | 'fail',
  ): Promise<void> {
    const state = await this.load(runbookId);
    if (!state) throw new Error(`Runbook ${runbookId} not found`);

    const substepStates = state.substepStates ?? [];
    const updated = substepStates.map((s) =>
      s.id === substepId ? { ...s, status: 'done' as const, result } : s,
    );

    await this.update(runbookId, { substepStates: updated });
  }
}
