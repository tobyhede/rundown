import {
  asTerminalSnapshotOrDefault,
  buildStepPosition,
  countNumberedSteps,
  deriveTransitionMessage,
  extractLastAction,
  extractLastMessage,
  extractRetryDisplayCount,
  extractRetryMax,
  formatActionForDisplay,
  isRunbookComplete,
  isRunbookStopped,
  type ExecutionEventEmitter,
  type RunbookCompletedPayload,
  type RunbookState,
  type RunbookStateManager,
  type RunbookStoppedPayload,
  type SessionService,
  type Step,
  type StepPosition,
  type StepTransitionedPayload,
} from '@rundown-org/core';

export interface TerminalSideEffectsPolicy {
  popRunbook: boolean;
  updateParentBinding: boolean;
  parentResult: 'pass' | 'fail';
}

export interface TransitionOrchestrationPolicy {
  onComplete: TerminalSideEffectsPolicy;
  onStopped: TerminalSideEffectsPolicy;
}

export interface TransitionEventSink {
  onStepTransitioned(payload: StepTransitionedPayload): void;
  onRunbookCompleted(payload: RunbookCompletedPayload): void;
  onRunbookStopped(payload: RunbookStoppedPayload): void;
}

export function transitionSinkFromEmitter(
  emitter: Pick<ExecutionEventEmitter, 'emit'>,
): TransitionEventSink {
  return {
    onStepTransitioned: (payload) => emitter.emit('STEP_TRANSITIONED', payload),
    onRunbookCompleted: (payload) => emitter.emit('RUNBOOK_COMPLETED', payload),
    onRunbookStopped: (payload) => emitter.emit('RUNBOOK_STOPPED', payload),
  };
}

interface OrchestrateTransitionArgs {
  manager: RunbookStateManager;
  sessionService: SessionService;
  sink: TransitionEventSink;
  runbookId: string;
  steps: Step[];
  currentStep: Step;
  previousState: RunbookState;
  updatedState: RunbookState;
  snapshot: unknown;
  result: 'pass' | 'fail';
  actionResult: boolean;
  policy: TransitionOrchestrationPolicy;
  agentId?: string;
  command?: string;
}

export type OrchestrateTransitionResult =
  | {
      status: 'continue';
      state: RunbookState;
      action: string;
      from: StepPosition;
      to: StepPosition;
    }
  | { status: 'done'; action: string; from: StepPosition; to: StepPosition; message?: string }
  | { status: 'stopped'; action: string; from: StepPosition; to: StepPosition; message?: string };

function buildTransitionPositions(
  previousState: RunbookState,
  updatedState: RunbookState,
  steps: Step[],
): { from: StepPosition; to: StepPosition } {
  const totalSteps = countNumberedSteps(steps);
  return {
    from: buildStepPosition(
      previousState.step,
      totalSteps,
      previousState.substep,
      previousState.forStack,
    ),
    to: buildStepPosition(
      updatedState.step,
      totalSteps,
      updatedState.substep,
      updatedState.forStack,
    ),
  };
}

async function applyTerminalSideEffects(
  manager: RunbookStateManager,
  sessionService: SessionService,
  state: RunbookState,
  agentId: string | undefined,
  policy: TerminalSideEffectsPolicy,
): Promise<void> {
  if (policy.updateParentBinding && agentId && state.parentRunbookId) {
    await manager.updateAgentBinding(state.parentRunbookId, agentId, {
      status: 'done',
      result: policy.parentResult,
    });
  }

  if (policy.popRunbook) {
    await sessionService.popRunbook(agentId);
  }
}

/**
 * Persist transition state, emit transition/terminal events, and apply side effects.
 *
 * This is the shared transition application path for command-driven transitions
 * and execution-loop transitions.
 */
export async function orchestrateTransition(
  args: OrchestrateTransitionArgs,
): Promise<OrchestrateTransitionResult> {
  const {
    manager,
    sessionService,
    sink,
    runbookId,
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot,
    result,
    actionResult,
    policy,
    agentId,
    command,
  } = args;

  const retryMax = extractRetryMax(snapshot);
  const lastAction = extractLastAction(snapshot);
  const retryDisplayCount = extractRetryDisplayCount(snapshot, updatedState.retryCount);
  const action = formatActionForDisplay(lastAction, retryDisplayCount, retryMax);
  const positions = buildTransitionPositions(previousState, updatedState, steps);

  await manager.update(runbookId, {
    lastAction,
    lastResult: result,
  });

  sink.onStepTransitioned({
    action,
    from: positions.from,
    to: positions.to,
    result: actionResult,
    command,
  });

  const terminalSnapshot = asTerminalSnapshotOrDefault(snapshot);
  const isComplete = isRunbookComplete(terminalSnapshot);
  const isStopped = isRunbookStopped(terminalSnapshot);

  if (isComplete) {
    const message =
      extractLastMessage(snapshot) ??
      deriveTransitionMessage(result, currentStep, previousState.retryCount);

    await manager.update(runbookId, {
      variables: { ...updatedState.variables, completed: true },
    });
    sink.onRunbookCompleted({
      message,
      finalPosition: positions.to,
    });

    await applyTerminalSideEffects(
      manager,
      sessionService,
      previousState,
      agentId,
      policy.onComplete,
    );
    return { status: 'done', action, from: positions.from, to: positions.to, message };
  }

  if (isStopped) {
    const message =
      extractLastMessage(snapshot) ??
      deriveTransitionMessage(result, currentStep, previousState.retryCount);

    await manager.update(runbookId, {
      variables: { ...updatedState.variables, stopped: true },
    });
    sink.onRunbookStopped({
      message,
      position: positions.from,
      reason: 'fail_transition',
    });

    await applyTerminalSideEffects(
      manager,
      sessionService,
      previousState,
      agentId,
      policy.onStopped,
    );
    return { status: 'stopped', action, from: positions.from, to: positions.to, message };
  }

  const reloaded = await manager.load(runbookId);
  if (!reloaded) {
    return { status: 'stopped', action, from: positions.from, to: positions.to };
  }

  return { status: 'continue', state: reloaded, action, from: positions.from, to: positions.to };
}
