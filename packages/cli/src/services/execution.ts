import {
  type RunId,
  assertRunId,
  buildStepVariables,
  buildStepPosition,
  type ActionType,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  type RunbookStateManager,
  RunbookCompletionService,
  SessionService,
  ExecutionLifecycleService,
  mergeEffectiveVars,
  type Step,
  type ResolvedStep,
  type Substep,
  type RunbookMetadata,
  type RunbookState,
  type RunbookActorService,
  type ActorSyncResult,
  type ExecutionResult,
  type CommandExecutionServices,
  type ExecutionObservationEffect,
  executeCommand,
  executeCommandWithEnv,
  executeCommandWithPolicy,
  countNumberedSteps,
  extractDisplayCommand,
  type ExecutionEventEmitter,
  type InlineLaunchIntent,
  type InlineLinkage,
  type ParentLinkage,
  type Frame,
  type FrameKey,
  RUNS_DIR,
  type DelegateFrontierEntry,
  DelegationLock,
  DelegationLockTimeoutError,
  reconstituteContextVars,
  extractInheritedUserVars,
  ErrorCodes,
  getErrorMessage,
  partitionOutputDeclarations,
  resolveCurrentExecutionUnit,
  type OutputScope,
  deriveTransitionObservation,
  asTerminalSnapshotOrDefault,
  isRunbookStopped,
  isRunbookComplete,
  expandLoopVariables,
  expandLoopVariablesForCommand,
} from '@rundown-org/core';
import { resolvedStepHasSubsteps, type OutputDeclaration } from '@rundown-org/parser';
import { isInternalRdCommand, executeRdCommandInternal } from './internal-commands.js';
import { createCliRunbookActorService } from '../helpers/actor-service-factory.js';
import {
  getPolicyEvaluator,
  getPolicyPrompter,
  isPolicyEnforced,
  getSandboxOptions,
} from './policy-context.js';
import { getHelperRegistry } from './helper-registry.js';
import { BUILTIN_VARIABLES } from './variable-discovery.js';
import {
  orchestrateTransition,
  transitionSinkFromEmitter,
  type TransitionOrchestrationPolicy,
} from '../helpers/transition-orchestrator.js';
import { buildRunnableRenderContext } from '../helpers/render-context.js';
import { createBridgedEmitter } from '../helpers/execution-emitter.js';
import type { OutputEmitter } from './output-emitter.js';
export type { ExecutionVarValue, StepVariables, TemplateVariables } from './execution-vars.js';
export { buildStepVariables };

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

type ObserveCommandTransitionArgs = ObserveAndOrchestrateArgs;

interface RenderTerminalObservationArgs {
  emitter: ExecutionEventEmitter;
  steps: ResolvedStep[];
  currentStep: ResolvedStep;
  previousState: RunbookState;
  updatedState: RunbookState;
  snapshot: unknown;
  position: ReturnType<typeof buildStepPosition>;
}

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
  /** Optional actor service test seam. */
  readonly actorService?: RunbookActorService;
  /** Optional command services test seam. */
  readonly commandServices?: CommandExecutionServices;
  /** Output emitter used when the loop launches an inline child runbook. */
  readonly output?: OutputEmitter;
}

interface InlineLaunchArgs {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  readonly emitter: ExecutionEventEmitter;
  readonly cwd: string;
  readonly steps: readonly ResolvedStep[];
  readonly intent: InlineLaunchIntent;
  readonly prompted: boolean;
  readonly output: OutputEmitter;
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

function createCliCommandServices(): CommandExecutionServices {
  return {
    runInternalCommand: async ({ command, cwd, rdInjected }) => {
      if (!isInternalRdCommand(command)) return null;
      return executeRdCommandInternal(command, cwd, rdInjected);
    },
    runExternalCommand: async ({ command, cwd, runbookPath, rdInjected }) =>
      executeCommandWithPolicyCheck(command, cwd, runbookPath, rdInjected),
  };
}

function parentLinkagesEqual(left: ParentLinkage | undefined, right: InlineLinkage): boolean {
  return (
    left?.kind === 'inline' &&
    left.parentRunId === right.parentRunId &&
    left.parentStepId === right.parentStepId &&
    left.parentStep === right.parentStep &&
    left.parentFrameKey === right.parentFrameKey &&
    left.parentEntry === right.parentEntry
  );
}

function runbookRefsEqual(left: unknown, right: InlineLaunchIntent['childRunbookRef']): boolean {
  if (!left || typeof left !== 'object') return false;
  const candidate = left as Partial<InlineLaunchIntent['childRunbookRef']>;
  return candidate.source === right.source && candidate.path === right.path;
}

function persistedInlineLaunchIntentMatches(
  state: RunbookState,
  observed: InlineLaunchIntent,
): boolean {
  const snapshot = state.snapshot as {
    readonly context?: { readonly inlineLaunchIntent?: unknown };
  };
  const current = snapshot.context?.inlineLaunchIntent;
  if (!current || typeof current !== 'object') return false;
  const candidate = current as Partial<InlineLaunchIntent>;
  return (
    candidate.parentRunId === observed.parentRunId &&
    candidate.parentStepId === observed.parentStepId &&
    candidate.parentStep === observed.parentStep &&
    candidate.parentFrameKey === observed.parentFrameKey &&
    candidate.childRunId === observed.childRunId &&
    candidate.childRunbookPath === observed.childRunbookPath &&
    runbookRefsEqual(candidate.childRunbookRef, observed.childRunbookRef)
  );
}

async function propagateInlineChildTerminalResult(args: {
  readonly manager: RunbookStateManager;
  readonly childRunId: RunId;
  readonly loopResult: 'done' | 'stopped' | 'waiting';
  readonly cwd: string;
  readonly output: OutputEmitter;
}): Promise<'done' | 'stopped' | 'waiting'> {
  const { manager, childRunId, loopResult, cwd, output } = args;
  if (loopResult !== 'done' && loopResult !== 'stopped') return loopResult;

  const childState = await manager.load(childRunId);
  if (!childState?.parentLinkage) return loopResult;

  const { handleParentCompletion } = await import('../helpers/delegation-completion.js');
  const propagated = await handleParentCompletion(
    childState,
    loopResult === 'done' ? 'pass' : 'fail',
    cwd,
    output,
  );
  return propagated === 'stopped' ? 'stopped' : loopResult;
}

async function consumeInlineLaunchIntent(args: {
  readonly actorService: RunbookActorService;
  readonly parentRunId: RunId;
  readonly steps: readonly ResolvedStep[];
}): Promise<void> {
  const consumed = await args.actorService.sendAndSync(args.parentRunId, args.steps, {
    type: 'INLINE_LAUNCH_CONSUMED',
  });
  assertActorSyncSucceeded(consumed, 'Failed to consume inline launch after child start');
}

function assertActorSyncSucceeded(
  sync: ActorSyncResult | null,
  nullMessage: string,
): asserts sync is ActorSyncResult {
  if (!sync) {
    throw new Error(nullMessage);
  }
  const snapshot = sync.snapshot as { status?: unknown; error?: unknown };
  if (snapshot.status === 'error') {
    throw new Error(getErrorMessage(snapshot.error));
  }
}

async function launchInlineChildFromIntent({
  manager,
  actorService,
  sessionService,
  emitter,
  cwd,
  steps,
  intent,
  prompted,
  output,
}: InlineLaunchArgs): Promise<'done' | 'stopped' | 'waiting'> {
  const parentLinkage: InlineLinkage = {
    kind: 'inline',
    parentRunId: assertRunId(intent.parentRunId),
    parentStepId: intent.parentStepId,
    parentStep: intent.parentStep,
    parentFrameKey: intent.parentFrameKey as FrameKey,
    parentEntry: intent.parentEntry,
  };
  const childRunId = assertRunId(intent.childRunId);
  const lock = new DelegationLock(cwd);
  let lockHeld = false;
  const releaseLock = async (): Promise<void> => {
    if (!lockHeld) return;
    lockHeld = false;
    await lock.release(parentLinkage.parentRunId);
  };

  try {
    await lock.acquire(parentLinkage.parentRunId);
    lockHeld = true;
  } catch (err) {
    if (err instanceof DelegationLockTimeoutError) {
      emitter.emit('ERROR_OCCURRED', {
        message: `Could not acquire delegation lock for inline parent ${parentLinkage.parentRunId}`,
        code: ErrorCodes.DELEGATION_LOCK_TIMEOUT.code,
      });
      return 'stopped';
    }
    throw err;
  }

  try {
    const parent = await manager.load(parentLinkage.parentRunId);
    if (!parent || parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
      emitter.emit('ERROR_OCCURRED', {
        message: `Inline parent run ${parentLinkage.parentRunId} is not active`,
        code: ErrorCodes.LAUNCH_FAILED.code,
      });
      return 'stopped';
    }
    if (!persistedInlineLaunchIntentMatches(parent, intent)) {
      return 'waiting';
    }

    const existingChild = await manager.load(childRunId);
    if (existingChild) {
      if (!parentLinkagesEqual(existingChild.parentLinkage, parentLinkage)) {
        emitter.emit('ERROR_OCCURRED', {
          message: `Inline child ${childRunId} has conflicting parent linkage`,
          code: 'INLINE_CHILD_LINKAGE_MISMATCH',
        });
        return 'stopped';
      }
      const { getRunbookFromState } = await import('../helpers/runbook-loader.js');
      await consumeInlineLaunchIntent({
        actorService,
        parentRunId: parentLinkage.parentRunId,
        steps,
      });
      const active = await sessionService.getActive();
      if (active?.id !== childRunId) {
        await sessionService.pushRunbook(childRunId);
      }
      await releaseLock();
      const loopResult = await runExecutionLoop(
        manager,
        childRunId,
        [...getRunbookFromState(existingChild, cwd)],
        cwd,
        !!existingChild.prompted,
        createBridgedEmitter(existingChild, output),
        { output },
      );
      return propagateInlineChildTerminalResult({
        manager,
        childRunId,
        loopResult,
        cwd,
        output,
      });
    }

    const { resolveRunbookRef } = await import('../helpers/resolve-runbook.js');
    const childResolution = await resolveRunbookRef(cwd, intent.childRunbookRef);
    if (!childResolution.ok) {
      const message =
        childResolution.reason === 'plugin-context-missing'
          ? `Plugin runbook context is unavailable for ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}. Set CLAUDE_PLUGIN_ROOT or install the Rundown Claude Code plugin alongside the CLI.`
          : `Runbook not found: ${intent.childRunbookRef.source}:${intent.childRunbookRef.path}`;
      emitter.emit('ERROR_OCCURRED', {
        message,
        code:
          childResolution.reason === 'plugin-context-missing'
            ? 'RUNBOOK_REF_RESOLUTION_ERROR'
            : 'RUNBOOK_NOT_FOUND',
      });
      return 'stopped';
    }

    const inheritedContextVars = reconstituteContextVars(intent.contextSnapshot);
    const inheritedUserVars = extractInheritedUserVars(intent.contextSnapshot);
    const { prepareResolvedRunnableRunbook, startRunbook } = await import(
      '../helpers/runbook-pipeline.js'
    );
    const prepared = await prepareResolvedRunnableRunbook(
      {
        resolved: childResolution.resolved,
        runbookRef: intent.childRunbookRef,
        displayName: intent.childRunbookPath,
      },
      {},
      cwd,
      {
        runId: childRunId,
        inheritedContextVars,
        inheritedUserVars,
      },
    );
    if (!prepared.ok) {
      emitter.emit('ERROR_OCCURRED', {
        message: prepared.error,
        code: prepared.code,
      });
      return 'stopped';
    }

    if (prepared.warnings?.length) {
      for (const msg of prepared.warnings) {
        output.warning(msg);
      }
    }
    for (const name of prepared.unresolved) {
      output.warning(`Undefined variable "{{${name}}}" preserved as literal text`);
    }

    const launchResult = await startRunbook(
      {
        output,
        manager,
        actorService,
        sessionService,
        lifecycleService: new ExecutionLifecycleService(manager),
        cwd,
      },
      prepared.prepared,
      {
        file: intent.childRunbookPath,
        prompted,
        parentLinkage,
        afterStarted: async () => {
          const started = await actorService.sendAndSync(parentLinkage.parentRunId, steps, {
            type: 'INLINE_CHILD_STARTED',
            parentStepId: parentLinkage.parentStepId,
            parentFrameKey: parentLinkage.parentFrameKey,
            childRunId,
            startedAt: new Date().toISOString(),
          });
          assertActorSyncSucceeded(started, 'Failed to mark inline child as started');
          await consumeInlineLaunchIntent({
            actorService,
            parentRunId: parentLinkage.parentRunId,
            steps,
          });
          await releaseLock();
        },
      },
    );

    if (!launchResult.ok) {
      emitter.emit('ERROR_OCCURRED', {
        message: launchResult.error,
        code: launchResult.code,
      });
      return 'stopped';
    }

    if (launchResult.loopResult === 'done' || launchResult.loopResult === 'stopped') {
      await releaseLock();
      return propagateInlineChildTerminalResult({
        manager,
        childRunId,
        loopResult: launchResult.loopResult,
        cwd,
        output,
      });
    }

    return launchResult.loopResult;
  } finally {
    await releaseLock();
  }
}

async function observeAndOrchestrate({
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
  const ensured = await lifecycleService.ensureActiveEntry(runbookId, currentState, postState);

  const orchestration = await orchestrateTransition({
    sessionService,
    sink: transitionSinkFromEmitter(emitter),
    runbookId,
    steps,
    currentStep,
    previousState: currentState,
    updatedState: ensured.state,
    snapshot: syncSnapshot,
    result,
    computeActionResult,
    policy: transitionPolicy,
    command,
  });

  if (orchestration.status === 'continue') {
    return { status: 'continue', state: orchestration.state };
  }
  return { status: orchestration.status };
}

function renderTerminalObservationFromCoreState({
  emitter,
  steps,
  currentStep,
  previousState,
  updatedState,
  snapshot,
}: RenderTerminalObservationArgs): void {
  const observation = deriveTransitionObservation({
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot,
    result: 'fail',
  });

  for (const event of observation.events) {
    switch (event.type) {
      case 'ERROR_OCCURRED':
        emitter.emit('ERROR_OCCURRED', event.payload);
        break;
      case 'RUNBOOK_STOPPED':
        emitter.emit('RUNBOOK_STOPPED', event.payload);
        break;
      case 'RUNBOOK_COMPLETED':
        emitter.emit('RUNBOOK_COMPLETED', event.payload);
        break;
      case 'STEP_TRANSITIONED':
        break;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }
}

/**
 * Command path: after COMMAND_RESULT the leaf enters __capture, the actor
 * resolves, onDone raises PASS or FAIL internally to the leaf's handlers,
 * and the leaf transitions to its resolved target. CLI role: observe.
 * @param args - Command transition arguments including sync snapshot and post-state
 * @returns Transition application result after observing the resolved transition
 */
async function observeCommandTransition(
  args: ObserveCommandTransitionArgs,
): Promise<TransitionApplicationResult> {
  return observeAndOrchestrate(args);
}

/** Arguments for draining resolved substep completions. */
export interface DrainResolvedCompletionsArgs {
  /** Actor service for sending events to the runbook machine. */
  actorService: RunbookActorService;
  /** State manager used by the core completion service. */
  manager: RunbookStateManager;
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
  /** Override frame for frame-scoped lookups (e.g., prompted-for with explicit --index). */
  frameOverride?: Frame;
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
    }
  | {
      /** Core rejected a persisted completion that did not match the active cursor. */
      status: 'failed';
      reason: 'target_mismatch';
      message: string;
      unresolved: number;
      applied: 0;
    }
  | {
      /** Requested frame is not currently active, so drain is observation-only. */
      status: 'not_active';
      unresolved: number;
      applied: 0;
    };

/**
 * Deterministically drain resolved substep completions for the active frame+entry.
 *
 * Applies completions in substep order and stops at the first unresolved substep.
 *
 * @param args - Drain arguments including services and current state
 * @param args.actorService - Actor service for sending events to the runbook machine
 * @param args.manager - Runbook state manager used to construct the core completion service
 * @param args.sessionService - Session service for active runbook tracking
 * @param args.lifecycleService - Lifecycle service for completion read/write operations
 * @param args.emitter - Event emitter for execution progress notifications
 * @param args.runbookId - ID of the runbook being drained
 * @param args.steps - Parsed step definitions for the runbook
 * @param args.currentState - Current persisted runbook state
 * @param args.transitionPolicy - Policy governing transition orchestration
 * @param args.computeActionResult - Optional function to compute action result for transitions
 * @param args.command - Optional command string for event context
 * @param args.frameOverride - Optional frame override for frame-scoped lookups (e.g., prompted-for with explicit --index)
 * @returns Drain result indicating continue/done/stopped with counts of applied and unresolved completions
 * @throws {Error} If the core completion service, session update, or transition event handling fails
 */
export async function drainResolvedCompletions({
  actorService,
  manager,
  sessionService,
  lifecycleService,
  emitter,
  runbookId,
  steps,
  currentState,
  transitionPolicy,
  computeActionResult,
  command,
  frameOverride,
}: DrainResolvedCompletionsArgs): Promise<DrainResolvedCompletionsResult> {
  const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
  let drainState = currentState;
  let observedState = currentState;
  let appliedCount = 0;

  for (;;) {
    const drained = await completionService.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: drainState,
      maxApplied: 1,
      ...(frameOverride ? { frameOverride } : {}),
    });

    if (drained.status === 'failed') {
      return {
        status: 'failed',
        reason: drained.reason,
        message: drained.message,
        unresolved: drained.unresolved,
        applied: 0,
      };
    }
    if (drained.status === 'not_active') {
      if (appliedCount > 0) {
        return {
          status: 'continue',
          state: observedState,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      }
      return { status: 'not_active', unresolved: drained.unresolved, applied: 0 };
    }

    for (const applied of drained.applied) {
      const currentStep = findStepOrThrow(steps, applied.stateBefore.step);
      const observed = await observeAndOrchestrate({
        sessionService,
        lifecycleService,
        emitter,
        runbookId,
        steps,
        currentState: applied.stateBefore,
        currentStep,
        result: applied.completion.result,
        transitionPolicy,
        computeActionResult,
        command,
        syncSnapshot: applied.snapshot,
        postState: applied.stateAfter,
      });
      appliedCount += 1;
      if (observed.status === 'done' || observed.status === 'stopped') {
        return {
          status: observed.status,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      }
      observedState = observed.state;
      drainState = observed.state;
    }

    switch (drained.status) {
      case 'done':
      case 'stopped':
        return {
          status: drained.status,
          unresolved: drained.unresolved,
          applied: appliedCount,
        };
      case 'continue':
        if (drained.applied.length === 0) {
          return {
            status: 'continue',
            state: appliedCount > 0 ? observedState : drained.state,
            unresolved: drained.unresolved,
            applied: appliedCount,
          };
        }
        break;
      default: {
        const _exhaustive: never = drained;
        return _exhaustive;
      }
    }
  }
}

/**
 * Execute command steps in a loop until:
 * - Runbook completes or stops
 * - A prompt-only step is reached (no command)
 * - In prompted mode (no auto-execution)
 *
 * @param manager - Runbook state manager instance
 * @param runbookId - Branded run id
 * @param steps - Array of runbook steps
 * @param cwd - Current working directory for command execution
 * @param prompted - Whether to run in prompted mode (no auto-execution)
 * @param emitter - Event emitter for execution events
 * @param options - Optional execution loop behavior overrides
 * @returns 'done' if completed, 'stopped' if stopped, 'waiting' if prompt-only step reached
 * @throws {Error} If state lookup via {@link findStepOrThrow} fails, the core
 *   actor/lifecycle/session services throw while advancing transitions,
 *   command execution rejects, or the emitter raises during event dispatch.
 */
export async function runExecutionLoop(
  manager: RunbookStateManager,
  runbookId: RunId,
  steps: ResolvedStep[],
  cwd: string,
  prompted: boolean,
  emitter: ExecutionEventEmitter,
  options: ExecutionLoopOptions = {},
): Promise<'done' | 'stopped' | 'waiting'> {
  const state = await manager.load(runbookId);
  if (!state) return 'stopped';

  const terminalReleaseMode = options.terminalReleaseMode ?? 'stack-pop';
  const terminalPolicy =
    terminalReleaseMode === 'release-runbook'
      ? EXECUTION_TERMINAL_NO_STACK_POLICY
      : EXECUTION_TERMINAL_POLICY;

  const actorService =
    options.actorService ??
    createCliRunbookActorService(manager, options.commandServices ?? createCliCommandServices());
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);
  const ensuredInitial = await lifecycleService.ensureActiveEntry(runbookId, undefined, state);
  let currentState: RunbookState = ensuredInitial.state;

  if (currentState.lifecycle === 'stopped') {
    const terminalSnap = asTerminalSnapshotOrDefault(currentState.snapshot);
    const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);

    if (snapIsTerminal) {
      // Machine-driven stop: delegate to core projection
      const currentStepForProjection = findStepOrThrow(steps, currentState.step);
      const observation = deriveTransitionObservation({
        steps,
        currentStep: currentStepForProjection,
        previousState: currentState,
        updatedState: currentState,
        snapshot: currentState.snapshot,
        result: 'fail',
      });

      for (const event of observation.events) {
        switch (event.type) {
          case 'ERROR_OCCURRED':
            emitter.emit('ERROR_OCCURRED', event.payload);
            break;
          case 'RUNBOOK_STOPPED':
            emitter.emit('RUNBOOK_STOPPED', event.payload);
            break;
          case 'STEP_TRANSITIONED':
          case 'RUNBOOK_COMPLETED':
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`unreachable transition observation event: ${String(_exhaustive)}`);
          }
        }
      }
    } else {
      // CLI-owned stop: XState machine was never transitioned to STOPPED.
      // The persisted snapshot is non-terminal (e.g. policy denial or
      // delegation-resolution failure wrote lifecycle:'stopped' without
      // driving the machine to its STOPPED state). Emit RUNBOOK_STOPPED
      // directly from the persisted step position.
      const position = buildStepPosition(
        currentState.step,
        countNumberedSteps(steps),
        currentState.substep,
        currentState.forStack,
      );
      const message = extractLastMessage(currentState.snapshot);
      emitter.emit('RUNBOOK_STOPPED', {
        position,
        reason: 'fail_transition',
        message,
      });
    }

    await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
    return 'stopped';
  }

  if (currentState.lifecycle === 'completed') {
    const terminalSnap = asTerminalSnapshotOrDefault(currentState.snapshot);
    const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);

    if (snapIsTerminal) {
      const currentStepForProjection = findStepOrThrow(steps, currentState.step);
      const observation = deriveTransitionObservation({
        steps,
        currentStep: currentStepForProjection,
        previousState: currentState,
        updatedState: currentState,
        snapshot: currentState.snapshot,
        result: 'pass',
      });

      for (const event of observation.events) {
        switch (event.type) {
          case 'RUNBOOK_COMPLETED':
            emitter.emit('RUNBOOK_COMPLETED', event.payload);
            break;
          case 'STEP_TRANSITIONED':
          case 'ERROR_OCCURRED':
          case 'RUNBOOK_STOPPED':
            break;
          default: {
            const _exhaustive: never = event;
            throw new Error(`unreachable transition observation event: ${String(_exhaustive)}`);
          }
        }
      }
    } else {
      emitter.emit('RUNBOOK_COMPLETED', {
        message: extractLastMessage(currentState.snapshot),
        finalPosition: buildStepPosition(
          currentState.step,
          countNumberedSteps(steps),
          currentState.substep,
          currentState.forStack,
        ),
      });
    }
    await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
    return 'done';
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const currentStep = findStepOrThrow(steps, currentState.step);

    const totalSteps = countNumberedSteps(steps);

    // Determine the active execution unit: substep if we're at one, otherwise the step.
    const itemToRender = resolveCurrentExecutionUnit(currentStep, currentState.substep);

    const drainResult = await drainResolvedCompletions({
      actorService,
      manager,
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
    if (drainResult.status === 'failed') {
      throw new Error(drainResult.message);
    }
    if (drainResult.status === 'not_active') {
      return 'waiting';
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
    const stepVars = buildStepVariables({
      stepId: currentState.step,
      substepId: currentState.substep,
      forStack: currentState.forStack,
      forClause: currentStep.kind === 'for' ? currentStep.forClause : undefined,
      templateVars: mergedTemplateVars,
    });
    const helperOptions = {
      helpers: getHelperRegistry(),
      context: buildRunnableRenderContext({
        runId: runbookId,
        cwd,
        vars: mergedTemplateVars,
      }),
    };
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
    const contextSnapshot = await actorService.getContextSnapshot(runbookId, steps);

    const delegateFrontier: Array<DelegateFrontierEntry> | undefined =
      isSubstep && contextSnapshot?.delegateFrontier && contextSnapshot.delegateFrontier.length > 0
        ? [...contextSnapshot.delegateFrontier]
        : undefined;

    // Expand once: artifact-producing helpers in command code append a manifest
    // row per call, so a second expansion would duplicate the entries.
    const expandedCommandCode = command
      ? expandLoopVariablesForCommand(command.code, stepVars, helperOptions)
      : undefined;

    const entryEffects = await actorService.observeExecutionUnitEntry(runbookId, steps, {
      stepId: currentState.step,
      substepId: currentState.substep,
      position: stepPosition,
      stepName: isSubstep ? itemToRender.id : itemToRender.name,
      description: expandedDescription,
      prompt: expandedPrompt,
      commandCode: expandedCommandCode,
      commandLang: command?.lang,
      isSubstep,
      prompted: prompted || stepIsPrompted,
      delegateFrontier,
    });
    for (const effect of entryEffects) {
      emitter.emit(effect.event.type, effect.event.payload);
    }

    const inlineLaunch = entryEffects
      .map((effect) =>
        effect.event.type === 'STEP_ENTERED' ? effect.event.payload.inlineLaunch : undefined,
      )
      .find((intent): intent is InlineLaunchIntent => intent !== undefined);

    if (delegateFrontier) {
      const consumeSync = await actorService.sendAndSync(runbookId, steps, {
        type: 'DELEGATE_FRONTIER_CONSUMED',
      });
      if (!consumeSync) {
        emitter.emit('ERROR_OCCURRED', {
          message: 'Failed to consume delegation frontier after STEP_ENTERED',
        });
        emitter.emit('RUNBOOK_STOPPED', {
          position: stepPosition,
          message: 'Runbook state synchronization failed',
        });
        await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
        return 'stopped';
      }
      currentState = consumeSync.state;
    }

    if (!delegateFrontier && inlineLaunch) {
      if (!options.output) {
        emitter.emit('ERROR_OCCURRED', {
          message: 'Inline launch requires an output emitter',
          code: ErrorCodes.LAUNCH_FAILED.code,
        });
        return 'stopped';
      }
      return launchInlineChildFromIntent({
        manager,
        actorService,
        sessionService,
        emitter,
        cwd,
        steps,
        intent: inlineLaunch,
        prompted,
        output: options.output,
      });
    }

    // If CLI prompted mode, per-step prompted FOR, OR no command
    // Use itemToRender which may be a substep with its own command
    if (prompted || stepIsPrompted || expandedCommandCode === undefined) {
      return 'waiting';
    }

    const substepId = isSubstep ? itemToRender.id : undefined;
    const unitOutputs = extractUnitOutputs(currentStep, isSubstep, substepId);
    const { naked: nakedOutputs } = partitionOutputDeclarations(unitOutputs);
    const outputScope = deriveOutputScope(currentState, isSubstep, substepId);

    // Build rundown-injected environment variables (RD_WORK_PATH, RD_RUN_ID, etc.)
    // Keys come from BUILTIN_VARIABLES so a rename in variable-discovery.ts
    // surfaces here as a typecheck error instead of silently breaking injection.
    const rdInjected: Record<string, string> = {};
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
    const previousState = currentState;
    const cmdSync = await actorService.sendAndSync(runbookId, steps, {
      type: 'EXECUTE_COMMAND',
      command: expandedCommandCode,
      displayCommand,
      runbookPath: currentState.runbookPath,
      outputScope,
      nakedOutputs,
      rdInjected,
    });
    if (!cmdSync) {
      emitter.emit('ERROR_OCCURRED', {
        message: 'Failed to synchronize runbook state after EXECUTE_COMMAND',
      });
      emitter.emit('RUNBOOK_STOPPED', {
        position: stepPosition,
        message: 'Runbook state synchronization failed',
      });
      await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      return 'stopped';
    }
    const syncEffects = cmdSync.effects;
    for (const effect of syncEffects) {
      emitter.emit(effect.event.type, effect.event.payload);
    }

    const commandOutput = syncEffects.find(
      (
        effect,
      ): effect is ExecutionObservationEffect & {
        commandOutput: NonNullable<ExecutionObservationEffect['commandOutput']>;
      } => effect.commandOutput !== undefined,
    )?.commandOutput;

    if (commandOutput?.kind !== 'completed') {
      renderTerminalObservationFromCoreState({
        emitter,
        steps,
        currentStep,
        previousState,
        updatedState: cmdSync.state,
        snapshot: cmdSync.snapshot,
        position: stepPosition,
      });
      await applyExecutionTerminalRelease(sessionService, runbookId, terminalReleaseMode);
      return 'stopped';
    }

    const transitionResult = await observeCommandTransition({
      sessionService,
      lifecycleService,
      emitter,
      runbookId,
      steps,
      currentState: previousState,
      postState: cmdSync.state,
      syncSnapshot: cmdSync.snapshot,
      currentStep,
      result: commandOutput.result,
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

export { extractLastMessage, extractRetryDisplayCount, extractRetryMax, formatActionForDisplay };

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
