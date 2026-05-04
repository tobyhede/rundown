/**
 * Shared helpers for FOR loop property tests.
 *
 * Provides:
 * - ForLoopConfig — captures all 3 transition layers as data
 * - buildForLoopSteps — converts config to parser Step[]
 * - runForLoop — compiles, creates actor, sends events, returns result
 */

import { createActor, type AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import type {
  ResolvedStep,
  Substep,
  Transitions,
  Aggregation,
  TransitionObject,
  Action,
} from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Config type — captures all 3 layers as data
// ---------------------------------------------------------------------------

export type SubstepAction = 'CONTINUE' | 'DEFER' | 'NEXT' | 'BREAK' | 'STOP' | 'COMPLETE' | 'GOTO';
export type IterationAction =
  | 'CONTINUE'
  | 'DEFER'
  | 'NEXT'
  | 'BREAK'
  | 'STOP'
  | 'COMPLETE'
  | 'GOTO';
export type ParentAction = 'CONTINUE' | 'DEFER' | 'STOP' | 'COMPLETE' | 'GOTO';
export type ForLoopAction = SubstepAction | IterationAction | ParentAction;

export interface ForLoopConfig {
  iterations: number; // 1–5
  numSubsteps: number; // 1–3

  // Layer 1: substep transitions
  substepPassAction: SubstepAction;
  substepFailAction: SubstepAction;
  substepFailRetry: number; // 0–2

  // Layer 2: iteration transitions (forClause.transitions)
  iterationPassAction: IterationAction;
  iterationFailAction: IterationAction;
  iterationAggMode: 'ALL' | 'ANY' | undefined; // aggregation discriminant
  iterationFailRetry: number; // 0–2

  // Layer 3: parent aggregation (step.transitions)
  parentPassAction: ParentAction;
  parentFailAction: ParentAction;
  parentAggMode: 'ALL' | 'ANY' | undefined; // aggregation discriminant
  parentFailRetry: number; // 0–2
}

// ---------------------------------------------------------------------------
// Step builder — converts ForLoopConfig to parser Step[]
// ---------------------------------------------------------------------------

export function makeAction(type: ForLoopAction): Action {
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
  }
  const exhaustive: never = type;
  return exhaustive;
}

export function makeTransitionObject(
  kind: 'pass' | 'fail',
  action: ForLoopAction,
  retry = 0,
): TransitionObject {
  return { kind, retry, action: makeAction(action) };
}

export function makeTransitions(
  passAction: ForLoopAction,
  failAction: ForLoopAction,
  failRetry = 0,
): Transitions {
  return {
    pass: makeTransitionObject('pass', passAction),
    fail: makeTransitionObject('fail', failAction, failRetry),
  };
}

export function makeAggregation(mode: 'ALL' | 'ANY' | undefined): Aggregation | undefined {
  return mode ? { strategy: mode } : undefined;
}

/**
 * Convert a ForLoopConfig to a two-step runbook (FOR loop + terminal).
 *
 * @param config - Loop dimensions, transition actions, aggregation modes, and retry counts
 * @returns Two-element Step array: step 1 is the FOR loop with substeps, step 2 is a terminal step
 */
export function buildForLoopSteps(config: ForLoopConfig): ResolvedStep[] {
  const substeps: Substep[] = [];
  for (let i = 1; i <= config.numSubsteps; i++) {
    substeps.push({
      id: String(i),
      description: `Substep ${String(i)}`,
      transitions: makeTransitions(
        config.substepPassAction,
        config.substepFailAction,
        config.substepFailRetry,
      ),
    });
  }

  const forStep: ResolvedStep = {
    kind: 'for',
    name: '1',
    description: 'FOR loop step',
    forClause: {
      start: 1,
      end: config.iterations,
      ...(config.iterationAggMode
        ? {
            transitions: makeTransitions(
              config.iterationPassAction,
              config.iterationFailAction,
              config.iterationFailRetry,
            ),
            aggregation: makeAggregation(config.iterationAggMode),
          }
        : {}),
    },
    transitions: makeTransitions(
      config.parentPassAction,
      config.parentFailAction,
      config.parentFailRetry,
    ),
    aggregation: makeAggregation(config.parentAggMode),
    substeps,
  };

  const terminalStep: ResolvedStep = {
    kind: 'base',
    name: '2',
    description: 'Terminal',
    transitions: makeTransitions('COMPLETE', 'STOP'),
  };

  return [forStep, terminalStep];
}

// ---------------------------------------------------------------------------
// Runner — compiles machine, sends events, returns terminal state
// ---------------------------------------------------------------------------

export type EventType = 'PASS' | 'FAIL';

export interface RunResult {
  terminalState: string; // 'COMPLETE' | 'STOPPED' | step state
  forStackLength: number;
  iterationResults: readonly ('pass' | 'fail')[];
  eventsConsumed: number;
}

/**
 * Compile raw steps into a machine, send events, and return the result.
 *
 * Sends the provided events only while the machine is in the FOR loop step
 * (step 1). Once the machine exits the FOR loop (reaches step 2 or terminal),
 * pads with PASS to drive it to completion.
 *
 * @param steps - Runbook steps to compile into a state machine
 * @param events - Sequence of PASS/FAIL events to send while the machine is in the FOR loop step
 * @returns Terminal state, forStack length, accumulated iteration results, and total events consumed
 * @throws {Error} When padding fails to drive the machine to terminal state within 200 events
 */
export function runFromSteps(steps: ResolvedStep[], events: EventType[]): RunResult {
  const machine = compileRunbookToMachine(steps);
  const actor = createActor(machine as AnyStateMachine);
  actor.start();

  let consumed = 0;
  let eventIdx = 0;

  // Send provided events only while in FOR loop step (step::1 or step::1::*)
  while (eventIdx < events.length) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    const state = String(snap.value);
    // Once we exit the FOR loop step, stop sending patterned events
    if (!state.startsWith('step::1')) break;
    actor.send({ type: events[eventIdx++] });
    consumed++;
  }

  // Pad with PASS to reach terminal state (safety limit)
  const maxPad = 200;
  for (let i = 0; i < maxPad; i++) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    actor.send({ type: 'PASS' });
    consumed++;
  }

  const snap = actor.getSnapshot();
  if (snap.status !== 'done') {
    throw new Error(
      `runFromSteps: machine did not reach terminal state after ${String(consumed)} events. ` +
        `Current state: ${String(snap.value)}`,
    );
  }
  return {
    terminalState: String(snap.value),
    forStackLength: snap.context.forStack.length,
    iterationResults: snap.context.iterationResults ?? [],
    eventsConsumed: consumed,
  };
}

/**
 * Compile a ForLoopConfig into a machine, send events, and return the result.
 *
 * Convenience wrapper that builds steps from config, then delegates to runFromSteps.
 *
 * @param config - Full FOR loop configuration covering substep, iteration, and parent layers
 * @param events - Sequence of PASS/FAIL events to send while the machine is in the FOR loop step
 * @returns Terminal state, forStack length, accumulated iteration results, and total events consumed
 * @throws {Error} When padding fails to drive the machine to terminal state within 200 events
 */
export function runForLoop(config: ForLoopConfig, events: EventType[]): RunResult {
  return runFromSteps(buildForLoopSteps(config), events);
}
