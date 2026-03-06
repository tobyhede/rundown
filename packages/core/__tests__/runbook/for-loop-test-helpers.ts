/**
 * Shared helpers for FOR loop property and pairwise tests.
 *
 * Provides:
 * - ForLoopConfig — captures all 3 transition layers as data
 * - buildForLoopSteps — converts config to parser Step[]
 * - runForLoop — compiles, creates actor, sends events, returns result
 * - predictOutcome — oracle that simulates the 3-layer transition system
 */

import { createActor, type AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { shouldAggregationPass } from '../../src/runbook/transition-handler.js';
import type {
  Step,
  Substep,
  Transitions,
  TransitionObject,
  Action,
} from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Config type — captures all 3 layers as data
// ---------------------------------------------------------------------------

export type SubstepAction = 'CONTINUE' | 'DEFER' | 'NEXT' | 'BREAK' | 'STOP' | 'COMPLETE';
export type IterationAction = 'CONTINUE' | 'DEFER' | 'BREAK' | 'STOP' | 'COMPLETE';
export type ParentAction = 'CONTINUE' | 'DEFER' | 'STOP' | 'COMPLETE';

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
  iterationAggMode: boolean; // true=ALL, false=ANY
  iterationFailRetry: number; // 0–2

  // Layer 3: parent aggregation (step.transitions)
  parentPassAction: ParentAction;
  parentFailAction: ParentAction;
  parentAggMode: boolean; // true=ALL, false=ANY
  parentFailRetry: number; // 0–2
}

// ---------------------------------------------------------------------------
// Step builder — converts ForLoopConfig to parser Step[]
// ---------------------------------------------------------------------------

function makeAction(type: string): Action {
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
    default:
      return { type: 'CONTINUE' };
  }
}

function makeTransitionObject(kind: 'pass' | 'fail', action: string, retry = 0): TransitionObject {
  return { kind, retry, action: makeAction(action) };
}

function makeTransitions(
  all: boolean,
  passAction: string,
  failAction: string,
  failRetry = 0,
): Transitions {
  return {
    all,
    pass: makeTransitionObject('pass', passAction),
    fail: makeTransitionObject('fail', failAction, failRetry),
  };
}

/**
 * Convert a ForLoopConfig to a 2-step runbook: step 1 = FOR loop, step 2 = terminal.
 */
export function buildForLoopSteps(config: ForLoopConfig): Step[] {
  const substeps: Substep[] = [];
  for (let i = 1; i <= config.numSubsteps; i++) {
    substeps.push({
      id: String(i),
      description: `Substep ${String(i)}`,
      transitions: makeTransitions(
        true,
        config.substepPassAction,
        config.substepFailAction,
        config.substepFailRetry,
      ),
    });
  }

  const forStep: Step = {
    kind: 'for',
    name: '1',
    description: 'FOR loop step',
    forClause: {
      start: 1,
      end: config.iterations,
      transitions: makeTransitions(
        config.iterationAggMode,
        config.iterationPassAction,
        config.iterationFailAction,
        config.iterationFailRetry,
      ),
    },
    transitions: makeTransitions(
      config.parentAggMode,
      config.parentPassAction,
      config.parentFailAction,
      config.parentFailRetry,
    ),
    substeps,
  };

  const terminalStep: Step = {
    kind: 'base',
    name: '2',
    description: 'Terminal',
    transitions: {
      all: true,
      pass: makeTransitionObject('pass', 'COMPLETE'),
      fail: makeTransitionObject('fail', 'STOP'),
    },
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
 * Compile a ForLoopConfig into a machine, send events, and return the result.
 *
 * Sends the provided events only while the machine is in the FOR loop step
 * (step 1). Once the machine exits the FOR loop (reaches step 2 or terminal),
 * pads with PASS to drive it to completion. This matches the oracle which
 * only models the FOR loop and assumes step 2 always passes.
 */
export function runForLoop(config: ForLoopConfig, events: EventType[]): RunResult {
  const steps = buildForLoopSteps(config);
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
  return {
    terminalState: String(snap.value),
    forStackLength: snap.context.forStack.length,
    iterationResults: snap.context.iterationResults ?? [],
    eventsConsumed: consumed,
  };
}

// ---------------------------------------------------------------------------
// Event pattern generators
// ---------------------------------------------------------------------------

export type EventPattern = 'all-pass' | 'all-fail' | 'first-fail' | 'last-fail' | 'alternate';

/**
 * Generate an event sequence for the given config and pattern.
 *
 * Generates enough events to cover all iterations × substeps plus retries.
 */
export function generateEvents(config: ForLoopConfig, pattern: EventPattern): EventType[] {
  // Upper bound: each substep may retry, each iteration may retry
  const maxSubstepEvents = config.numSubsteps * (1 + config.substepFailRetry);
  const maxIterationEvents = maxSubstepEvents * (1 + config.iterationFailRetry);
  const maxEvents = config.iterations * maxIterationEvents * (1 + config.parentFailRetry) + 10; // extra padding

  const events: EventType[] = [];
  let globalIndex = 0;

  for (let i = 0; i < maxEvents; i++) {
    let event: EventType;
    switch (pattern) {
      case 'all-pass':
        event = 'PASS';
        break;
      case 'all-fail':
        event = 'FAIL';
        break;
      case 'first-fail':
        event = globalIndex === 0 ? 'FAIL' : 'PASS';
        break;
      case 'last-fail':
        // Put a FAIL near the expected end
        event = globalIndex === config.iterations * config.numSubsteps - 1 ? 'FAIL' : 'PASS';
        break;
      case 'alternate':
        event = globalIndex % 2 === 0 ? 'PASS' : 'FAIL';
        break;
    }
    events.push(event);
    globalIndex++;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Oracle — predicts terminal state by simulating the 3-layer transition system
// ---------------------------------------------------------------------------

type OracleResult = 'COMPLETE' | 'STOPPED';

/**
 * Simulate the 3-layer FOR loop transition system to predict terminal state.
 *
 * Layer 1: substep transitions — each substep's PASS/FAIL action
 * Layer 2: iteration transitions — aggregation of substep results per iteration
 * Layer 3: parent transitions — aggregation of iteration results
 */
export function predictOutcome(config: ForLoopConfig, events: EventType[]): OracleResult {
  let eventIdx = 0;

  const nextEvent = (): EventType => {
    if (eventIdx >= events.length) return 'PASS'; // pad with PASS
    return events[eventIdx++];
  };

  const allIterationResults: ('pass' | 'fail')[] = [];

  // Outer: parent retry loop
  for (let parentRetry = 0; parentRetry <= config.parentFailRetry; parentRetry++) {
    allIterationResults.length = 0;

    // Iteration loop
    for (let iter = 1; iter <= config.iterations; iter++) {
      // Iteration retry loop
      let iterResult: 'pass' | 'fail' = 'fail';
      for (let iterRetry = 0; iterRetry <= config.iterationFailRetry; iterRetry++) {
        const deferredResults: ('pass' | 'fail')[] = [];
        let earlyExit: 'BREAK' | 'NEXT' | 'STOP' | 'COMPLETE' | null = null;

        // Substep loop
        for (let sub = 0; sub < config.numSubsteps; sub++) {
          let event = nextEvent();
          let substepAction: SubstepAction = config.substepFailAction;
          let kind: 'pass' | 'fail' = 'fail';

          if (event === 'PASS') {
            substepAction = config.substepPassAction;
            kind = 'pass';
          } else {
            // Handle substep fail retry
            for (let r = 0; r < config.substepFailRetry; r++) {
              // Retry: consume next event
              event = nextEvent();
              if (event === 'PASS') {
                substepAction = config.substepPassAction;
                kind = 'pass';
                break;
              }
            }
          }

          // Process substep action
          if (substepAction === 'STOP') return 'STOPPED';
          if (substepAction === 'COMPLETE') return 'COMPLETE';
          if (substepAction === 'BREAK') {
            earlyExit = 'BREAK';
            break;
          }
          if (substepAction === 'NEXT') {
            earlyExit = 'NEXT';
            break;
          }
          // Only DEFER contributes to aggregation; CONTINUE is flow control only
          if (substepAction === 'DEFER') {
            deferredResults.push(kind);
          }
        }

        // Aggregate deferred results for this iteration using iteration-level aggregation
        const hasFailed = deferredResults.some((r) => r === 'fail');
        const passCount = deferredResults.filter((r) => r === 'pass').length;
        iterResult = shouldAggregationPass(hasFailed, passCount, config.iterationAggMode)
          ? 'pass'
          : 'fail';

        // If BREAK at substep level, skip iteration-level retry and exit loop
        if (earlyExit === 'BREAK') {
          // Check iteration-level transition for the result
          const iterAction =
            iterResult === 'pass' ? config.iterationPassAction : config.iterationFailAction;
          if (iterAction === 'STOP') return 'STOPPED';
          if (iterAction === 'COMPLETE') return 'COMPLETE';
          // Record result and exit loop
          allIterationResults.push(iterResult);
          // BREAK exits the iteration loop entirely
          return aggregateParent(config, allIterationResults, iterResult);
        }

        // Process iteration-level transition
        const iterAction =
          iterResult === 'pass' ? config.iterationPassAction : config.iterationFailAction;

        if (iterAction === 'STOP') return 'STOPPED';
        if (iterAction === 'COMPLETE') return 'COMPLETE';

        // Check iteration-level retry (only on fail)
        if (
          iterResult === 'fail' &&
          config.iterationFailRetry > 0 &&
          iterRetry < config.iterationFailRetry
        ) {
          // Retry iteration — continue inner loop
          continue;
        }

        if (iterAction === 'BREAK') {
          allIterationResults.push(iterResult);
          return aggregateParent(config, allIterationResults, iterResult);
        }

        // CONTINUE exits the loop (goes to next step)
        if (iterAction === 'CONTINUE') {
          allIterationResults.push(iterResult);
          return aggregateParent(config, allIterationResults, iterResult);
        }

        // DEFER: record result and proceed to next iteration (loop back with accumulation)
        break; // break out of iteration retry loop
      }

      allIterationResults.push(iterResult);
    }

    // All iterations complete. Aggregate at parent level.
    // The last iteration result is computed inline (not in allIterationResults for the compiler,
    // but our oracle tracks all of them).
    const result = aggregateParentFromAll(config, allIterationResults);
    if (result !== null) return result;

    // Parent retry: if we get here, parent retried. Retry events should continue.
  }

  // Exhausted parent retries — use the final aggregation
  return aggregateParentFromAll(config, allIterationResults) ?? 'STOPPED';
}

/**
 * Aggregate iteration results at the parent level, handling BREAK mid-loop.
 * Called when the loop exits early (BREAK).
 */
function aggregateParent(
  config: ForLoopConfig,
  completedResults: ('pass' | 'fail')[],
  _currentIterResult: 'pass' | 'fail',
): OracleResult {
  // For BREAK, the current iteration is the last one. Include it in aggregation.
  // completedResults already includes the current iteration (added by caller).
  return aggregateParentFromAll(config, completedResults) ?? 'STOPPED';
}

/**
 * Aggregate all iteration results and apply parent-level transitions.
 * Returns null if parent should retry.
 */
function aggregateParentFromAll(
  config: ForLoopConfig,
  allResults: ('pass' | 'fail')[],
): OracleResult | null {
  const hasFailed = allResults.some((r) => r === 'fail');
  const passCount = allResults.filter((r) => r === 'pass').length;
  const parentPassed = shouldAggregationPass(hasFailed, passCount, config.parentAggMode);

  const parentAction = parentPassed ? config.parentPassAction : config.parentFailAction;

  switch (parentAction) {
    case 'STOP':
      return 'STOPPED';
    case 'COMPLETE':
      return 'COMPLETE';
    case 'CONTINUE':
      // CONTINUE at parent → next step (step 2) → PASS → COMPLETE
      return 'COMPLETE';
    default:
      return 'STOPPED';
  }
}
