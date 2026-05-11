// packages/cli/src/services/execution.ts

import * as fs from 'node:fs/promises';
import {
  assertRunId,
  type RunId,
  buildStepPosition,
  deriveExecutionAt,
  buildCompletionKey,
  deriveActiveFrame,
  parseActionType,
  type ActionType,
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type RunbookStateManager,
  RunbookActorService,
  SessionService,
  ExecutionLifecycleService,
  ForIterationService,
  logger,
  mergeEffectiveVars,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type ExecutionResult,
  executeCommand,
  executeCommandWithEnv,
  executeCommandWithPolicy,
  countNumberedSteps,
  extractDisplayCommand,
  type ExecutionEventEmitter,
  type ForContext,
  type FrameKey,
  type TemplateVarValue,
  isJsonArray,
  isJsonArrayStream,
  assertResolvedVariableForContext,
  ForResolutionError,
  RUNS_DIR,
  createDelegation,
  Errors,
  isError,
  RundownError,
  ErrorCodes,
  type DelegateFrontierEntry,
  partitionOutputDeclarations,
  prepareOutputChannels,
  resolveCurrentExecutionUnit,
  type OutputScope,
  type PreparedChannel,
} from '@rundown-org/core';
import {
  isSourced,
  resolvedStepHasSubsteps,
  type ForClause,
  type OutputDeclaration,
} from '@rundown-org/parser';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import type { StepVariables } from './execution-vars.js';
import { inferAllDelegateSubsteps } from '../helpers/delegate-inference.js';
import { buildRunbookRef, resolveRunbookFile } from '../helpers/resolve-runbook.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { expandLoopVariables, expandLoopVariablesForCommand } from './template-renderer.js';
import { BUILTIN_VARIABLES } from './variable-discovery.js';
import {
  orchestrateTransition,
  transitionSinkFromEmitter,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';

/**
 * Build per-step dynamic variables for Phase 2 expansion.
 *
 * Always returns a variable map containing at least `Step` (the qualified step
 * identifier). When inside an explicit FOR loop, also includes `Index` and any
 * named loop variable.
 *
 * Falls back to the step's `forClause` definition when `forStack` is empty
 * (initial state created without actor snapshot, before first transition).
 *
 * @param stepId - Current step identifier (e.g., "3" or "ErrorHandler")
 * @param substepId - Optional substep identifier (e.g., "1")
 * @param forStack - Current FOR loop stack from persisted state
 * @param forClause - FOR clause from the step definition (bootstrap fallback)
 * @param templateVars - Static template variables for context-aware expansion
 * @returns Variable map with `Step` and optional `Index` / named variable
 * @throws {Error} if a sourced FOR clause references a missing data source
 * @throws {Error} if an unexpected source kind is encountered
 */
export function buildStepVariables(
  stepId: string,
  substepId: string | undefined,
  forStack?: readonly ForContext[],
  forClause?: ForClause,
  templateVars?: Readonly<Record<string, TemplateVarValue>>,
): StepVariables {
  const step = substepId ? `${stepId}.${substepId}` : stepId;
  const vars: StepVariables = {
    ...(templateVars ?? {}),
    Step: step,
    step,
    'context.current.step': step,
  };
  if (substepId) {
    vars['context.current.substep'] = substepId;
  }

  // Primary: use forStack (available after first transition)
  if (forStack?.length) {
    const top = forStack[forStack.length - 1];
    if (!top.implicit) {
      vars.Index = String(top.iteration);
      vars.index = String(top.iteration);
      vars['context.current.index'] = String(top.iteration);
      vars['context.current.at'] = deriveExecutionAt(stepId, substepId, top.iteration);

      if (top.variable) {
        switch (top.source.kind) {
          case 'range':
            vars[top.variable] = String(top.iteration);
            break;
          case 'variable':
            // currentValue must be set by ForIterationService before each iteration.
            // If missing, it is a protocol violation — fail hard rather than silently producing ''.
            assertResolvedVariableForContext(top);
            vars[top.variable] = top.currentValue;
            break;
          default: {
            const _exhaustive: never = top.source;
            throw new Error(`Unexpected source kind: ${(top.source as { kind: string }).kind}`);
          }
        }
      }
    }
  } else if (forClause) {
    // Bootstrap: first iteration before actor has run
    if (isSourced(forClause)) {
      const varValue = templateVars?.[forClause.source];
      if (varValue !== undefined && isJsonArray(varValue)) {
        // JsonArray: clamp start and index into array
        const clampedStart = Math.max(1, Math.min(forClause.start, varValue.length));
        vars.Index = String(clampedStart);
        vars.index = String(clampedStart);
        vars['context.current.index'] = String(clampedStart);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, clampedStart);
        vars[forClause.variable] = varValue[clampedStart - 1] ?? '';
      } else if (varValue !== undefined && isJsonArrayStream(varValue)) {
        // JsonArrayStream: value resolved lazily by actor
        vars.Index = String(forClause.start);
        vars.index = String(forClause.start);
        vars['context.current.index'] = String(forClause.start);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
        vars[forClause.variable] = '';
      } else {
        // Variable undefined or not iterable — set defaults
        vars.Index = String(forClause.start);
        vars.index = String(forClause.start);
        vars['context.current.index'] = String(forClause.start);
        vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
        vars[forClause.variable] = '';
      }
    } else {
      // Numeric range (original behavior)
      vars.Index = String(forClause.start);
      vars.index = String(forClause.start);
      vars['context.current.index'] = String(forClause.start);
      vars['context.current.at'] = deriveExecutionAt(stepId, substepId, forClause.start);
      if (forClause.variable) {
        vars[forClause.variable] = String(forClause.start);
      }
    }
  }

  if (!Object.hasOwn(vars, 'context.current.at')) {
    vars['context.current.at'] = deriveExecutionAt(stepId, substepId);
  }

  return vars;
}

/**
 * Find a step by name, throwing if not found.
 *
 * Replaces silent `steps[0]` fallbacks that mask state corruption.
 *
 * @param steps - Parsed runbook steps
 * @param stepName - Step name to find
 * @returns The matching step
 * @throws {Error} if step is not found (indicates state corruption)
 */
export function findStepOrThrow(steps: ResolvedStep[], stepName: string): ResolvedStep {
  const step = steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`Step '${stepName}' not found — possible state corruption`);
  return step;
}

/**
 * Derive the output-channel scope for the unit currently being executed.
 *
 * Produces one of three tier compositions:
 * - `{ stepId }` — step-level (no substep, no iteration)
 * - `{ stepId, substep: { id } }` — substep-level, no FOR loop
 * - `{ stepId, substep: { id, iteration } }` — substep inside a FOR loop
 *
 * Tier population:
 * - substep tier: set from `substepId` when both `isSubstep` is true and
 *   `substepId` is defined — the `isSubstep` guard is a belt-and-suspenders
 *   check; the nested type makes iteration-without-substep unrepresentable
 * - iteration tier: set from `top.iteration` when `isSubstep` is true AND
 *   the top FOR frame is non-implicit and its `stepId` matches
 *   `currentState.step`
 *
 * Implicit FOR frames contribute no iteration tier — implicit frames have no
 * user-visible counter to segment the path with.
 *
 * @param currentState - The runbook state at the moment of execution
 * @param isSubstep - Whether the current execution unit is a substep
 * @param substepId - The substep id when isSubstep is true
 * @returns OutputScope suitable for `outputChannelPath` / `prepareOutputChannels`
 */
export function deriveOutputScope(
  currentState: RunbookState,
  isSubstep: boolean,
  substepId?: string,
): OutputScope {
  const stepId = currentState.step;
  if (!isSubstep || substepId === undefined) {
    return { stepId };
  }
  const top = currentState.forStack?.at(-1);
  if (top && !top.implicit && top.stepId === stepId) {
    return { stepId, substep: { id: substepId, iteration: top.iteration } };
  }
  return { stepId, substep: { id: substepId } };
}

/**
 * Extract the OUTPUTS declarations attached to the execution unit currently
 * being run. For a substep, return the substep's OUTPUTS; for a step-level
 * command, return the parent step's OUTPUTS.
 *
 * @param currentStep - The resolved parent step
 * @param isSubstep - Whether a substep is being executed
 * @param substepId - The substep id when isSubstep is true
 * @returns Output declarations or empty array
 */
export function extractUnitOutputs(
  currentStep: ResolvedStep,
  isSubstep: boolean,
  substepId?: string,
): readonly OutputDeclaration[] {
  if (isSubstep && substepId !== undefined && resolvedStepHasSubsteps(currentStep)) {
    const sub = currentStep.substeps.find((s) => s.id === substepId);
    return sub?.outputs ?? [];
  }
  return currentStep.outputs ?? [];
}

type TransitionApplicationResult =
  | { status: 'continue'; state: RunbookState }
  | { status: 'done' }
  | { status: 'stopped' };

interface ObserveAndOrchestrateArgs {
  manager: RunbookStateManager;
  actorService: RunbookActorService;
  sessionService: SessionService;
  lifecycleService: ExecutionLifecycleService;
  emitter: ExecutionEventEmitter;
  runbookId: RunId;
  steps: ResolvedStep[];
  currentState: RunbookState;
  currentStep: ResolvedStep;
  result: 'pass' | 'fail';
  transitionPolicy: TransitionOrchestrationPolicy;
  computeActionResult?: (actionType: ActionType) => boolean;
  command?: string;
  syncSnapshot: unknown;
  postState: RunbookState;
}

type ApplyDrainedCompletionArgs = Omit<ObserveAndOrchestrateArgs, 'syncSnapshot' | 'postState'>;
type ObserveCommandTransitionArgs = ObserveAndOrchestrateArgs;

const EXECUTION_TERMINAL_POLICY: TransitionOrchestrationPolicy = {
  onComplete: {
    releaseRunbook: true,
  },
  onStopped: {
    releaseRunbook: true,
  },
};

const EXECUTION_TERMINAL_NO_STACK_POLICY: TransitionOrchestrationPolicy = {
  onComplete: {
    releaseRunbook: false,
  },
  onStopped: {
    releaseRunbook: false,
  },
};

/**
 * Session cleanup behavior to apply when an execution loop reaches a terminal state.
 */
export type ExecutionTerminalReleaseMode = 'stack-pop' | 'release-runbook';

/**
 * Optional behavior overrides for {@link runExecutionLoop}.
 */
export interface ExecutionLoopOptions {
  /**
   * Selects whether terminal cleanup pops the default active stack or releases
   * the loop's own runbook id from all session targeting structures.
   */
  readonly terminalReleaseMode?: ExecutionTerminalReleaseMode;
}

async function applyExecutionTerminalRelease(
  sessionService: SessionService,
  runbookId: RunId,
  mode: ExecutionTerminalReleaseMode,
): Promise<void> {
  if (mode === 'release-runbook') {
    await sessionService.releaseRunbook(runbookId);
    return;
  }
  await sessionService.popRunbook();
}

/**
 * Extract a RETRY_ERROR diagnostic from a persisted XState snapshot.
 *
 * Reads `context.lastAction` and returns `code`/`message` only when the
 * variant is `RETRY_ERROR`. Other lastAction variants (including `STOP`)
 * return undefined — `STOP` is a pure domain action, not a machine-internal
 * failure signal.
 *
 * The retry hook writes a `RetryErrorLastAction` onto `context.lastAction`
 * when `createDelegation` surfaces an error variant during a parent-level
 * retry (or an invariant is violated). The priority-0 always-entry in the
 * compiler then
 * routes the machine to STOPPED. This helper narrows the opaque snapshot
 * envelope into the error record so the CLI can emit `ERROR_OCCURRED`
 * before the terminal RUNBOOK_STOPPED event.
 *
 * @param snapshot - Raw persisted XState snapshot (unknown shape)
 * @returns Coded diagnostic, or undefined if lastAction is not RETRY_ERROR
 */
function extractRetryError(snapshot: unknown): { code: string; message: string } | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined;
  const ctx = (snapshot as { context?: unknown }).context;
  if (typeof ctx !== 'object' || ctx === null) return undefined;
  const lastAction = (ctx as { lastAction?: unknown }).lastAction;
  if (typeof lastAction !== 'object' || lastAction === null) return undefined;
  const record = lastAction as { type?: unknown; code?: unknown; message?: unknown };
  if (record.type !== 'RETRY_ERROR') return undefined;
  if (typeof record.code !== 'string' || typeof record.message !== 'string') return undefined;
  return { code: record.code, message: record.message };
}

async function observeAndOrchestrate({
  manager,
  sessionService,
  lifecycleService,
  emitter,
  runbookId,
  steps,
  currentState,
  currentStep,
  result,
  transitionPolicy,
  computeActionResult,
  command,
  syncSnapshot,
  postState,
}: ObserveAndOrchestrateArgs): Promise<TransitionApplicationResult> {
  const actionType = parseActionType(extractLastAction(syncSnapshot));
  const ensured = await lifecycleService.ensureActiveEntry(runbookId, currentState, postState);
  const actionResult = computeActionResult ? computeActionResult(actionType) : result === 'pass';

  // If the retry hook failed and the machine routed to STOPPED as a result,
  // emit ERROR_OCCURRED so the orchestrator/CLI observer sees the root cause.
  // This must precede orchestrateTransition (which emits the terminal
  // RUNBOOK_STOPPED event), so consumers can correlate the error with the
  // stop. RETRY_ERROR is a machine-internal failure, not a normal fail
  // transition — hence the dedicated event. A plain STOP action (authored
  // STOP transitions, `rd stop`) does NOT emit ERROR_OCCURRED.
  if (ensured.state.lifecycle === 'stopped') {
    const retryError = extractRetryError(syncSnapshot);
    if (retryError) {
      emitter.emit('ERROR_OCCURRED', {
        message: retryError.message,
        code: retryError.code,
      });
    }
  }

  const orchestration = await orchestrateTransition({
    manager,
    sessionService,
    sink: transitionSinkFromEmitter(emitter),
    runbookId,
    steps,
    currentStep,
    previousState: currentState,
    updatedState: ensured.state,
    snapshot: syncSnapshot,
    result,
    actionResult,
    policy: transitionPolicy,
    command,
  });

  if (orchestration.status === 'continue') {
    return { status: 'continue', state: orchestration.state };
  }
  return { status: orchestration.status };
}

/**
 * Drain path: result is fresh-to-the-machine, send PASS/FAIL ourselves.
 *
 * @remarks Used by substep-completion drain. When delegation batch (migration
 * row 4) moves drain into the machine, this function collapses into
 * observeCommandTransition and is removed.
 */
async function applyDrainedCompletion(
  args: ApplyDrainedCompletionArgs,
): Promise<TransitionApplicationResult> {
  const syncResult = await args.actorService.sendAndSync(args.runbookId, args.steps, {
    type: args.result === 'pass' ? 'PASS' : 'FAIL',
  });
  if (!syncResult) return { status: 'stopped' };
  return observeAndOrchestrate({
    ...args,
    syncSnapshot: syncResult.snapshot,
    postState: syncResult.state,
  });
}

/**
 * Command path: machine has already raised PASS/FAIL from COMMAND_RESULT's
 * capture sibling onDone. Just observe.
 */
async function observeCommandTransition(
  args: ObserveCommandTransitionArgs,
): Promise<TransitionApplicationResult> {
  return observeAndOrchestrate(args);
}

/** Arguments for draining resolved substep completions. */
export interface DrainResolvedCompletionsArgs {
  /** State manager for raw state persistence. */
  manager: RunbookStateManager;
  /** Actor service for sending events to the runbook machine. */
  actorService: RunbookActorService;
  /** Session service for active runbook tracking. */
  sessionService: SessionService;
  /** Lifecycle service for completion read/write operations. */
  lifecycleService: ExecutionLifecycleService;
  /** Event emitter for execution progress notifications. */
  emitter: ExecutionEventEmitter;
  /** ID of the runbook being drained. */
  runbookId: RunId;
  /** Parsed step definitions for the runbook. */
  steps: ResolvedStep[];
  /** Current persisted runbook state. */
  currentState: RunbookState;
  /** Policy governing transition orchestration. */
  transitionPolicy: TransitionOrchestrationPolicy;
  /** Optional function to compute action result for transition evaluation. */
  computeActionResult?: (actionType: ActionType) => boolean;
  /** Optional command string for event context. */
  command?: string;
  /** Override frame key for frame-scoped lookups (e.g., prompted-for with explicit --index). */
  frameKeyOverride?: FrameKey;
}

/** Result of draining resolved substep completions. */
export type DrainResolvedCompletionsResult =
  | {
      /** Drain succeeded with remaining substeps to process. */
      status: 'continue';
      state: RunbookState;
      unresolved: number;
      applied: number;
    }
  | {
      /** All substeps resolved and runbook completed. */ status: 'done';
      unresolved: number;
      applied: number;
    }
  | {
      /** Runbook stopped due to a STOP transition. */ status: 'stopped';
      unresolved: number;
      applied: number;
    };

/**
 * Deterministically drain resolved substep completions for the active frame+entry.
 *
 * Applies completions in substep order and stops at the first unresolved substep.
 *
 * @param args - Drain arguments including state manager, services, and current state
 * @param args.manager - State manager for raw state persistence
 * @param args.actorService - Actor service for sending events to the runbook machine
 * @param args.sessionService - Session service for active runbook tracking
 * @param args.lifecycleService - Lifecycle service for completion read/write operations
 * @param args.emitter - Event emitter for execution progress notifications
 * @param args.runbookId - ID of the runbook being drained
 * @param args.steps - Parsed step definitions for the runbook
 * @param args.currentState - Current persisted runbook state
 * @param args.transitionPolicy - Policy governing transition orchestration
 * @param args.computeActionResult - Optional function to compute action result for transitions
 * @param args.command - Optional command string for event context
 * @param args.frameKeyOverride - Optional frame key override for frame-scoped lookups (e.g., prompted-for with explicit --index)
 * @returns Drain result indicating continue/done/stopped with counts of applied and unresolved completions
 */
export async function drainResolvedCompletions({
  manager,
  actorService,
  sessionService,
  lifecycleService,
  emitter,
  runbookId,
  steps,
  currentState,
  transitionPolicy,
  computeActionResult,
  command,
  frameKeyOverride,
}: DrainResolvedCompletionsArgs): Promise<DrainResolvedCompletionsResult> {
  let state = currentState;
  let applied = 0;

  // Loop invariant: `state` always reflects the latest persisted runbook state.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, state.step);
    const hasActiveSubsteps =
      resolvedStepHasSubsteps(currentStep) && currentStep.substeps.length > 0 && !!state.substep;
    if (!hasActiveSubsteps) {
      return { status: 'continue', state, unresolved: 0, applied };
    }

    const ensured = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
    state = ensured.state;

    const derivedFrame = deriveActiveFrame(state);
    const frameKey = frameKeyOverride ?? derivedFrame.frameKey;
    const entry = state.activeEntry ?? ensured.entry;
    const orderedSubsteps = currentStep.substeps.map((s) => s.id);
    const resolved = await lifecycleService.listResolvedCompletions(runbookId, frameKey, entry);
    const resolvedBySubstep = new Map(
      resolved
        .filter(
          (r): r is typeof r & { completion: { targetSubstep: string } } =>
            r.completion.targetSubstep !== undefined,
        )
        .map(({ completion }) => [completion.targetSubstep, completion]),
    );

    const unresolved = orderedSubsteps.filter((id) => !resolvedBySubstep.has(id)).length;

    const cursorKey = buildCompletionKey(frameKey, entry, state.substep);
    const completion = await lifecycleService.consumeResolvedCompletion(runbookId, cursorKey);
    if (!completion) {
      return { status: 'continue', state, unresolved, applied };
    }

    const transitionResult = await applyDrainedCompletion({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState: state,
      currentStep,
      result: completion.result,
      transitionPolicy,
      computeActionResult,
      command,
    });
    applied += 1;

    if (transitionResult.status === 'done' || transitionResult.status === 'stopped') {
      // Defense-in-depth: warn if terminal status reached with unresolved substeps
      const remainingUnresolved = orderedSubsteps.filter(
        (id) => !resolvedBySubstep.has(id) && id !== completion.targetSubstep,
      ).length;
      if (remainingUnresolved > 0) {
        void logger.warn('drainResolvedCompletions: terminal status with unresolved substeps', {
          runbookId,
          stepName: currentStep.name,
          status: transitionResult.status,
          substepCount: orderedSubsteps.length,
          // resolvedBySubstep.size excludes the current completion (filtered separately above)
          resolvedCount: resolvedBySubstep.size,
          unresolvedCount: remainingUnresolved,
          appliedSubstep: state.substep,
        });
      }
      return { status: transitionResult.status, unresolved: 0, applied };
    }
    state = transitionResult.state;
  }
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Runbook state manager instance
 * @param runbookIdRaw - Unbranded run id; branded to RunId on entry
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
 * @param emitter - Event emitter for execution events
 * @param options - Optional execution loop behavior overrides
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookIdRaw: string,
  steps: ResolvedStep[],
  cwd: string,
  prompted: boolean,
  emitter: ExecutionEventEmitter,
  options: ExecutionLoopOptions = {},
): Promise<'done' | 'stopped' | 'waiting'> {
  const runbookId: RunId = assertRunId(runbookIdRaw);
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

  const terminalReleaseMode = options.terminalReleaseMode ?? 'stack-pop';
  const terminalPolicy =
    terminalReleaseMode === 'release-runbook'
      ? EXECUTION_TERMINAL_NO_STACK_POLICY
      : EXECUTION_TERMINAL_POLICY;

  // Service for resolving FOR loop iteration values (array, file, range)
  const actorService = new RunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  let projectRoot: string;
  try {
    projectRoot = await fs.realpath(cwd);
  } catch (err: unknown) {
    void logger.warn(
      `runExecutionLoop: fs.realpath("${cwd}") failed, using raw path: ${isError(err) ? err.message : String(err)}`,
    );
    projectRoot = cwd;
  }
  const iterationService = new ForIterationService(manager, actorService, projectRoot);
  const ensuredInitial = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
  let currentState: RunbookState = ensuredInitial.state;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, currentState.step);

    const totalSteps = countNumberedSteps(steps);

    // Determine the active execution unit: substep if we're at one, otherwise the step.
    const itemToRender = resolveCurrentExecutionUnit(currentStep, currentState.substep);

    // Resolve dynamic values for all FOR sources before each iteration.
    // ForIterationService owns array, file, and range currentValue hydration.
    let iterResult: Awaited<ReturnType<typeof iterationService.prepareIteration>>;
    try {
      iterResult = await iterationService.prepareIteration(runbookId, steps);
    } catch (err) {
      if (err instanceof ForResolutionError && err.code === 'policy-violation') {
        const policyPosition = buildStepPosition(
          currentState.step,
          countNumberedSteps(steps),
          currentState.substep,
          currentState.forStack,
        );
        emitter.emit('POLICY_DENIED', {
          command: `JsonArrayStream variable access`,
          reason: err.message,
          position: policyPosition,
        });
        await manager.update(runbookId, { lifecycle: 'stopped' });
        emitter.emit('RUNBOOK_STOPPED', {
          position: policyPosition,
          reason: 'policy_denied',
          message: `FOR loop data source blocked by policy: ${err.message}`,
        });
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
        return 'stopped';
      }
      throw err;
    }

    if (iterResult.status === 'exhausted') {
      if (iterResult.terminal === 'complete') {
        const completionMessage = extractLastMessage(iterResult.state.snapshot);

        await manager.update(runbookId, {
          lifecycle: 'completed',
        });

        emitter.emit('RUNBOOK_COMPLETED', {
          message: completionMessage,
          finalPosition: buildStepPosition(
            iterResult.state.step,
            totalSteps,
            iterResult.state.substep,
            iterResult.state.forStack,
          ),
        });
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
        return 'done';
      }
      if (iterResult.terminal === 'stopped') {
        const stopMessage = extractLastMessage(iterResult.state.snapshot);

        await manager.update(runbookId, {
          lifecycle: 'stopped',
        });

        const stopPos = buildStepPosition(
          iterResult.state.step,
          totalSteps,
          iterResult.state.substep,
          iterResult.state.forStack,
        );
        emitter.emit('RUNBOOK_STOPPED', {
          message: stopMessage,
          position: stopPos,
          reason: 'fail_transition',
        });

        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
        return 'stopped';
      }
      // No terminal state — machine transitioned to next step after loop exit
      const ensured = await lifecycleService.ensureActiveEntry(
        runbookId,
        currentState,
        iterResult.state,
      );
      currentState = ensured.state;
      continue;
    }

    if (iterResult.status === 'ready') {
      // Value resolved — re-enter loop with populated currentValue
      const ensured = await lifecycleService.ensureActiveEntry(
        runbookId,
        currentState,
        iterResult.state,
      );
      currentState = ensured.state;
      continue;
    }

    const drainResult = await drainResolvedCompletions({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState,
      transitionPolicy: terminalPolicy,
    });
    if (drainResult.status === 'done') {
      if (terminalReleaseMode === 'release-runbook') {
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      }
      return 'done';
    }
    if (drainResult.status === 'stopped') {
      if (terminalReleaseMode === 'release-runbook') {
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      }
      return 'stopped';
    }
    if (drainResult.applied > 0) {
      currentState = drainResult.state;
      continue;
    }

    // Expand per-step dynamic variables ({{Step}}, {{Index}}, {{var}}) for current iteration.
    // mergeEffectiveVars overlays state.variables (step OUTPUTS) on state.templateVars
    // (seeded inputs) so subsequent steps can reference outputs from prior steps in
    // descriptions, prompts, and OUTPUTS expressions. Sole producer of EffectiveVars
    // — same precedence as buildContextSnapshot and buildExecutionFrame.
    const mergedTemplateVars = mergeEffectiveVars(currentState);
    const stepVars = buildStepVariables(
      currentState.step,
      currentState.substep,
      currentState.forStack,
      currentStep.kind === 'for' ? currentStep.forClause : undefined,
      mergedTemplateVars,
    );
    const helperOptions = { cwd };
    const expandedDescription = expandLoopVariables(
      itemToRender.description,
      stepVars,
      helperOptions,
    );
    // For prompted-for substeps, fall back to the step-level prompt (the reconstructed FOR text)
    const rawPrompt =
      itemToRender.prompt ?? (currentStep.kind === 'prompted-for' ? currentStep.prompt : undefined);
    const expandedPrompt = rawPrompt
      ? expandLoopVariables(rawPrompt, stepVars, helperOptions)
      : rawPrompt;

    // Emit STEP_ENTERED event
    const stepPosition = buildStepPosition(
      currentState.step,
      totalSteps,
      currentState.substep,
      currentState.forStack,
    );
    const isSubstep = 'id' in itemToRender;
    const command = isSubstep
      ? itemToRender.command
      : currentStep.kind === 'command'
        ? currentStep.command
        : undefined;

    // Compute before STEP_ENTERED so the event includes the prompted FOR flag
    const stepIsPrompted = currentStep.kind === 'prompted-for';

    // Delegation frontier emission.
    // Prefer a pre-issued frontier from the retry hook (context.pendingDelegateFrontier)
    // over re-running auto-issuance. If consumed, signal the machine to clear the
    // context field via PENDING_FRONTIER_CONSUMED after the emit.
    //
    // The pending branch handles manual delegations as well (parents with no
    // step-level DELEGATE annotation that nonetheless have live delegations
    // re-issued by the retry hook), so it cannot be gated on `delegate: true`.
    // Auto-issuance, however, only runs for steps whose substeps declare
    // `delegate: true`, and `getContextSnapshot` is skipped entirely on
    // non-substep entries to avoid materialising an actor every loop.
    let delegateFrontier: Array<DelegateFrontierEntry> | undefined;
    let pendingFrontierConsumed = false;

    if (isSubstep) {
      const pendingSnapshot = await actorService.getContextSnapshot(runbookId, steps);
      const pending = pendingSnapshot?.pendingDelegateFrontier;

      if (pending && pending.length > 0) {
        delegateFrontier = [...pending];
        pendingFrontierConsumed = true;
      } else {
        // Auto-issue delegation tokens on entry to the first substep of a step
        // whose substeps declare `delegate: true`.
        const isDelegateStepEntry =
          resolvedStepHasSubsteps(currentStep) &&
          currentState.substep === currentStep.substeps[0]?.id &&
          currentStep.substeps.some((sub) => sub.delegate);

        if (isDelegateStepEntry) {
          const targets = inferAllDelegateSubsteps(currentState, steps);

          if (targets.length > 0) {
            try {
              const fanOut: Array<DelegateFrontierEntry> = [];
              let threadedState = currentState;
              const frameKey =
                threadedState.activeFrameKey ?? deriveActiveFrame(threadedState).frameKey;

              for (const target of targets) {
                const childResolved = await resolveRunbookFile(cwd, target.runbookRef);
                if (!childResolved) {
                  throw Errors.delegationRunbookNotFound(target.runbookRef);
                }
                const childRunbookRef = await buildRunbookRef(childResolved);

                const result = createDelegation(
                  {
                    state: threadedState,
                    stepId: target.stepId,
                    childRunbookPath: childResolved.path,
                    childRunbookRef,
                    extraVars: undefined,
                    ancestors: [],
                    frameKey,
                  },
                  steps,
                );

                switch (result.status) {
                  case 'step_not_found':
                  case 'step_not_current':
                  case 'substep_required':
                  case 'substep_not_found':
                  case 'delegation_exists':
                  case 'parent_is_delegated':
                    // All-or-nothing fan-out: reject the whole batch and re-throw so
                    // the outer catch block transitions the runbook to stopped with
                    // the same RUNBOOK_STOPPED envelope as pre-refactor.
                    // threadedState is local; no partial persistence.
                    throw result.error;
                  case 'created':
                    threadedState = {
                      ...threadedState,
                      substepStates: result.updatedSubstepStates,
                    };
                    fanOut.push({
                      id: target.stepId,
                      runbook: target.runbookRef,
                      token: result.token,
                    });
                    break;
                  default: {
                    const _exhaustive: never = result;
                    return _exhaustive;
                  }
                }
              }

              // Persist all tokens in one write
              await manager.update(runbookId, { substepStates: threadedState.substepStates });
              delegateFrontier = fanOut;
            } catch (err) {
              // All-or-nothing fan-out (see inner rethrow comment above):
              // nothing is persisted for this fan-out on error. Transition the
              // runbook to stopped so it does not strand on a DELEGATE step
              // waiting for tokens that will never be issued.
              const message = isError(err) ? err.message : String(err);
              const reason =
                err instanceof RundownError &&
                err.errorCode === ErrorCodes.DELEGATION_NESTED_FORBIDDEN
                  ? 'nested_delegation_forbidden'
                  : 'delegation_resolution_failed';
              await manager.update(runbookId, { lifecycle: 'stopped' });
              emitter.emit('RUNBOOK_STOPPED', {
                message,
                position: stepPosition,
                reason,
              });
              await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
              return 'stopped';
            }
          }
        }
      }
    }

    // Expand once: artifact-producing helpers in command code append a manifest
    // row per call, so a second expansion would duplicate the entries.
    const expandedCommandCode = command
      ? expandLoopVariablesForCommand(command.code, stepVars, helperOptions)
      : undefined;

    emitter.emit('STEP_ENTERED', {
      position: stepPosition,
      stepName: isSubstep ? itemToRender.id : itemToRender.name,
      description: expandedDescription,
      prompt: expandedPrompt,
      hasCommand: !!command,
      commandCode: expandedCommandCode,
      commandLang: command?.lang,
      isSubstep,
      prompted: prompted || stepIsPrompted,
      delegateFrontier,
    });

    if (pendingFrontierConsumed) {
      await actorService.sendAndSync(runbookId, steps, {
        type: 'PENDING_FRONTIER_CONSUMED',
      });
    }

    // If CLI prompted mode, per-step prompted FOR, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || stepIsPrompted || expandedCommandCode === undefined) {
      return 'waiting';
    }

    // --- Output capture: pre-spawn ---------------------------------------
    const substepId = isSubstep ? itemToRender.id : undefined;
    const unitOutputs = extractUnitOutputs(currentStep, isSubstep, substepId);
    const { naked: nakedOutputs } = partitionOutputDeclarations(unitOutputs);
    let channels: { env: Record<string, string>; prepared: readonly PreparedChannel[] };
    if (nakedOutputs.length > 0) {
      const outputScope = deriveOutputScope(currentState, isSubstep, substepId);
      channels = await prepareOutputChannels({
        cwd,
        runId: currentState.id,
        scope: outputScope,
        naked: nakedOutputs,
      });
    } else {
      channels = { env: {}, prepared: [] };
    }
    // --------------------------------------------------------------------

    // Build rundown-injected environment variables (RD_WORK_PATH, RD_RUN_ID, etc.)
    // Keys come from BUILTIN_VARIABLES so a rename in variable-discovery.ts
    // surfaces here as a typecheck error instead of silently breaking injection.
    const rdInjected: Record<string, string> = { ...channels.env };
    const workPath = stepVars[BUILTIN_VARIABLES.WorkPath];
    const contextId = stepVars[BUILTIN_VARIABLES.ContextId];
    if (typeof workPath === 'string') rdInjected.RD_WORK_PATH = workPath;
    if (typeof contextId === 'string') rdInjected.RD_CONTEXT_ID = contextId;
    rdInjected.RD_RUN_ID = currentState.id;
    rdInjected.RD_RUNBOOK_REF = currentState.runbook.path;
    rdInjected.RD_RUNBOOK_SOURCE = currentState.runbook.source;

    // Execute command (unchanged — still routed via internal vs spawn)
    const extracted = extractDisplayCommand(expandedCommandCode);
    const displayCommand = extracted || expandedCommandCode;
    emitter.emit('COMMAND_STARTED', {
      command: expandedCommandCode,
      displayCommand,
      position: stepPosition,
    });
    let execResult: ExecutionResult;

    if (isInternalRdCommand(expandedCommandCode)) {
      const internalResult = await executeRdCommandInternal(expandedCommandCode, cwd, rdInjected);
      if (internalResult !== null) {
        execResult = internalResult;
      } else {
        execResult = await executeCommandWithPolicyCheck(
          expandedCommandCode,
          cwd,
          currentState.runbookPath,
          rdInjected,
        );
      }
    } else {
      execResult = await executeCommandWithPolicyCheck(
        expandedCommandCode,
        cwd,
        currentState.runbookPath,
        rdInjected,
      );
    }

    // Emit COMMAND_COMPLETED event (unchanged)
    emitter.emit('COMMAND_COMPLETED', {
      command: expandedCommandCode,
      success: execResult.success,
      exitCode: execResult.exitCode,
      position: stepPosition,
      policyDenied: execResult.policyDenied,
      denialReason: execResult.denialReason,
      sandboxed: execResult.sandboxed,
    });

    const lastResult = execResult.success ? 'pass' : 'fail';
    // OUTPUTS capture is now machine-invoked via COMMAND_RESULT below.
    // See packages/core/src/runbook/actors/output-capture-actor.ts.

    // Handle policy denial
    if (execResult.policyDenied) {
      const policyPosition = stepPosition;
      emitter.emit('POLICY_DENIED', {
        command: expandedCommandCode,
        reason: execResult.denialReason ?? 'Permission denied',
        position: policyPosition,
      });
      await manager.update(runbookId, {
        lifecycle: 'stopped',
      });
      // Emit RUNBOOK_STOPPED so JSON output shows correct terminal state
      emitter.emit('RUNBOOK_STOPPED', {
        position: policyPosition,
        reason: 'policy_denied',
        message: `Command blocked by policy: ${execResult.denialReason ?? 'Permission denied'}`,
      });
      await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      return 'stopped';
    }

    // Store result
    await lifecycleService.setLastResult(runbookId, lastResult);
    const previousState = currentState;
    const cmdSync = await actorService.sendAndSync(runbookId, steps, {
      type: 'COMMAND_RESULT',
      result: lastResult,
      channels: channels.prepared,
    });
    if (!cmdSync) return 'stopped';
    const transitionResult = await observeCommandTransition({
      manager,
      actorService,
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState: previousState,
      postState: cmdSync.state,
      syncSnapshot: cmdSync.snapshot,
      currentStep,
      result: lastResult,
      transitionPolicy: terminalPolicy,
      command: displayCommand,
    });
    if (transitionResult.status === 'done') {
      if (terminalReleaseMode === 'release-runbook') {
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      }
      return 'done';
    }
    if (transitionResult.status === 'stopped') {
      if (terminalReleaseMode === 'release-runbook') {
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      }
      return 'stopped';
    }
    currentState = transitionResult.state;
  }
}

export {
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
};

/**
 * Check if value is a valid result ('pass' | 'fail').
 *
 * When no explicit result sequence is provided to test commands,
 * the default sequence ['pass'] is used. This means steps pass on the first attempt.
 * Users can override this with --result flags to customize the sequence.
 * @param r - String value to check
 * @returns True if the value is 'pass' or 'fail'
 */
export function isValidResult(r: string): r is 'pass' | 'fail' {
  return r === 'pass' || r === 'fail';
}

/**
 * Get retry max for a step or substep.
 * @param item - Runbook step or substep to get retry max from
 * @returns Maximum number of retries, or 0 if no retry configured
 */
export function getStepRetryMax(item: Step | ResolvedStep | Substep): number {
  // Check FAIL transition first (more common to have retry on FAIL)
  if (item.transitions.fail.retry > 0) {
    return item.transitions.fail.retry;
  }
  // Also check PASS transition
  if (item.transitions.pass.retry > 0) {
    return item.transitions.pass.retry;
  }
  return 0; // No retry configured
}

/**
 * Build metadata object for output.
 * @param state - Current runbook state
 * @returns Metadata object for CLI output
 */
export function buildMetadata(state: RunbookState): RunbookMetadata {
  return {
    file: state.runbook.path,
    state: `${RUNS_DIR}/${state.id}.json`,
    prompted: state.prompted ?? undefined,
  };
}

/**
 * Execute a command with policy enforcement.
 *
 * Uses the global policy context to check permissions before execution.
 * If policy is enforced and the command requires permission, prompts the user.
 * Sets the runbook path on the evaluator to enable runbook-specific overrides.
 * When sandboxing is enabled, enforces file access policies at the OS level.
 *
 * @param command - The shell command to execute
 * @param cwd - Working directory for execution
 * @param runbookPath - Optional runbook file path for override matching
 * @param rdInjected - Optional rundown-injected env vars (`RD_OUTPUTS_*`, `RD_WORK_PATH`, etc.) merged into the child process environment
 * @returns Execution result
 */
export async function executeCommandWithPolicyCheck(
  command: string,
  cwd: string,
  runbookPath?: string,
  rdInjected?: Record<string, string>,
): Promise<ExecutionResult> {
  // Check if policy enforcement is active
  if (!isPolicyEnforced()) {
    // When policy is bypassed (--allow-all / trust mode), still inject
    // rundown-specific env vars (RD_OUTPUTS_*, RD_WORK_PATH, etc.) so
    // file-backed OUTPUTS channels are visible to the subprocess.
    if (rdInjected && Object.keys(rdInjected).length > 0) {
      const env = { ...process.env, ...rdInjected } as Record<string, string>;
      return executeCommandWithEnv(command, cwd, env);
    }
    return executeCommand(command, cwd);
  }

  // Get evaluator and set runbook path for override matching
  const evaluator = getPolicyEvaluator();
  if (runbookPath) {
    evaluator.setRunbookPath(runbookPath);
  }

  // Get sandbox options
  const sandboxOpts = getSandboxOptions();

  // Use policy-aware execution with sandbox
  return executeCommandWithPolicy(command, cwd, {
    evaluator,
    prompter: getPolicyPrompter(),
    rdInjected,
    sandbox: sandboxOpts.sandbox,
    sandboxStrict: sandboxOpts.sandboxStrict,
  });
}
