// packages/cli/src/helpers/force-terminal-workflow.ts

import {
  type RunbookActorService,
  type RunbookState,
  type SessionService,
  type RunId,
  type RunbookEventInput,
  type RunbookEventV1,
  deriveTransitionObservation,
} from '@rundown-org/core';
import { getRunbookFromState } from './runbook-loader.js';
import type { OutputEmitter } from '../services/output-emitter.js';

/** Force-terminal command kind handled by {@link forceTerminalWorkflow}. */
export type ForceTerminalWorkflowKind = 'complete' | 'stop';

/** Successful force-terminal cascade across the active inline composition chain. */
export interface ForceTerminalWorkflowResult {
  readonly status: 'completed' | 'stopped';
  /** Pre-force resolved root (outermost contiguous-inline ancestor). */
  readonly targetState: RunbookState;
  /** Post-force resolved root, used by callers for parent propagation. */
  readonly finalTargetState: RunbookState;
  /** Run ids actually forced terminal during the cascade. */
  readonly forcedRunIds: readonly RunId[];
}

/** No-op outcome: the resolved root was already terminal; the chain was released. */
export interface ForceTerminalWorkflowAlreadyTerminal {
  readonly status: 'already-terminal';
  readonly targetState: RunbookState;
  readonly releaseRunIds: readonly RunId[];
}

/** Resolution could not produce a force-terminal plan. */
export interface ForceTerminalWorkflowUnavailable {
  readonly status: 'none' | 'missing-inline-parent' | 'inline-cycle';
  readonly message: string;
  readonly code: string;
}

/** Discriminated outcome of {@link forceTerminalWorkflow}. */
export type ForceTerminalWorkflowOutcome =
  | ForceTerminalWorkflowResult
  | ForceTerminalWorkflowAlreadyTerminal
  | ForceTerminalWorkflowUnavailable;

/**
 * Command-local bridge that streams force-terminal observation events.
 *
 * Preserves one monotonic `seq` across the whole forced chain while stamping
 * each event with the runbook id and runbook ref of the state that produced it.
 * Exactly one bridge must be created per force-terminal command — creating one
 * per state would restart `seq` or misattribute descendant events.
 */
class ForceTerminalEventBridge {
  private seq = 0;

  constructor(private readonly output: OutputEmitter) {}

  /**
   * Stamp and stream a single observation event.
   *
   * @param state - The runbook state that produced the event (for attribution).
   * @param event - Pre-correlated `{ type, payload }` observation event.
   */
  emit(state: RunbookState, event: RunbookEventInput): void {
    this.seq += 1;
    const envelope: RunbookEventV1 = {
      v: '1',
      ts: new Date().toISOString(),
      seq: this.seq,
      runbookId: state.id,
      runbook: state.runbook,
      ...event,
    };
    this.output.executionEvent(envelope);
  }
}

/**
 * Derive and stream core-projected terminal observations for one forced state.
 *
 * @param args - Bridge, cwd, the pre/post force state, snapshot, and command kind.
 * @param args.eventBridge - Shared bridge that stamps and streams each event.
 * @param args.cwd - Working directory used to resolve the runbook steps.
 * @param args.previousState - Persisted state before the force transition.
 * @param args.updatedState - Persisted state after the force transition.
 * @param args.snapshot - Raw snapshot returned by `sendAndSync`.
 * @param args.kind - Force-terminal command kind driving the observation result.
 */
function emitForceObservation(args: {
  readonly eventBridge: ForceTerminalEventBridge;
  readonly cwd: string;
  readonly previousState: RunbookState;
  readonly updatedState: RunbookState;
  readonly snapshot: unknown;
  readonly kind: ForceTerminalWorkflowKind;
}): void {
  const steps = getRunbookFromState(args.previousState, args.cwd);
  const currentStep = steps.find((step) => step.name === args.previousState.step);
  if (!currentStep) return;

  const observation = deriveTransitionObservation({
    steps,
    currentStep,
    previousState: args.previousState,
    updatedState: args.updatedState,
    snapshot: args.snapshot,
    result: args.kind === 'complete' ? 'pass' : 'fail',
    command: args.kind,
  });

  for (const event of observation.events) {
    args.eventBridge.emit(args.updatedState, event);
  }
}

/**
 * Force the active inline composition chain terminal.
 *
 * Asks core for the force-terminal plan (the outermost contiguous-inline
 * ancestor and its inline descendants), dispatches `FORCE_COMPLETE` /
 * `FORCE_STOP` to each running member descendant-to-root, streams core-derived
 * terminal observations in that order, releases the whole chain from the
 * session, and returns the root sync result for existing propagation/recovery
 * code in the command layer.
 *
 * Side-effect-only release happens after the cascade; the command layer owns
 * parent propagation for the resolved root only (never for descendants).
 *
 * @param args - Command kind, optional message, cwd, and injected services.
 * @param args.kind - Force-terminal command kind (`complete` or `stop`).
 * @param args.message - Optional terminal message forwarded to the machine.
 * @param args.cwd - Working directory used to resolve runbook steps.
 * @param args.sessionService - Session service for plan resolution and release.
 * @param args.actorService - Actor service used to dispatch force events.
 * @param args.output - Output emitter for streamed terminal observations.
 * @returns A discriminated outcome describing the cascade or why it could not run.
 * @throws {InvalidRunbookStateError} When a chain member's persisted snapshot is
 *   invalid; the command layer maps this to its recovery path.
 */
export async function forceTerminalWorkflow(args: {
  readonly kind: ForceTerminalWorkflowKind;
  readonly message: string | undefined;
  readonly cwd: string;
  readonly sessionService: SessionService;
  readonly actorService: RunbookActorService;
  readonly output: OutputEmitter;
}): Promise<ForceTerminalWorkflowOutcome> {
  const plan = await args.sessionService.resolveActiveInlineForceTerminalPlan(args.kind);

  if (plan.status === 'none') {
    return {
      status: 'none',
      message: `No active runbook to ${args.kind}`,
      code: 'NO_ACTIVE_RUNBOOK',
    };
  }
  if (plan.status === 'missing-inline-parent') {
    return {
      status: 'missing-inline-parent',
      message: `Inline parent ${plan.missingParentRunId} is unavailable`,
      code: 'INLINE_PARENT_UNAVAILABLE',
    };
  }
  if (plan.status === 'inline-cycle') {
    return {
      status: 'inline-cycle',
      message: `Inline parent cycle detected at ${plan.repeatedRunId}`,
      code: 'INLINE_PARENT_CYCLE',
    };
  }

  if (plan.targetState.lifecycle !== 'running') {
    await args.sessionService.releaseRunbooks(plan.releaseRunIds);
    return {
      status: 'already-terminal',
      targetState: plan.targetState,
      releaseRunIds: plan.releaseRunIds,
    };
  }

  const eventBridge = new ForceTerminalEventBridge(args.output);
  let finalTargetState = plan.targetState;
  const forcedRunIds: RunId[] = [];
  for (const state of plan.forceOrder) {
    if (state.lifecycle !== 'running') continue;
    const steps = getRunbookFromState(state, args.cwd);
    const result = await args.actorService.sendAndSync(state.id, steps, {
      type: args.kind === 'complete' ? 'FORCE_COMPLETE' : 'FORCE_STOP',
      message: args.message,
    });
    // `sendAndSync` returns null when the persisted snapshot vanished between
    // resolution and dispatch (a race). Tolerate it: skip this member's
    // observation and keep the pre-force state, matching the prior single-target
    // behavior, then continue releasing the chain.
    if (!result) continue;
    forcedRunIds.push(state.id);
    emitForceObservation({
      eventBridge,
      cwd: args.cwd,
      previousState: state,
      updatedState: result.state,
      snapshot: result.snapshot,
      kind: args.kind,
    });
    if (state.id === plan.targetState.id) {
      finalTargetState = result.state;
    }
  }

  await args.sessionService.releaseRunbooks(plan.releaseRunIds);

  return {
    status: args.kind === 'complete' ? 'completed' : 'stopped',
    targetState: plan.targetState,
    finalTargetState,
    forcedRunIds,
  };
}
