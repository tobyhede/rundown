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

/**
 * Action literals valid for substep-level FOR-loop transitions in the shared
 * test helper model.
 *
 * Literal values:
 * - `CONTINUE` exits the current step scope through the step handler.
 * - `DEFER` records the substep result for later aggregation.
 * - `NEXT` skips remaining substeps and advances the loop.
 * - `BREAK` exits the current loop without recording the current result.
 * - `STOP` stops the runbook immediately.
 * - `COMPLETE` completes the runbook immediately.
 * - `GOTO` jumps to a target step.
 */
export type SubstepAction = 'CONTINUE' | 'DEFER' | 'NEXT' | 'BREAK' | 'STOP' | 'COMPLETE' | 'GOTO';

/**
 * Action literals valid for iteration-level transitions on a FOR clause in the
 * shared test helper model.
 *
 * Literal values:
 * - `CONTINUE` exits the loop and continues via the parent step handler.
 * - `DEFER` records the iteration result for parent aggregation.
 * - `NEXT` advances to the next iteration without recording the current result.
 * - `BREAK` exits the current loop without recording the current result.
 * - `STOP` stops the runbook immediately.
 * - `COMPLETE` completes the runbook immediately.
 * - `GOTO` jumps to a target step.
 */
export type IterationAction =
  | 'CONTINUE'
  | 'DEFER'
  | 'NEXT'
  | 'BREAK'
  | 'STOP'
  | 'COMPLETE'
  | 'GOTO';

/**
 * Action literals valid for parent step transitions on a FOR step in the shared
 * test helper model.
 *
 * Literal values:
 * - `CONTINUE` advances through normal step control flow.
 * - `DEFER` records a result for an outer aggregation scope.
 * - `STOP` stops the runbook immediately.
 * - `COMPLETE` completes the runbook immediately.
 * - `GOTO` jumps to a target step.
 */
export type ParentAction = 'CONTINUE' | 'DEFER' | 'STOP' | 'COMPLETE' | 'GOTO';

/**
 * Union of all action literals supported by the shared FOR-loop test helper.
 *
 * Includes every literal from {@link SubstepAction}, {@link IterationAction},
 * and {@link ParentAction}: `CONTINUE`, `DEFER`, `NEXT`, `BREAK`, `STOP`,
 * `COMPLETE`, and `GOTO`.
 */
export type ForLoopAction = SubstepAction | IterationAction | ParentAction;

/**
 * Data-driven configuration for building a synthetic FOR-loop runbook in tests.
 *
 * Captures the loop shape plus all three transition layers:
 * substep transitions, iteration transitions, and parent step aggregation.
 */
export interface ForLoopConfig {
  /** Number of loop iterations to generate; property tests usually use 1–5. */
  iterations: number;
  /** Number of substeps to generate; property tests usually use 1–3. */
  numSubsteps: number;
  /** PASS action applied to each generated substep. */
  substepPassAction: SubstepAction;
  /** FAIL action applied to each generated substep. */
  substepFailAction: SubstepAction;
  /** Retry count for generated substep FAIL transitions; usually 0–2. */
  substepFailRetry: number;
  /** PASS action applied by the FOR clause iteration transition layer. */
  iterationPassAction: IterationAction;
  /** FAIL action applied by the FOR clause iteration transition layer. */
  iterationFailAction: IterationAction;
  /** Aggregation mode for iteration results, or undefined for no aggregation. */
  iterationAggMode: 'ALL' | 'ANY' | undefined;
  /** Retry count for generated iteration FAIL transitions; usually 0–2. */
  iterationFailRetry: number;
  /** PASS action applied by the parent FOR step transition layer. */
  parentPassAction: ParentAction;
  /** FAIL action applied by the parent FOR step transition layer. */
  parentFailAction: ParentAction;
  /** Aggregation mode for parent step results, or undefined for no aggregation. */
  parentAggMode: 'ALL' | 'ANY' | undefined;
  /** Retry count for generated parent FAIL transitions; usually 0–2. */
  parentFailRetry: number;
}

// ---------------------------------------------------------------------------
// Step builder — converts ForLoopConfig to parser Step[]
// ---------------------------------------------------------------------------

/**
 * Convert a helper action literal into a parser action object.
 *
 * @param type - Helper action literal to convert.
 * @returns Parser-compatible action object for the requested action literal.
 */
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
  throw new Error(`Unexpected ForLoopAction type: ${String(exhaustive)}`);
}

/**
 * Build a parser transition object for one pass/fail outcome.
 *
 * @param kind - Outcome kind that triggers the transition.
 * @param action - Helper action literal to place on the transition.
 * @param retry - Optional retry count to include on the transition.
 * @returns Parser-compatible transition object.
 */
export function makeTransitionObject(
  kind: 'pass' | 'fail',
  action: ForLoopAction,
  retry = 0,
): TransitionObject {
  return { kind, retry, action: makeAction(action) };
}

/**
 * Build paired pass/fail transitions for generated runbook steps.
 *
 * @param passAction - Helper action literal for PASS outcomes.
 * @param failAction - Helper action literal for FAIL outcomes.
 * @param failRetry - Optional retry count for the FAIL transition.
 * @returns Parser-compatible transitions object.
 */
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

/**
 * Convert an optional aggregation mode literal into a parser aggregation object.
 *
 * @param mode - Aggregation mode, or undefined when no aggregation should exist.
 * @returns Parser-compatible aggregation object, or undefined.
 */
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

/**
 * Event literals used to drive compiled FOR-loop test machines.
 *
 * Literal values:
 * - `PASS` reports a successful step or substep result.
 * - `FAIL` reports a failed step or substep result.
 */
export type EventType = 'PASS' | 'FAIL';

/**
 * Observable execution result returned by FOR-loop helper runners.
 */
export interface RunResult {
  /** Final XState state value, commonly `COMPLETE`, `STOPPED`, or a step state. */
  terminalState: string;
  /** Number of active FOR-loop frames remaining after execution. */
  forStackLength: number;
  /** Iteration results accumulated by the compiled runbook machine. */
  iterationResults: readonly ('pass' | 'fail')[];
  /** Number of events sent to the machine, including padding events. */
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
