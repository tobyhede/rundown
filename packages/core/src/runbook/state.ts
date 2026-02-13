// src/runbook/state.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import { createActor, type AnyActorRef } from 'xstate';
import {
  type RunbookState,
  type ForContext,
  type AgentBinding,
  type PendingStep,
  type Substep,
  type SubstepState,
  type Step,
  type Runbook,
  type DataSource,
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

    const machine = compileRunbookToMachine(steps, { sources: state.sources });

    // Migrate old snapshot context: flat FOR fields → forStack
    // Snapshot migration deals with untyped persisted data — any is unavoidable
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */
    const snapshot = state.snapshot as any;
    if (snapshot?.context && !snapshot.context.forStack) {
      const ctx = snapshot.context as any;
      if (ctx.forIteration !== undefined) {
        // Derive stepId from snapshot.value (authoritative) with state.step fallback
        const stateValue = snapshot.value as string | undefined;
        const stepMatch = stateValue
          ? (/^step::([^:]+)/.exec(stateValue) ?? /^step_([^_]+)/.exec(stateValue))
          : null;
        const stepId = stepMatch?.[1] ?? state.step;

        snapshot.context = {
          ...ctx,
          forStack: [
            {
              stepId,
              iteration: ctx.forIteration,
              start: ctx.forStart ?? 1,
              end: ctx.forEnd ?? ctx.forIteration,
              variable: ctx.forVariable,
            },
          ],
          forIteration: undefined,
          forStart: undefined,
          forEnd: undefined,
          forVariable: undefined,
        };
      } else {
        // No active loop — just ensure forStack exists
        snapshot.context = { ...ctx, forStack: [] };
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */

    const actor = createActor(machine, {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      snapshot,
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
   * @param parentRunbookId - The parent runbook state ID
   * @returns True if the parent runbook has prompted flag set, false otherwise
   */
  async isParentPrompted(parentRunbookId: string): Promise<boolean> {
    const parent = await this.load(parentRunbookId);
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
      const variables = (snapshot.context?.variables ?? {}) as Record<
        string,
        boolean | number | string
      >;
      return await this.update(id, {
        variables,
        snapshot,
        // Clear FOR loop state on completion
        forStack: undefined,
        iterationResults: undefined,
      });
    }

    // Parse step name from XState state value
    const primaryMatch = /^step::(.+?)(?:::(.+))?$/.exec(stateValue);
    const legacyMatch = !primaryMatch ? /^step_([^_]+)(?:_([^_]+))?$/.exec(stateValue) : null;
    if (legacyMatch) {
      console.warn(
        'Deprecated state-ID format "step_…" detected. Please restart execution to migrate to "step::…" format.',
      );
    }
    const match = primaryMatch ?? legacyMatch;
    const stepName = match ? match[1] : steps[0].name;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    let substep = snapshot.context.substep as string | undefined;
    if (!substep && match?.[2]) {
      substep = match[2];
    }

    // Find step by name (unified lookup)
    const step = steps.find((s) => s.name === stepName) ?? steps[0];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const retryCount = snapshot.context?.retryCount as number;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const variables = (snapshot.context?.variables ?? {}) as Record<
      string,
      boolean | number | string
    >;

    // FOR loop context
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const forStack = snapshot.context?.forStack as ForContext[] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const iterationResults = snapshot.context?.iterationResults as ('pass' | 'fail')[] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const lastAction = snapshot.context?.lastAction as RunbookState['lastAction'];

    return await this.update(id, {
      step: stepName, // string
      substep,
      stepName: step.description,
      retryCount,
      variables,
      snapshot,
      // Filter implicit ForContext entries — don't persist synthetic loop state
      forStack: (() => {
        const realForStack = forStack?.filter((fc) => !fc.implicit);
        return realForStack?.length ? realForStack : undefined;
      })(),
      // Only clear iterationResults when all stack entries were implicit.
      // When forStack is empty after explicit FOR exit, iterationResults
      // must be preserved for parent-step aggregation.
      iterationResults: (() => {
        const hasOnlyImplicit = forStack?.length ? forStack.every((fc) => fc.implicit) : false;
        return hasOnlyImplicit ? undefined : iterationResults;
      })(),
      lastAction,
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
   * Returns the top runbook from the agent's stack.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The active runbook state, or null if no runbook is active
   */
  async getActive(agentId?: string): Promise<RunbookState | null> {
    const session = await this.loadSession();

    let stack: string[];
    if (agentId) {
      stack = session.stacks[agentId] ?? [];
    } else {
      stack = session.defaultStack;
    }

    const topId = stack[stack.length - 1];
    return topId ? await this.load(topId) : null;
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

    if (agentId) {
      const stack = session.stacks[agentId];
      if (stack) {
        stack.push(id);
      } else {
        session.stacks[agentId] = [id];
      }
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

    let stack: string[];
    if (agentId) {
      stack = session.stacks[agentId] ?? [];
      stack.pop();
      session.stacks[agentId] = stack;
    } else {
      stack = session.defaultStack;
      stack.pop();
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
    if (!state) throw new Error(`Runbook ${id} not found`);

    await this.update(id, {
      pendingSteps: [...state.pendingSteps, pending],
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
   * Stash the currently active runbook to allow temporarily switching contexts.
   *
   * Removes the active runbook from the agent's stack and stores its ID
   * in the session's stashed slot. Only one runbook can be stashed at a time.
   *
   * @param agentId - Optional agent ID; if omitted, uses the default stack
   * @returns The stashed runbook ID, or null if no runbook was active
   */
  async stash(agentId?: string): Promise<string | null> {
    const session = await this.loadSession();

    let activeId: string | undefined;
    if (agentId) {
      const stack = session.stacks[agentId];
      if (!stack || stack.length === 0) return null;
      activeId = stack[stack.length - 1];
      stack.pop();
    } else {
      const stack = session.defaultStack;
      if (stack.length === 0) return null;
      activeId = stack[stack.length - 1];
      stack.pop();
    }

    session.stashedRunbookId = activeId;
    await this.saveSession(session);

    return activeId;
  }

  /**
   * Restore a previously stashed runbook to the active stack.
   *
   * Retrieves the stashed runbook ID and pushes it back onto the agent's
   * stack, making it the active runbook again. Clears the stashed slot.
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

    // Push back to appropriate stack
    if (agentId) {
      const stack = session.stacks[agentId];
      if (stack) {
        stack.push(stashedId);
      } else {
        session.stacks[agentId] = [stashedId];
      }
    } else {
      session.defaultStack.push(stashedId);
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
      return { stacks: {}, defaultStack: [] };
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
