/**
 * Property tests for linear step sequences.
 *
 * Tests compilation of N sequential base steps with PASS/FAIL transitions.
 * Five properties at 200 runs each (1,000 total).
 */

import fc from 'fast-check';
import {
  inferSteps,
  makeTransitions,
  runMachine,
  simpleActionArb,
  type StepInput,
} from './compiler-property-helpers.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

interface LinearConfig {
  numSteps: number;
  passActions: ('CONTINUE' | 'STOP' | 'COMPLETE')[];
  failActions: ('CONTINUE' | 'STOP' | 'COMPLETE')[];
}

const linearConfigArb: fc.Arbitrary<LinearConfig> = fc
  .integer({ min: 1, max: 6 })
  .chain((numSteps) =>
    fc.record({
      numSteps: fc.constant(numSteps),
      passActions: fc.tuple(
        ...Array.from({ length: numSteps - 1 }, () => simpleActionArb),
        fc.constant('COMPLETE' as const),
      ) as fc.Arbitrary<('CONTINUE' | 'STOP' | 'COMPLETE')[]>,
      failActions: fc.array(simpleActionArb, {
        minLength: numSteps,
        maxLength: numSteps,
      }),
    }),
  );

function buildLinearSteps(config: LinearConfig): StepInput[] {
  return Array.from({ length: config.numSteps }, (_, i) => ({
    name: String(i + 1),
    description: `Step ${i + 1}`,
    transitions: makeTransitions('ALL', config.passActions[i], config.failActions[i]),
  }));
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Linear sequence properties', () => {
  // Property 1: Termination — any all-PASS event sequence terminates
  it('always terminates in COMPLETE or STOPPED', () => {
    fc.assert(
      fc.property(linearConfigArb, (config) => {
        const steps = inferSteps(buildLinearSteps(config));
        const events = Array.from({ length: config.numSteps + 5 }, () => 'PASS' as const);
        const result = runMachine(steps, events);
        expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
      }),
      { numRuns: 200 },
    );
  });

  // Property 2: All-CONTINUE-PASS reaches COMPLETE
  it('all-CONTINUE pass actions with all-PASS events produces COMPLETE', () => {
    const allContinueConfig: fc.Arbitrary<LinearConfig> = fc
      .integer({ min: 1, max: 6 })
      .map((numSteps) => ({
        numSteps,
        passActions: [
          ...Array.from({ length: numSteps - 1 }, () => 'CONTINUE' as const),
          'COMPLETE' as const,
        ],
        failActions: Array.from({ length: numSteps }, () => 'STOP' as const),
      }));

    fc.assert(
      fc.property(allContinueConfig, (config) => {
        const steps = inferSteps(buildLinearSteps(config));
        const events = Array.from({ length: config.numSteps + 5 }, () => 'PASS' as const);
        const result = runMachine(steps, events);
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 3: STOP propagation — FAIL at step K with FAIL:STOP produces STOPPED
  it('FAIL at a step with FAIL:STOP produces STOPPED', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        (numSteps, stopIdx) => {
          const adjustedIdx = stopIdx % numSteps;
          const passActions = [
            ...Array.from({ length: numSteps - 1 }, () => 'CONTINUE' as const),
            'COMPLETE' as const,
          ];
          const failActions = Array.from({ length: numSteps }, () => 'STOP' as const);
          const config: LinearConfig = { numSteps, passActions, failActions };
          const steps = inferSteps(buildLinearSteps(config));

          // Send PASS to reach step adjustedIdx, then FAIL
          const events: ('PASS' | 'FAIL')[] = [
            ...Array.from({ length: adjustedIdx }, () => 'PASS' as const),
            'FAIL',
          ];
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('STOPPED');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 4: Early COMPLETE — PASS:COMPLETE at step K < last skips later steps
  it('early COMPLETE skips later steps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 4 }),
        (numSteps, earlyIdx) => {
          const adjustedIdx = earlyIdx % (numSteps - 1); // ensure not last step
          const passActions = Array.from({ length: numSteps }, (_, i) =>
            i === adjustedIdx ? ('COMPLETE' as const) : ('CONTINUE' as const),
          );
          // Override last to COMPLETE too (standard)
          passActions[numSteps - 1] = 'COMPLETE';
          const failActions = Array.from({ length: numSteps }, () => 'STOP' as const);
          const config: LinearConfig = { numSteps, passActions, failActions };
          const steps = inferSteps(buildLinearSteps(config));

          const events = Array.from({ length: numSteps + 5 }, () => 'PASS' as const);
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('COMPLETE');

          // Steps after the early COMPLETE step should not be visited
          for (let i = adjustedIdx + 2; i <= numSteps; i++) {
            expect(result.statesVisited).not.toContain(`step::${i}`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 5: Step count matches events consumed
  it('all-CONTINUE config consumes exactly numSteps PASS events', () => {
    const allContinueConfig: fc.Arbitrary<LinearConfig> = fc
      .integer({ min: 1, max: 6 })
      .map((numSteps) => ({
        numSteps,
        passActions: [
          ...Array.from({ length: numSteps - 1 }, () => 'CONTINUE' as const),
          'COMPLETE' as const,
        ],
        failActions: Array.from({ length: numSteps }, () => 'STOP' as const),
      }));

    fc.assert(
      fc.property(allContinueConfig, (config) => {
        const steps = inferSteps(buildLinearSteps(config));
        // Send exactly numSteps PASS events (no padding)
        const events = Array.from({ length: config.numSteps }, () => 'PASS' as const);
        const result = runMachine(steps, events, { maxPad: 0 });
        expect(result.terminalState).toBe('COMPLETE');
        expect(result.eventsConsumed).toBe(config.numSteps);
      }),
      { numRuns: 200 },
    );
  });
});
