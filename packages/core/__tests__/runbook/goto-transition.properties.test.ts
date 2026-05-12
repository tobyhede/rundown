/**
 * Property tests for GOTO transition correctness.
 *
 * Tests GOTO lands on correct state, skips intermediates, and preserves lastAction.
 * Four properties at 200 runs each (800 total).
 */

import fc from 'fast-check';
import { createActor, type AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { stateValueAsString } from '../../src/runbook/actor-service.js';
import { inferSteps, makeTransitions, type StepInput } from './compiler-property-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLinearBaseSteps(numSteps: number): StepInput[] {
  return Array.from({ length: numSteps }, (_, i) => ({
    name: String(i + 1),
    description: `Step ${String(i + 1)}`,
    transitions: makeTransitions(i === numSteps - 1 ? 'COMPLETE' : 'CONTINUE', 'STOP'),
  }));
}

/** Run machine with explicit event sequence including GOTOs, no auto-pad. */
function runWithEvents(
  steps: StepInput[],
  events: ({ type: 'PASS' } | { type: 'FAIL' } | { type: 'GOTO'; target: { step: string } })[],
): {
  terminalState: string;
  statesVisited: string[];
  lastAction?: { type: string; target?: string };
} {
  const compiled = inferSteps(steps);
  const machine = compileRunbookToMachine(compiled);
  const actor = createActor(machine as AnyStateMachine);

  const statesVisited: string[] = [];
  actor.start();
  statesVisited.push(
    stateValueAsString(actor.getSnapshot().value) ?? String(actor.getSnapshot().value),
  );

  for (const event of events) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    actor.send(event);
    const after = actor.getSnapshot();
    const stateStr = stateValueAsString(after.value) ?? String(after.value);
    if (statesVisited[statesVisited.length - 1] !== stateStr) {
      statesVisited.push(stateStr);
    }
  }

  // Pad with PASS to reach terminal
  for (let i = 0; i < 50; i++) {
    const snap = actor.getSnapshot();
    if (snap.status === 'done') break;
    actor.send({ type: 'PASS' });
    const after = actor.getSnapshot();
    const stateStr = stateValueAsString(after.value) ?? String(after.value);
    if (statesVisited[statesVisited.length - 1] !== stateStr) {
      statesVisited.push(stateStr);
    }
  }

  const snap = actor.getSnapshot();
  const la = snap.context.lastAction;
  return {
    terminalState: String(snap.value),
    statesVisited,
    lastAction: la
      ? { type: la.type, ...(la.type === 'GOTO' ? { target: la.target } : {}) }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('GOTO transition properties', () => {
  // Property 1: GOTO lands on correct state
  // Assert the immediate post-GOTO state (no PASS padding) to avoid masking
  // routing regressions where linear progression could reach the target anyway.
  it('GOTO transitions to the correct target state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (numSteps, rawTarget) => {
          const targetStep = ((rawTarget - 1) % numSteps) + 1;
          const steps = buildLinearBaseSteps(numSteps);

          const compiled = inferSteps(steps);
          const machine = compileRunbookToMachine(compiled);
          const actor = createActor(machine as AnyStateMachine);
          actor.start();

          actor.send({ type: 'GOTO', target: { step: String(targetStep) } });
          const snap = actor.getSnapshot();

          // Immediate state after GOTO must be the target (no padding involved)
          expect(stateValueAsString(snap.value)).toBe(`step::${String(targetStep)}`);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 2: Forward GOTO skips intermediate steps
  it('forward GOTO skips intermediate steps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 6 }),
        fc.integer({ min: 3, max: 6 }),
        (numSteps, rawTarget) => {
          // Ensure target is at least step 3 (skipping step 2)
          const targetStep = Math.min(((rawTarget - 1) % (numSteps - 2)) + 3, numSteps);
          if (targetStep <= 2) return; // guard

          const steps = buildLinearBaseSteps(numSteps);

          // Start at step 1, GOTO to targetStep (skipping step 2..targetStep-1)
          const result = runWithEvents(steps, [
            { type: 'GOTO', target: { step: String(targetStep) } },
          ]);

          // Steps between 1 and target should not be visited
          for (let i = 2; i < targetStep; i++) {
            expect(result.statesVisited).not.toContain(`step::${String(i)}`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 3: Backward GOTO re-enters previous step
  it('backward GOTO re-enters previous step', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 5 }), (numSteps) => {
        const steps = buildLinearBaseSteps(numSteps);

        // Advance to step 2, then GOTO back to step 1
        const result = runWithEvents(steps, [
          { type: 'PASS' }, // advance from step 1 to step 2
          { type: 'GOTO', target: { step: '1' } }, // back to step 1
        ]);

        // Step 1 should appear at both beginning and after the GOTO
        const step1Indices = result.statesVisited
          .map((s, i) => (s === 'step::1' ? i : -1))
          .filter((i) => i >= 0);
        expect(step1Indices.length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 200 },
    );
  });

  // Property 4: lastAction preserves GOTO target
  it('lastAction records GOTO with correct target after transition', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (numSteps, rawTarget) => {
          const targetStep = ((rawTarget - 1) % numSteps) + 1;
          const steps = buildLinearBaseSteps(numSteps);

          // Send GOTO then immediately check state (before any PASS padding)
          const compiled = inferSteps(steps);
          const machine = compileRunbookToMachine(compiled);
          const actor = createActor(machine as AnyStateMachine);
          actor.start();

          actor.send({ type: 'GOTO', target: { step: String(targetStep) } });
          const snap = actor.getSnapshot();

          expect(snap.context.lastAction?.type).toBe('GOTO');
          if (snap.context.lastAction?.type === 'GOTO') {
            expect(snap.context.lastAction.target).toBe(String(targetStep));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
