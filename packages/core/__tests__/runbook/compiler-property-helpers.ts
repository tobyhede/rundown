/**
 * Shared helpers for compiler property-based tests.
 *
 * Provides:
 * - Step builders: inferSteps, makeAction, makeTransitionObject, makeTransitions
 * - General runner: runMachine — compile, send events, pad to terminal, extract context
 * - Arbitraries: eventArb, simpleActionArb, substepActionArb, eventsArb
 */

import fc from 'fast-check';
import { createActor, type AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type {
  ResolvedStep,
  BaseStep,
  StepWithCommand,
  ResolvedStepWithSubsteps,
  ResolvedStepWithFor,
  Transitions,
  TransitionObject,
  Action,
  LastAction,
} from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Step type inference (pattern from compiler.test.ts)
// ---------------------------------------------------------------------------

/** Input type: Step variants without the `kind` discriminant. */
export type StepInput =
  | Omit<BaseStep, 'kind'>
  | Omit<StepWithCommand, 'kind'>
  | Omit<ResolvedStepWithSubsteps, 'kind'>
  | Omit<ResolvedStepWithFor, 'kind'>;

/** Infer and inject `kind` on each step object so raw literals satisfy the ResolvedStep union. */
export function inferSteps(raw: StepInput[]): ResolvedStep[] {
  return raw.map((s) => {
    const kind =
      'forClause' in s ? 'for' : 'substeps' in s ? 'substeps' : 'command' in s ? 'command' : 'base';
    return { ...s, kind } as ResolvedStep;
  });
}

// ---------------------------------------------------------------------------
// Action / Transition builders (fresh equivalents — not imported from for-loop-test-helpers)
// ---------------------------------------------------------------------------

export function makeAction(type: string): Action {
  switch (type) {
    case 'CONTINUE':
      return { type: 'CONTINUE' };
    case 'DEFER':
      return { type: 'DEFER' };
    case 'NEXT':
      return { type: 'NEXT' };
    case 'BREAK':
      return { type: 'BREAK' };
    case 'STOP':
      return { type: 'STOP' };
    case 'COMPLETE':
      return { type: 'COMPLETE' };
    case 'GOTO':
      return { type: 'GOTO', target: { step: '1' } };
    default:
      return { type: 'CONTINUE' };
  }
}

export function makeTransitionObject(
  kind: 'pass' | 'fail',
  action: string,
  retry = 0,
): TransitionObject {
  return { kind, retry, action: makeAction(action) };
}

export function makeTransitions(
  passAction: string,
  failAction: string,
  failRetry = 0,
): Transitions {
  return {
    pass: makeTransitionObject('pass', passAction),
    fail: makeTransitionObject('fail', failAction, failRetry),
  };
}

/** Default transitions: PASS → CONTINUE, FAIL → STOP */
export const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

/** DEFER transitions: PASS → DEFER, FAIL → DEFER */
export const DEFER_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

// ---------------------------------------------------------------------------
// General runner
// ---------------------------------------------------------------------------

export interface GeneralRunResult {
  terminalState: string;
  lifecycle: string;
  lastAction?: LastAction;
  lastMessage?: string;
  retryCount: number;
  parentRetryCount: number;
  iterationRetryCount: number;
  forStackLength: number;
  deferredResults: readonly ('pass' | 'fail')[];
  substepCompletedCount: number;
  eventsConsumed: number;
  statesVisited: string[];
}

export type MachineEvent =
  | 'PASS'
  | 'FAIL'
  | { readonly type: 'FORCE_STOP'; readonly message?: string }
  | { readonly type: 'FORCE_COMPLETE'; readonly message?: string };

/**
 * Compile steps into an XState machine, send events, pad with PASS to terminal.
 *
 * Returns a snapshot of the terminal context for property assertions.
 */
export function runMachine(
  steps: ResolvedStep[],
  events: MachineEvent[],
  opts?: { maxPad?: number },
): GeneralRunResult {
  const machine = compileRunbookToMachine(steps);
  const actor = createActor(machine as AnyStateMachine);

  const statesVisited: string[] = [];
  let eventsConsumed = 0;

  actor.start();
  statesVisited.push(String(actor.getSnapshot().value));

  // Send provided events
  for (const event of events) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    actor.send(typeof event === 'string' ? { type: event } : event);
    eventsConsumed++;
    const after = actor.getSnapshot();
    const stateStr = String(after.value);
    if (statesVisited[statesVisited.length - 1] !== stateStr) {
      statesVisited.push(stateStr);
    }
  }

  // Pad with PASS to reach terminal
  const maxPad = opts?.maxPad ?? 200;
  for (let i = 0; i < maxPad; i++) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    actor.send({ type: 'PASS' });
    eventsConsumed++;
    const after = actor.getSnapshot();
    const stateStr = String(after.value);
    if (statesVisited[statesVisited.length - 1] !== stateStr) {
      statesVisited.push(stateStr);
    }
  }

  const snap = actor.getSnapshot();
  return {
    terminalState: String(snap.value),
    lifecycle: snap.context.lifecycle,
    lastAction: snap.context.lastAction,
    lastMessage: snap.context.lastMessage,
    retryCount: snap.context.retryCount,
    parentRetryCount: snap.context.parentRetryCount,
    iterationRetryCount: snap.context.iterationRetryCount,
    forStackLength: snap.context.forStack.length,
    deferredResults: snap.context.deferredResults ?? [],
    substepCompletedCount: snap.context.substepCompletedCount,
    eventsConsumed,
    statesVisited,
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

export const eventArb: fc.Arbitrary<'PASS' | 'FAIL'> = fc.constantFrom('PASS', 'FAIL');

export const simpleActionArb: fc.Arbitrary<'CONTINUE' | 'STOP' | 'COMPLETE'> = fc.constantFrom(
  'CONTINUE',
  'STOP',
  'COMPLETE',
);

export const substepActionArb: fc.Arbitrary<'CONTINUE' | 'DEFER' | 'STOP' | 'COMPLETE'> =
  fc.constantFrom('CONTINUE', 'DEFER', 'STOP', 'COMPLETE');

export function eventsArb(minLen: number, maxLen: number): fc.Arbitrary<('PASS' | 'FAIL')[]> {
  return fc.array(eventArb, { minLength: minLen, maxLength: maxLen });
}
