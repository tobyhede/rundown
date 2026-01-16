// src/runbook/state.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { createActor, type AnyActorRef } from 'xstate';
import {
  type RunbookState,
  type AgentBinding,
  type PendingStep,
  type Substep,
  type SubstepState,
  type Step,
  type Runbook
} from './types.js';
import type { StepId } from './step-id.js';
import { RunbookStateSchema } from '../schemas.js';
import { compileRunbookToMachine } from './compiler.js';

const STATE_DIR = '.claude/rundown/runs';
const SESSION_FILE = '.claude/rundown/session.json';

function generateId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const random = Math.random().toString(36).slice(2, 8);
  return `wf-${date}-${random}`;
}

interface SessionData {
  stacks: Record<string, string[]>;  // agentId → [wf1, wf2, ...]
  defaultStack: string[];            // main agent stack (no agentId)
  // Keep for backwards compatibility during migration
  activeRunbook?: string | null;
  stashedRunbookId?: string;
}

interface CreateOptions {
  readonly agentId?: string;
  readonly parentRunbookId?: string;
  readonly parentStepId?: StepId;
  readonly prompted?: boolean;
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
   * @param options - Optional configuration including agentId, parent runbook info, and prompted flag
   * @returns The newly created RunbookState
   */
  async create(runbookFile: string, runbook: Runbook, options?: CreateOptions): Promise<RunbookState> {
    const id = generateId();
    const now = new Date().toISOString();

    const initialStep = runbook.steps[0];
    // For dynamic runbooks, initialize instance counter to 1
    const instance = initialStep.isDynamic ? 1 : undefined;

    const state: RunbookState = {
      id,
      runbook: runbookFile,
      title: runbook.title,
      description: runbook.description,
      step: initialStep.name,    // Keep as '{N}' for dynamic, original name for static
      instance,                   // 1 for dynamic, undefined for static
      stepName: initialStep.description,
      retryCount: 0,
      variables: {},
      steps: [],
      pendingSteps: [],
      agentBindings: {},
      agentId: options?.agentId,
      parentRunbookId: options?.parentRunbookId,
      parentStepId: options?.parentStepId,
      startedAt: now,
      updatedAt: now,
      prompted: options?.prompted
    };

    await this.save(state);
    return state;
  }

  /**
   * Load a runbook state from disk by ID.
   *
   * @param id - The runbook state ID (e.g., 'wf-2025-01-12-abc123')
   * @returns The loaded RunbookState, or null if not found or invalid
   */
  async load(id: string): Promise<RunbookState | null> {
    try {
      const content = await fs.readFile(this.statePath(id), 'utf8');
      const parsed = JSON.parse(content) as unknown;
      const result = RunbookStateSchema.safeParse(parsed);
      if (!result.success) return null;
      return result.data;
    } catch {
      return null;
    }
  }

  /**
   * Initialize an XState actor for a runbook.
   *
   * Loads the runbook state and creates an XState actor with the
   * compiled state machine, restoring from any persisted snapshot.
   *
   * @param id - The runbook state ID
   * @param steps - The runbook steps to compile into a state machine
   * @returns The started XState actor, or null if the runbook state is not found
   */
  async createActor(id: string, steps: Step[]): Promise<AnyActorRef | null> {
    const state = await this.load(id);
    if (!state) return null;

    const machine = compileRunbookToMachine(steps);
    const actor = createActor(machine, {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      snapshot: state.snapshot as any
    });
    actor.start();
    return actor;
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
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(this.statePath(state.id), JSON.stringify(updated, null, 2));
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
    updates: Partial<Omit<RunbookState, 'id' | 'startedAt'>>
  ): Promise<RunbookState> {
    const existing = await this.load(id);
    if (!existing) {
      throw new Error(`Workflow ${id} not found`);
    }

    const updated: RunbookState = {
      ...existing,
      ...updates,
      variables: { ...existing.variables, ...(updates.variables ?? {}) },
      updatedAt: new Date().toISOString()
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Set the last result (pass/fail) for a runbook step.
   *
   * @param id - The runbook state ID
   * @param result - The result to record ('pass' or 'fail')
   * @throws Error if the runbook with the given ID is not found
   */
  async setLastResult(id: string, result: 'pass' | 'fail'): Promise<void> {
    await this.update(id, { lastResult: result });
  }

  /**
   * Check if a parent runbook was started in prompted mode.
   *
   * @param parentWorkflowId - The parent runbook state ID
   * @returns True if the parent runbook has prompted flag set, false otherwise
   */
  async isParentPrompted(parentWorkflowId: string): Promise<boolean> {
    const parent = await this.load(parentWorkflowId);
    return parent?.prompted ?? false;
  }

  /**
   * Update runbook state from an XState actor snapshot.
   *
   * Extracts the current step, substep, retry count, and variables from the
   * actor's persisted snapshot and updates the runbook state. Handles final
   * states (COMPLETE, STOPPED) by preserving the last step information.
   *
   * @param id - The runbook state ID
   * @param actor - The XState actor to extract state from
   * @param steps - The runbook step definitions for name resolution
   * @returns The updated runbook state
   * @throws Error if the runbook with the given ID is not found
   */
  async updateFromActor(id: string, actor: AnyActorRef, steps: Step[]): Promise<RunbookState> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const snapshot = actor.getPersistedSnapshot() as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const stateValue = snapshot.value as string;

    // If the runbook is in a final state, don't try to parse a step number.
    // Just update the snapshot and variables, preserving the last step number.
    if (stateValue === 'COMPLETE' || stateValue === 'STOPPED') {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const variables = (snapshot.context?.variables ?? {}) as Record<string, boolean | number | string>;
        return await this.update(id, { variables, snapshot });
    }

    // Parse step name from XState state value
    // Uses [^_]+ to match step name and substep ID (separated by underscore)
    const match = /^step_([^_]+)(?:_([^_]+))?$/.exec(stateValue);
    const stepName = match ? match[1] : steps[0].name;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let substep = snapshot.context.substep as string | undefined;
    if (!substep && match?.[2]) {
      substep = match[2];
    }

    // Find step by name (unified lookup)
    const step = steps.find(s => s.name === stepName) ?? steps[0];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const retryCount = snapshot.context?.retryCount as number;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const variables = (snapshot.context?.variables ?? {}) as Record<string, boolean | number | string>;

    return await this.update(id, {
      step: stepName,           // string
      substep,
      stepName: step.description,
      retryCount,
      variables,
      snapshot
    });
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
   * Get the currently active runbook for an agent.
   *
   * Returns the top runbook from the agent's stack. Supports both the new
   * stack-based format and the legacy activeRunbook format for backwards
   * compatibility during migration.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The active runbook state, or null if no runbook is active
   */
  async getActive(agentId?: string): Promise<RunbookState | null> {
    const session = await this.loadSession();

    // Migration: handle old format
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (session.activeRunbook && !session.stacks && !session.defaultStack) {
      return await this.load(session.activeRunbook);
    }

    let stack: string[];
    if (agentId) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      stack = session.stacks?.[agentId] ?? [];
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      stack = session.defaultStack ?? [];
    }

    const topId = stack[stack.length - 1];
    return topId ? await this.load(topId) : null;
  }

  /**
   * Set the active runbook ID directly in the session.
   *
   * @deprecated Use pushRunbook() and popRunbook() instead.
   * This method only sets activeRunbook for backwards compatibility.
   * New code should use the stack-based methods for proper per-agent isolation.
   *
   * @param id - The runbook state ID to set as active, or null to clear
   */
  async setActive(id: string | null): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });

    let session: SessionData = { activeRunbook: null, stacks: {}, defaultStack: [] };
    try {
      const content = await fs.readFile(this.sessionPath, 'utf8');
      session = JSON.parse(content) as SessionData;
    } catch {
      /* use default */
    }

    session.activeRunbook = id;
    await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
  }

  /**
   * Push a runbook onto an agent's runbook stack.
   *
   * Used when starting a new runbook or entering a nested/child runbook.
   * The pushed runbook becomes the active runbook for the agent.
   *
   * @param id - The runbook state ID to push
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   */
  async pushRunbook(id: string, agentId?: string): Promise<void> {
    const session = await this.loadSession();

    // Initialize stacks if not present (migration)
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!session.stacks) {
      session.stacks = {};
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!session.defaultStack) {
      session.defaultStack = [];
    }

    if (agentId) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!session.stacks[agentId]) {
        session.stacks[agentId] = [];
      }
      session.stacks[agentId].push(id);
    } else {
      session.defaultStack.push(id);
    }

    await this.saveSession(session);
  }

  /**
   * Pop a runbook from an agent's runbook stack.
   *
   * Used when completing or stopping a runbook. Removes the top runbook
   * and returns the new top (parent runbook) ID if one exists.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The new active runbook ID (parent), or null if the stack is empty
   */
  async popRunbook(agentId?: string): Promise<string | null> {
    const session = await this.loadSession();

    // Initialize if not present
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!session.stacks) {
      session.stacks = {};
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!session.defaultStack) {
      session.defaultStack = [];
    }

    let stack: string[];
    if (agentId) {
      stack = session.stacks[agentId] ?? [];
      stack.pop();
      session.stacks[agentId] = stack;
    } else {
      stack = session.defaultStack;
      stack.pop();
      session.defaultStack = stack;
    }

    await this.saveSession(session);

    // Return new top (parent runbook)
    return stack[stack.length - 1] ?? null;
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
   * Push a pending step onto the runbook's pending step queue.
   *
   * Pending steps are used to correlate Step tool dispatch with SubagentStart
   * events in orchestration scenarios.
   *
   * @param id - The runbook state ID
   * @param pending - The pending step to push (includes stepId and optional child runbook path)
   * @throws Error if the runbook with the given ID is not found
   */
  async pushPendingStep(id: string, pending: PendingStep): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Workflow ${id} not found`);

    await this.update(id, {
      pendingSteps: [...state.pendingSteps, pending]
    });
  }

  /**
   * Pop the first pending step from the runbook's pending step queue.
   *
   * @param id - The runbook state ID
   * @returns The first pending step, or null if the queue is empty or runbook not found
   */
  async popPendingStep(id: string): Promise<PendingStep | null> {
    const state = await this.load(id);
    if (!state || state.pendingSteps.length === 0) return null;

    const [first, ...rest] = state.pendingSteps;
    await this.update(id, { pendingSteps: rest });
    return first;
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
    if (!state) throw new Error(`Workflow ${id} not found`);

    const binding: AgentBinding = {
      stepId,
      status: 'running'
    };

    await this.update(id, {
      agentBindings: {
        ...state.agentBindings,
        [agentId]: binding
      }
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
    if (!state) throw new Error(`Workflow ${id} not found`);
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
    updates: Partial<Pick<AgentBinding, 'status' | 'result' | 'childRunbookId'>>
  ): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Workflow ${id} not found`);

    const existing = state.agentBindings[agentId];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!existing) throw new Error(`No binding for agent ${agentId}`);

    await this.update(id, {
      agentBindings: {
        ...state.agentBindings,
        [agentId]: { ...existing, ...updates }
      }
    });
  }

  /**
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Removes the active runbook from the agent's stack and stores its ID
   * in the session's stashed slot. Only one runbook can be stashed at a time.
   * Supports both the new stack-based format and legacy activeRunbook format.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The stashed runbook ID, or null if no runbook was active
   */
  async stash(agentId?: string): Promise<string | null> {
    const session = await this.loadSession();

    // Get the active runbook ID - check stacks first, then fall back to activeRunbook
    let activeId: string | null | undefined = null;

    if (agentId) {
      // Agent-specific stack
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const stack = session.stacks?.[agentId];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      activeId = stack?.[stack.length - 1];
    } else {
      // Check defaultStack first (new format), then activeRunbook (old format)
      const stack = session.defaultStack;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      activeId = stack && stack.length > 0 ? stack[stack.length - 1] : session.activeRunbook;
    }

    if (!activeId) return null;

    // Pop from appropriate stack
    if (agentId) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (session.stacks?.[agentId]) {
        session.stacks[agentId].pop();
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (session.defaultStack && session.defaultStack.length > 0) {
        session.defaultStack.pop();
      } else if (session.activeRunbook) {
        // Migration: clear activeRunbook for old format
        session.activeRunbook = null;
      }
    }

    // Store stashed ID (one per agent would need more complex structure)
    // For now, keep single stash for backwards compat
    session.stashedRunbookId = activeId;
    await this.saveSession(session);

    return activeId;
  }

  /**
   * Restore a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the agent's
   * stack, making it the active runbook again. Clears the stashed slot.
   * Supports both the new stack-based format and legacy activeRunbook format.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The restored runbook state, or null if nothing was stashed or runbook not found
   */
  async pop(agentId?: string): Promise<RunbookState | null> {
    const session = await this.loadSession();
    const stashedId = session.stashedRunbookId;

    if (!stashedId) return null;

    const state = await this.load(stashedId);
    if (!state) {
      session.stashedRunbookId = undefined;
      await this.saveSession(session);
      return null;
    }

    // Push back to appropriate location
    if (agentId) {
      // Agent-specific stack
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!session.stacks) session.stacks = {};
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!session.stacks[agentId]) session.stacks[agentId] = [];
      session.stacks[agentId].push(stashedId);
    } else {
      // Default stack (new format) or activeRunbook (old format for compat)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (session.defaultStack !== undefined || session.stacks !== undefined) {
        // New format: use defaultStack
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!session.defaultStack) session.defaultStack = [];
        session.defaultStack.push(stashedId);
      } else {
        // Old format: restore to activeRunbook
        session.activeRunbook = stashedId;
      }
    }

    session.stashedRunbookId = undefined;
    await this.saveSession(session);

    return state;
  }

  /**
   * Get the ID of the currently stashed runbook, if any.
   *
   * @returns The stashed runbook ID, or null if nothing is stashed
   */
  async getStashedRunbookId(): Promise<string | null> {
    const session = await this.loadSession();
    return session.stashedRunbookId ?? null;
  }

  private async loadSession(): Promise<SessionData> {
    try {
      const content = await fs.readFile(this.sessionPath, 'utf8');
      return JSON.parse(content) as SessionData;
    } catch {
      return { activeRunbook: null, stacks: {}, defaultStack: [] };
    }
  }

  private async saveSession(session: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    await fs.writeFile(this.sessionPath, JSON.stringify(session, null, 2));
  }

  /**
   * Get the result of a child runbook execution.
   *
   * Determines the result based on the child runbook's variables:
   * - Returns 'fail' if stopped is true
   * - Returns 'pass' if completed is true or runbook not found
   * - Returns null if the runbook is still in progress
   *
   * @param childId - The child runbook state ID
   * @returns 'pass', 'fail', or null if still in progress
   */
  async getChildRunbookResult(childId: string): Promise<'pass' | 'fail' | null> {
    const child = await this.load(childId);
    if (!child) return 'pass';

    if (child.variables.stopped === true) return 'fail';
    if (child.variables.completed === true) return 'pass';

    return null;
  }

  /**
   * Initialize substep tracking state for a runbook step.
   *
   * Creates SubstepState entries for all non-dynamic substeps with 'pending' status.
   * Dynamic substeps are added later via addDynamicSubstep.
   *
   * @param id - The runbook state ID
   * @param substeps - The substep definitions from the step
   * @throws Error if the runbook with the given ID is not found
   */
  async initializeSubsteps(id: string, substeps: readonly Substep[]): Promise<void> {
    const state = await this.load(id);
    if (!state) throw new Error(`Workflow ${id} not found`);

    const staticSubsteps = substeps.filter(s => !s.isDynamic);

    const substepStates: SubstepState[] = staticSubsteps.map(s => ({
      id: s.id,
      status: 'pending',
      agentId: undefined,
      result: undefined
    }));

    await this.update(id, { substepStates });
  }

  /**
   * Add a new dynamic substep to the runbook's substep tracking.
   *
   * Creates a new SubstepState with a sequential ID based on the current
   * count of substeps. Used for steps that support dynamic substep creation.
   *
   * @param id - The runbook state ID
   * @returns The ID of the newly created substep
   * @throws Error if the runbook with the given ID is not found
   */
  async addDynamicSubstep(id: string): Promise<string> {
    const state = await this.load(id);
    if (!state) throw new Error(`Workflow ${id} not found`);

    const existing = state.substepStates ?? [];
    const nextId = String(existing.length + 1);

    const newSubstep: SubstepState = {
      id: nextId,
      status: 'pending',
      agentId: undefined,
      result: undefined
    };

    await this.update(id, {
      substepStates: [...existing, newSubstep]
    });

    return nextId;
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
    if (!state) throw new Error(`Workflow ${runbookId} not found`);

    const substepStates = state.substepStates ?? [];
    const updated = substepStates.map(s =>
      s.id === substepId
        ? { ...s, status: 'running' as const, agentId }
        : s
    );

    await this.update(runbookId, { substepStates: updated });
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
    result: 'pass' | 'fail'
  ): Promise<void> {
    const state = await this.load(runbookId);
    if (!state) throw new Error(`Workflow ${runbookId} not found`);

    const substepStates = state.substepStates ?? [];
    const updated = substepStates.map(s =>
      s.id === substepId
        ? { ...s, status: 'done' as const, result }
        : s
    );

    await this.update(runbookId, { substepStates: updated });
  }
}
