/**
 * Structural property tests encoding design invariants introduced by the
 * FOR iteration guard restructuring.
 *
 * These test design *decisions*, not universal invariants. They are falsifiable
 * properties tested directly against the compiler, independent of the oracle.
 *
 * Properties:
 * 1. RETRY is universal — fires for every substep action type
 * 2. NEXT never accumulates iteration results
 * 3. BREAK includes current iteration's deferred results in aggregation
 * 4. Iteration-level BREAK is non-accumulating
 * 5. Only DEFER accumulates at iteration level
 */

import fc from 'fast-check';
import {
  runForLoop,
  runFromSteps,
  makeTransitions,
  makeTransitionObject,
  type ForLoopConfig,
  type EventType,
  type RunResult,
} from './for-loop-test-helpers.js';
import type { Step, Substep } from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Custom step builder for non-uniform substep configs
// ---------------------------------------------------------------------------

interface SubstepConfig {
  passAction: string;
  failAction: string;
  failRetry?: number;
}

interface CustomForOpts {
  iterations: number;
  substeps: SubstepConfig[];
  iterationTransitions: {
    passAction: string;
    failAction: string;
    aggMode: 'ALL' | 'ANY' | 'none';
    failRetry?: number;
  };
  parentTransitions: {
    passAction: string;
    failAction: string;
    aggMode: 'ALL' | 'ANY' | 'none';
  };
}

function buildCustomSteps(opts: CustomForOpts): Step[] {
  const substeps: Substep[] = opts.substeps.map((sub, i) => ({
    id: String(i + 1),
    description: `Substep ${String(i + 1)}`,
    transitions: makeTransitions('ALL', sub.passAction, sub.failAction, sub.failRetry ?? 0),
  }));

  const forStep: Step = {
    kind: 'for',
    name: '1',
    description: 'FOR loop step',
    forClause: {
      start: 1,
      end: opts.iterations,
      transitions: makeTransitions(
        opts.iterationTransitions.aggMode,
        opts.iterationTransitions.passAction,
        opts.iterationTransitions.failAction,
        opts.iterationTransitions.failRetry ?? 0,
      ),
    },
    transitions: makeTransitions(
      opts.parentTransitions.aggMode,
      opts.parentTransitions.passAction,
      opts.parentTransitions.failAction,
    ),
    substeps,
  };

  const terminalStep: Step = {
    kind: 'base',
    name: '2',
    description: 'Terminal',
    transitions: {
      aggregation: 'ALL',
      pass: makeTransitionObject('pass', 'COMPLETE'),
      fail: makeTransitionObject('fail', 'STOP'),
    },
  };

  return [forStep, terminalStep];
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('FOR loop design invariants', () => {
  // Property 1: RETRY is universal — fires for every substep action type
  //
  // Iteration-level RETRY fires based on iteration result, not substep action type.
  // For each of BREAK, NEXT, DEFER, and CONTINUE as sub2's fail action:
  //   sub1=DEFER(both) → defers result, sub2=action-under-test
  //   All FAIL events → deferredResults=['fail'] → iteration fails → retry fires
  //   Assertion: eventsConsumed(retry=N) > eventsConsumed(retry=0)
  describe('RETRY is universal', () => {
    const sub2Actions = ['BREAK', 'NEXT', 'DEFER'] as const;

    for (const action of sub2Actions) {
      it(`retry fires when sub2 action is ${action}`, () => {
        fc.assert(
          fc.property(
            fc.integer({ min: 1, max: 3 }),
            fc.integer({ min: 1, max: 2 }),
            (iterations, retryCount) => {
              const baseOpts: CustomForOpts = {
                iterations,
                substeps: [
                  { passAction: 'DEFER', failAction: 'DEFER' },
                  { passAction: 'DEFER', failAction: action },
                ],
                iterationTransitions: {
                  passAction: 'DEFER',
                  failAction: 'DEFER',
                  aggMode: 'ALL',
                  failRetry: 0,
                },
                parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
              };

              const retryOpts: CustomForOpts = {
                ...baseOpts,
                iterationTransitions: {
                  ...baseOpts.iterationTransitions,
                  failRetry: retryCount,
                },
              };

              // All FAIL events — enough for any retry depth
              const maxEvents = iterations * 2 * (1 + retryCount) + 20;
              const events = Array.from({ length: maxEvents }, () => 'FAIL' as EventType);

              const noRetry = runFromSteps(buildCustomSteps(baseOpts), events);
              const withRetry = runFromSteps(buildCustomSteps(retryOpts), events);

              expect(withRetry.eventsConsumed).toBeGreaterThan(noRetry.eventsConsumed);
            },
          ),
          { numRuns: 100 },
        );
      });
    }

    // Control case: CONTINUE as sub2 (doesn't DEFER itself, but sub1 already DEFER'd)
    // deferredResults=['fail'] from sub1 → iteration still fails → retry fires
    it('retry fires when sub2 action is CONTINUE (control case)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 1, max: 2 }),
          (iterations, retryCount) => {
            const baseOpts: CustomForOpts = {
              iterations,
              substeps: [
                { passAction: 'DEFER', failAction: 'DEFER' },
                { passAction: 'CONTINUE', failAction: 'CONTINUE' },
              ],
              iterationTransitions: {
                passAction: 'DEFER',
                failAction: 'DEFER',
                aggMode: 'ALL',
                failRetry: 0,
              },
              parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
            };

            const retryOpts: CustomForOpts = {
              ...baseOpts,
              iterationTransitions: {
                ...baseOpts.iterationTransitions,
                failRetry: retryCount,
              },
            };

            const maxEvents = iterations * 2 * (1 + retryCount) + 20;
            const events = Array.from({ length: maxEvents }, () => 'FAIL' as EventType);

            const noRetry = runFromSteps(buildCustomSteps(baseOpts), events);
            const withRetry = runFromSteps(buildCustomSteps(retryOpts), events);

            expect(withRetry.eventsConsumed).toBeGreaterThan(noRetry.eventsConsumed);
          },
        ),
        { numRuns: 100 },
      );
    });

    // Negative case: no DEFER at substep level → deferredResults=[] → vacuous pass → no retry
    it('retry does not fire when no substep DEFERs (vacuous pass)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3 }),
          fc.constantFrom('BREAK' as const, 'NEXT' as const),
          (iterations, sub2Action) => {
            const baseOpts: CustomForOpts = {
              iterations,
              substeps: [
                { passAction: 'CONTINUE', failAction: 'CONTINUE' },
                { passAction: 'CONTINUE', failAction: sub2Action },
              ],
              iterationTransitions: {
                passAction: 'DEFER',
                failAction: 'DEFER',
                aggMode: 'ALL',
                failRetry: 0,
              },
              parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
            };

            const retryOpts: CustomForOpts = {
              ...baseOpts,
              iterationTransitions: {
                ...baseOpts.iterationTransitions,
                failRetry: 2,
              },
            };

            const maxEvents = iterations * 2 * 4 + 20;
            const events = Array.from({ length: maxEvents }, () => 'FAIL' as EventType);

            const noRetry = runFromSteps(buildCustomSteps(baseOpts), events);
            const withRetry = runFromSteps(buildCustomSteps(retryOpts), events);

            // No DEFER → vacuous pass → retry never fires → same events consumed
            expect(withRetry.eventsConsumed).toBe(noRetry.eventsConsumed);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // Property 2: NEXT never accumulates
  //
  // NEXT at substep level prevents the current iteration's results from being
  // added to iterationResults, regardless of what was DEFER'd within the iteration.
  describe('NEXT never accumulates', () => {
    // Setup A: uniform NEXT on both pass and fail
    it('uniform NEXT produces empty iterationResults', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.constantFrom<'DEFER' | 'NEXT' | 'CONTINUE'>('DEFER', 'NEXT', 'CONTINUE'),
          (iterations, iterationAction) => {
            const config: ForLoopConfig = {
              iterations,
              numSubsteps: 1,
              substepPassAction: 'NEXT',
              substepFailAction: 'NEXT',
              substepFailRetry: 0,
              iterationPassAction: iterationAction,
              iterationFailAction: iterationAction,
              iterationAggMode: 'ALL',
              iterationFailRetry: 0,
              parentPassAction: 'CONTINUE',
              parentFailAction: 'STOP',
              parentAggMode: 'ALL',
              parentFailRetry: 0,
            };

            const events = Array.from({ length: iterations + 10 }, () => 'PASS' as EventType);
            const result = runForLoop(config, events);
            expect(result.iterationResults.length).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    });

    // Setup B: sub1=DEFER then sub2=NEXT — DEFER'd result is discarded by NEXT
    it('DEFER then NEXT still produces empty iterationResults', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.constantFrom<EventType>('PASS', 'FAIL'),
          (iterations, event) => {
            const opts: CustomForOpts = {
              iterations,
              substeps: [
                { passAction: 'DEFER', failAction: 'DEFER' },
                { passAction: 'NEXT', failAction: 'NEXT' },
              ],
              iterationTransitions: {
                passAction: 'DEFER',
                failAction: 'DEFER',
                aggMode: 'ALL',
              },
              parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
            };

            const events = Array.from({ length: iterations * 2 + 10 }, () => event);
            const result = runFromSteps(buildCustomSteps(opts), events);
            expect(result.iterationResults.length).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // Property 3: BREAK includes current iteration's deferred results in aggregation
  //
  // When BREAK exits the loop, substeps that already DEFER'd within the current
  // iteration still count in parent aggregation. If they didn't, aggregation would
  // see empty results → vacuous pass → COMPLETE. STOPPED proves they were included.
  describe('BREAK includes deferred results in aggregation', () => {
    it('BREAK after DEFER produces STOPPED via parent PASS ALL', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 1, max: 3 }),
          (iterations, numDeferSubsteps) => {
            // N DEFER substeps followed by 1 BREAK-on-fail substep
            const substeps: SubstepConfig[] = [];
            for (let i = 0; i < numDeferSubsteps; i++) {
              substeps.push({ passAction: 'DEFER', failAction: 'DEFER' });
            }
            substeps.push({ passAction: 'CONTINUE', failAction: 'BREAK' });

            const opts: CustomForOpts = {
              iterations,
              substeps,
              iterationTransitions: {
                passAction: 'DEFER',
                failAction: 'DEFER',
                aggMode: 'ALL',
              },
              parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
            };

            // All FAIL → each DEFER substep defers 'fail', then BREAK substep fails → BREAK
            const totalSubsteps = numDeferSubsteps + 1;
            const events = Array.from({ length: totalSubsteps + 10 }, () => 'FAIL' as EventType);

            const result = runFromSteps(buildCustomSteps(opts), events);

            // BREAK exits loop. deferredResults has 'fail' entries from DEFER substeps.
            // Aggregation: PASS ALL with failures → parent fails → STOP → STOPPED.
            // If BREAK dropped deferred results: empty → vacuous pass → COMPLETE (wrong).
            expect(result.terminalState).toBe('STOPPED');
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // Property 4: Iteration-level BREAK is non-accumulating
  //
  // When iterationFailAction is BREAK, the loop exits without adding the
  // current iteration's result to iterationResults.
  describe('iteration-level BREAK is non-accumulating', () => {
    it('iterationFailAction BREAK exits loop without accumulating current iteration', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 4 }), (iterations) => {
          const opts: CustomForOpts = {
            iterations,
            substeps: [{ passAction: 'DEFER', failAction: 'DEFER' }],
            iterationTransitions: {
              passAction: 'DEFER',
              failAction: 'BREAK',
              aggMode: 'ALL',
            },
            parentTransitions: { passAction: 'CONTINUE', failAction: 'STOP', aggMode: 'ALL' },
          };

          // First iteration passes (DEFER'd), second fails → iteration BREAK
          const events: EventType[] = ['PASS', 'FAIL'];
          for (let i = 0; i < 20; i++) events.push('PASS');

          const result = runFromSteps(buildCustomSteps(opts), events);
          // Only iteration 1 accumulated (DEFER'd 'pass'). Iteration 2 BREAK'd — non-accumulating.
          // Parent sees ['pass'] → ALL passes → CONTINUE → COMPLETE
          expect(result.terminalState).toBe('COMPLETE');
          expect(result.iterationResults.length).toBe(1);
        }),
        { numRuns: 200 },
      );
    });
  });

  // Property 5: Only DEFER accumulates at iteration level
  //
  // CONTINUE at iteration level exits the loop without adding the current
  // iteration to iterationResults.
  describe('only DEFER accumulates at iteration level', () => {
    it('iteration-level CONTINUE does not accumulate', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.constantFrom<EventType>('PASS', 'FAIL'),
          (iterations, event) => {
            const config: ForLoopConfig = {
              iterations,
              numSubsteps: 1,
              substepPassAction: 'DEFER',
              substepFailAction: 'DEFER',
              substepFailRetry: 0,
              iterationPassAction: 'CONTINUE',
              iterationFailAction: 'CONTINUE',
              iterationAggMode: 'ALL',
              iterationFailRetry: 0,
              parentPassAction: 'CONTINUE',
              parentFailAction: 'STOP',
              parentAggMode: 'ALL',
              parentFailRetry: 0,
            };

            const events = Array.from({ length: iterations + 10 }, () => event);
            const result = runForLoop(config, events);

            // CONTINUE at iteration level exits the loop — no accumulation
            expect(result.iterationResults.length).toBe(0);
          },
        ),
        { numRuns: 200 },
      );
    });

    // Contrast: DEFER at iteration level DOES accumulate
    it('iteration-level DEFER does accumulate', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.constantFrom<EventType>('PASS', 'FAIL'),
          (iterations, event) => {
            const config: ForLoopConfig = {
              iterations,
              numSubsteps: 1,
              substepPassAction: 'DEFER',
              substepFailAction: 'DEFER',
              substepFailRetry: 0,
              iterationPassAction: 'DEFER',
              iterationFailAction: 'DEFER',
              iterationAggMode: 'ALL',
              iterationFailRetry: 0,
              parentPassAction: 'CONTINUE',
              parentFailAction: 'STOP',
              parentAggMode: 'ALL',
              parentFailRetry: 0,
            };

            const events = Array.from({ length: iterations + 10 }, () => event);
            const result = runForLoop(config, events);

            // Every iteration is treated uniformly — all DEFER'd results are in iterationResults
            expect(result.iterationResults.length).toBe(iterations);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
