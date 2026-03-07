/**
 * Property tests for three-level retry exhaustion.
 *
 * Tests substep retry, parent retry, and iteration retry independently.
 * Five properties at 300 runs each (1,500 total).
 */

import fc from 'fast-check';
import {
  inferSteps,
  makeTransitions,
  makeTransitionObject,
  runMachine,
  DEFER_TRANSITIONS,
  type StepInput,
} from './compiler-property-helpers.js';
import type { Substep, Transitions } from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Retry exhaustion properties', () => {
  // Property 1: Substep retry — pass before exhaustion
  it('substep passes if PASS arrives before retry exhaustion', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 2 }),
        (retryMax, failsBefore) => {
          const adjustedFails = Math.min(failsBefore, retryMax - 1);
          if (retryMax < 1) return; // need at least 1 retry to test

          const transitions: Transitions = {
            aggregation: 'ALL',
            pass: makeTransitionObject('pass', 'COMPLETE'),
            fail: makeTransitionObject('fail', 'STOP', retryMax),
          };
          const steps = inferSteps([
            {
              name: '1',
              description: 'Retryable step',
              transitions,
            },
          ]);

          // Send adjustedFails FAILs then a PASS
          const events: ('PASS' | 'FAIL')[] = [
            ...Array.from({ length: Math.max(0, adjustedFails) }, () => 'FAIL' as const),
            'PASS',
          ];
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('COMPLETE');
          expect(result.retryCount).toBe(Math.max(0, adjustedFails));
        },
      ),
      { numRuns: 300 },
    );
  });

  // Property 2: Substep retry — exhaustion fires action
  it('substep retry exhaustion fires the exhausted action', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (retryMax) => {
        const transitions: Transitions = {
          aggregation: 'ALL',
          pass: makeTransitionObject('pass', 'COMPLETE'),
          fail: makeTransitionObject('fail', 'STOP', retryMax),
        };
        const steps = inferSteps([
          {
            name: '1',
            description: 'Retryable step',
            transitions,
          },
        ]);

        // Send retryMax+1 consecutive FAILs to exhaust retries
        const events = Array.from({ length: retryMax + 1 }, () => 'FAIL' as const);
        const result = runMachine(steps, events);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 300 },
    );
  });

  // Property 3: Parent retry exhaustion
  // Verify that with parentRetry=R, exactly (R+1)*numSubsteps FAILs produce STOPPED,
  // while R*numSubsteps FAILs followed by all PASS produces COMPLETE (still retrying).
  it('parent retry exhaustion fires the exhausted action', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 }),
        fc.integer({ min: 1, max: 2 }),
        (numSubsteps, parentRetry) => {
          const substeps: Substep[] = Array.from({ length: numSubsteps }, (_, i) => ({
            id: String(i + 1),
            description: `Sub ${i + 1}`,
            transitions: DEFER_TRANSITIONS,
          }));

          const steps = inferSteps([
            {
              name: '1',
              description: 'Step with parent retry',
              transitions: {
                aggregation: 'ALL' as const,
                pass: makeTransitionObject('pass', 'COMPLETE'),
                fail: makeTransitionObject('fail', 'STOP', parentRetry),
              },
              substeps,
            },
          ]);

          // Exhaustion path: (parentRetry+1) rounds of all-FAIL → STOPPED
          const exhaustionEvents = Array.from(
            { length: numSubsteps * (parentRetry + 1) },
            () => 'FAIL' as const,
          );
          const exhaustionResult = runMachine(steps, exhaustionEvents);
          expect(exhaustionResult.terminalState).toBe('STOPPED');

          // Recovery path: parentRetry rounds of all-FAIL, then all-PASS → COMPLETE
          const recoveryEvents: ('PASS' | 'FAIL')[] = [
            ...Array.from({ length: numSubsteps * parentRetry }, () => 'FAIL' as const),
            ...Array.from({ length: numSubsteps + 5 }, () => 'PASS' as const),
          ];
          const recoveryResult = runMachine(steps, recoveryEvents);
          expect(recoveryResult.terminalState).toBe('COMPLETE');
        },
      ),
      { numRuns: 300 },
    );
  });

  // Property 4: Iteration retry exhaustion (FOR loop)
  // Verify that with iterRetry=R, (R+1) FAILs exhaust iteration retry and reach STOPPED,
  // while R FAILs followed by PASS allows the iteration to pass and reach COMPLETE.
  it('iteration retry exhaustion fires the exhausted action', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 }), (iterRetry) => {
        const substeps: Substep[] = [
          { id: '1', description: 'Sub 1', transitions: DEFER_TRANSITIONS },
        ];

        const steps = inferSteps([
          {
            name: '1',
            description: 'FOR step with iteration retry',
            forClause: {
              start: 1,
              end: 1, // single iteration to isolate iteration retry
              transitions: {
                aggregation: 'ALL' as const,
                pass: makeTransitionObject('pass', 'DEFER'),
                fail: makeTransitionObject('fail', 'DEFER', iterRetry),
              },
            },
            transitions: makeTransitions('ALL', 'COMPLETE', 'STOP'),
            substeps,
          },
        ]);

        // Exhaustion path: iterRetry+1 consecutive FAILs → STOPPED
        const exhaustionEvents = Array.from({ length: iterRetry + 1 }, () => 'FAIL' as const);
        const exhaustionResult = runMachine(steps, exhaustionEvents);
        expect(exhaustionResult.terminalState).toBe('STOPPED');

        // Recovery path: iterRetry FAILs then PASS → COMPLETE
        const recoveryEvents: ('PASS' | 'FAIL')[] = [
          ...Array.from({ length: iterRetry }, () => 'FAIL' as const),
          'PASS',
        ];
        const recoveryResult = runMachine(steps, recoveryEvents);
        expect(recoveryResult.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 300 },
    );
  });

  // Property 5: Retry counter independence
  it('incrementing one retry counter does not affect others', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 }), (retryMax) => {
        // Simple step with substep-level retry only — parent and iteration should stay 0
        const transitions: Transitions = {
          aggregation: 'ALL',
          pass: makeTransitionObject('pass', 'COMPLETE'),
          fail: makeTransitionObject('fail', 'STOP', retryMax),
        };
        const steps = inferSteps([
          {
            name: '1',
            description: 'Step with substep retry only',
            transitions,
          },
        ]);

        // Send one FAIL then PASS (retry once, then pass)
        const events: ('PASS' | 'FAIL')[] = ['FAIL', 'PASS'];
        const result = runMachine(steps, events);
        expect(result.terminalState).toBe('COMPLETE');
        expect(result.retryCount).toBe(1);
        expect(result.parentRetryCount).toBe(0);
        expect(result.iterationRetryCount).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
