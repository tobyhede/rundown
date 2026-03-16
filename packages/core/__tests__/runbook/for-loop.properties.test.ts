/**
 * fast-check property tests for FOR loop compilation.
 *
 * Fifteen invariant properties that hold for ANY valid ForLoopConfig:
 * 1. Termination — always reaches COMPLETE or STOPPED
 * 2. forStack empty at terminal — no dangling loop context
 * 3. PASS ALL + all pass → parent passes
 * 4. PASS ANY + at least one pass → parent passes
 * 5. STOP at substep → STOPPED regardless
 * 6. COMPLETE at substep → COMPLETE regardless
 * 7. BREAK is non-accumulating — does not tally current iteration
 * 8. Iteration monotonicity (no RETRY)
 * 9. Termination with random event sequences (mixed patterns)
 * 10. parentPassAction COMPLETE produces COMPLETE in FOR loop
 * 11. PASS ALL + all fail → STOPPED
 * 12. PASS ANY + all fail → STOPPED
 * 13. parentFailAction COMPLETE produces COMPLETE on fail path
 * 14. Fully sequential FOR always terminates
 * 15. Fully sequential FOR all-pass yields COMPLETE
 */

import fc from 'fast-check';
import { createActor, type AnyStateMachine } from 'xstate';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import {
  buildForLoopSteps,
  runForLoop,
  type ForLoopConfig,
  type SubstepAction,
  type IterationAction,
  type ParentAction,
  type EventType,
} from './for-loop-test-helpers.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const substepActionArb = fc.constantFrom<SubstepAction>(
  'CONTINUE',
  'DEFER',
  'NEXT',
  'BREAK',
  'STOP',
  'COMPLETE',
);

const iterationActionArb = fc.constantFrom<IterationAction>(
  'CONTINUE',
  'DEFER',
  'NEXT',
  'BREAK',
  'STOP',
  'COMPLETE',
);

const parentActionArb = fc.constantFrom<ParentAction>('CONTINUE', 'STOP', 'COMPLETE');

const eventArb = fc.constantFrom<EventType>('PASS', 'FAIL');

/** Full config arbitrary — all dimensions free. */
const fullConfigArb: fc.Arbitrary<ForLoopConfig> = fc.record({
  iterations: fc.integer({ min: 1, max: 5 }),
  numSubsteps: fc.integer({ min: 1, max: 3 }),
  substepPassAction: substepActionArb,
  substepFailAction: substepActionArb,
  substepFailRetry: fc.integer({ min: 0, max: 2 }),
  iterationPassAction: iterationActionArb,
  iterationFailAction: iterationActionArb,
  iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
  iterationFailRetry: fc.integer({ min: 0, max: 2 }),
  parentPassAction: parentActionArb,
  parentFailAction: parentActionArb,
  parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
  parentFailRetry: fc.integer({ min: 0, max: 2 }),
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('FOR loop properties', () => {
  // Property 1: Termination — always reaches COMPLETE or STOPPED
  it('always terminates in COMPLETE or STOPPED', () => {
    fc.assert(
      fc.property(fullConfigArb, (config) => {
        // Generate enough events to drive any config to completion
        const maxEvents = config.iterations * config.numSubsteps * 3 + 20;
        const events = Array.from({ length: maxEvents }, () => 'PASS' as EventType);
        const result = runForLoop(config, events);
        expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
      }),
      { numRuns: 500 },
    );
  });

  // Property 2: forStack empty at terminal (when aggregation path is used)
  // Substep-level STOP/COMPLETE bypass the aggregation path and don't clear forStack.
  // This is by-design: the machine aborts immediately without cleanup.
  it('forStack is empty at terminal state', () => {
    const noBypassConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constantFrom('CONTINUE' as const, 'NEXT' as const, 'BREAK' as const),
      substepFailAction: fc.constantFrom('CONTINUE' as const, 'NEXT' as const, 'BREAK' as const),
      substepFailRetry: fc.integer({ min: 0, max: 2 }),
      iterationPassAction: fc.constantFrom('CONTINUE' as const, 'BREAK' as const),
      iterationFailAction: fc.constantFrom('CONTINUE' as const, 'BREAK' as const),
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      iterationFailRetry: fc.integer({ min: 0, max: 2 }),
      parentPassAction: fc.constantFrom('CONTINUE' as const, 'COMPLETE' as const),
      parentFailAction: fc.constantFrom('STOP' as const, 'COMPLETE' as const),
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      parentFailRetry: fc.integer({ min: 0, max: 2 }),
    });
    fc.assert(
      fc.property(noBypassConfig, (config) => {
        const maxEvents = config.iterations * config.numSubsteps * 3 + 20;
        const events = Array.from({ length: maxEvents }, () => 'PASS' as EventType);
        const result = runForLoop(config, events);
        expect(result.forStackLength).toBe(0);
      }),
      { numRuns: 500 },
    );
  });

  // Property 3: PASS ALL + all pass → parent passes (CONTINUE → COMPLETE)
  it('PASS ALL with all passes yields COMPLETE when parent CONTINUE', () => {
    const constrainedConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('CONTINUE'),
      iterationFailAction: fc.constant<IterationAction>('CONTINUE'),
      iterationAggMode: fc.constant('ALL' as const), // ALL
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant('ALL' as const), // ALL
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(constrainedConfig, (config) => {
        // All PASS events
        const total = config.iterations * config.numSubsteps;
        const events = Array.from({ length: total + 10 }, () => 'PASS' as EventType);
        const result = runForLoop(config, events);
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 4: PASS ANY + at least one pass → parent passes
  // Iteration-level DEFER accumulates results; CONTINUE would not accumulate.
  it('PASS ANY with at least one pass yields COMPLETE when parent CONTINUE', () => {
    const constrainedConfig = fc.record({
      iterations: fc.integer({ min: 2, max: 5 }),
      numSubsteps: fc.constant(1),
      substepPassAction: fc.constant<SubstepAction>('DEFER'),
      substepFailAction: fc.constant<SubstepAction>('DEFER'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constant('ALL' as const), // ALL — iteration aggregation passes each iter individually
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant('ANY' as const), // ANY
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(constrainedConfig, (config) => {
        // First iteration passes, rest fail
        const events: EventType[] = ['PASS'];
        for (let i = 1; i < config.iterations; i++) events.push('FAIL');
        // Pad with PASS for step 2
        for (let i = 0; i < 10; i++) events.push('PASS');
        const result = runForLoop(config, events);
        // PASS ANY: at least one pass → parent passes → CONTINUE → step 2 → COMPLETE
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 5: STOP at substep → STOPPED regardless of other config
  it('STOP at substep level always produces STOPPED', () => {
    const stopConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('STOP'),
      substepFailAction: fc.constant<SubstepAction>('STOP'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: iterationActionArb,
      iterationFailAction: iterationActionArb,
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      iterationFailRetry: fc.constant(0),
      parentPassAction: parentActionArb,
      parentFailAction: parentActionArb,
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(stopConfig, eventArb, (config, firstEvent) => {
        const result = runForLoop(config, [firstEvent]);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 6: COMPLETE at substep → COMPLETE regardless of other config
  it('COMPLETE at substep level always produces COMPLETE', () => {
    const completeConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('COMPLETE'),
      substepFailAction: fc.constant<SubstepAction>('COMPLETE'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: iterationActionArb,
      iterationFailAction: iterationActionArb,
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      iterationFailRetry: fc.constant(0),
      parentPassAction: parentActionArb,
      parentFailAction: parentActionArb,
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const, undefined),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(completeConfig, eventArb, (config, firstEvent) => {
        const result = runForLoop(config, [firstEvent]);
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 7: BREAK is non-accumulating — does not tally current iteration
  it('BREAK does not accumulate current iteration but prior DEFER iterations remain', () => {
    const breakConfig = fc.record({
      iterations: fc.integer({ min: 2, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailAction: fc.constant<SubstepAction>('BREAK'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: parentActionArb,
      parentFailAction: parentActionArb,
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(breakConfig, (config) => {
        // First iteration: all substeps pass → DEFER accumulates
        // Second iteration: first substep fails → BREAK
        const events: EventType[] = [];
        // Iteration 1: pass all substeps
        for (let i = 0; i < config.numSubsteps; i++) events.push('PASS');
        // Iteration 2: first substep fails → BREAK
        events.push('FAIL');
        // Pad
        for (let i = 0; i < 20; i++) events.push('PASS');

        const result = runForLoop(config, events);
        // After BREAK: iteration 1 (DEFER'd) is in iterationResults.
        // Iteration 2 (BREAK'd) is NOT accumulated — non-accumulating like NEXT.
        // So iterationResults has exactly 1 entry (from iteration 1's DEFER).
        expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
        expect(result.iterationResults.length).toBe(1);
      }),
      { numRuns: 200 },
    );
  });

  // Property 8: Iteration monotonicity (no retry configs) — iterations advance
  it('iterations advance monotonically without retry', () => {
    const noRetryConfig = fc.record({
      iterations: fc.integer({ min: 2, max: 4 }),
      numSubsteps: fc.constant(1),
      substepPassAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('CONTINUE'),
      iterationFailAction: fc.constant<IterationAction>('CONTINUE'),
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('CONTINUE'),
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(noRetryConfig, (config) => {
        const steps = buildForLoopSteps(config);
        const machine = compileRunbookToMachine(steps);
        const actor = createActor(machine as AnyStateMachine);
        actor.start();

        const iterations: number[] = [];
        const top = actor.getSnapshot().context.forStack[0];
        if (top) iterations.push(top.iteration);

        for (let i = 0; i < config.iterations; i++) {
          actor.send({ type: 'PASS' });
          const snap = actor.getSnapshot();
          if (snap.status === 'done') break;
          const currentTop = snap.context.forStack[snap.context.forStack.length - 1];
          if (currentTop) iterations.push(currentTop.iteration);
        }

        // Verify monotonicity
        for (let i = 1; i < iterations.length; i++) {
          expect(iterations[i]).toBeGreaterThanOrEqual(iterations[i - 1]);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Property 9: Termination with random event sequences (mixed patterns)
  // runForLoop already pads with up to 200 PASS events after the supplied
  // sequence, so no extra padding is needed here — the test verifies that
  // any random event sequence terminates.
  it('always terminates with random event sequences', () => {
    fc.assert(
      fc.property(
        fullConfigArb,
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        (config, events) => {
          const result = runForLoop(config, events);
          expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
        },
      ),
      { numRuns: 500 },
    );
  });

  // Property 10: parentPassAction COMPLETE produces COMPLETE in FOR loop
  // Requires both parentAggMode and iterationAggMode to be defined — without aggregation,
  // iterationResults stays empty and unconditional/vacuous paths fire instead.
  it('parentPassAction COMPLETE produces COMPLETE in FOR loop', () => {
    const completeParentConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('DEFER'),
      substepFailAction: fc.constant<SubstepAction>('DEFER'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('COMPLETE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(completeParentConfig, (cfg) => {
        const events = Array.from(
          { length: cfg.iterations * cfg.numSubsteps + 10 },
          () => 'PASS' as EventType,
        );
        const result = runForLoop(cfg, events);
        // All pass → parent passes → COMPLETE (not CONTINUE → step 2 → COMPLETE)
        expect(result.terminalState).toBe('COMPLETE');
        // Verify COMPLETE came directly from the FOR loop, not from advancing
        // to step 2. The FOR loop consumes exactly iterations * numSubsteps
        // events; if it continued to step 2, eventsConsumed would be higher.
        const forLoopEvents = cfg.iterations * cfg.numSubsteps;
        expect(result.eventsConsumed).toBe(forLoopEvents);
      }),
      { numRuns: 200 },
    );
  });

  // Property 11: PASS ALL + all fail → STOPPED
  // Converse of Property 3. Without this, a bug where ALL aggregation always
  // returns pass goes undetected.
  it('PASS ALL with all fails yields STOPPED when parentFailAction STOP', () => {
    const allFailConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('DEFER'),
      substepFailAction: fc.constant<SubstepAction>('DEFER'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constant('ALL' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant('ALL' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(allFailConfig, (config) => {
        const total = config.iterations * config.numSubsteps;
        const events = Array.from({ length: total + 10 }, () => 'FAIL' as EventType);
        const result = runForLoop(config, events);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 12: PASS ANY + all fail → STOPPED
  // Converse of Property 4. Ensures ANY aggregation correctly fails when
  // no iteration passes.
  it('PASS ANY with all fails yields STOPPED when parentFailAction STOP', () => {
    const anyFailConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('DEFER'),
      substepFailAction: fc.constant<SubstepAction>('DEFER'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constant('ALL' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant('ANY' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(anyFailConfig, (config) => {
        const total = config.iterations * config.numSubsteps;
        const events = Array.from({ length: total + 10 }, () => 'FAIL' as EventType);
        const result = runForLoop(config, events);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 13: parentFailAction COMPLETE produces COMPLETE on fail path
  // Mirrors Property 10 (which tests parentPassAction COMPLETE on pass path).
  it('parentFailAction COMPLETE produces COMPLETE on fail path', () => {
    const failCompleteConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('DEFER'),
      substepFailAction: fc.constant<SubstepAction>('DEFER'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('DEFER'),
      iterationFailAction: fc.constant<IterationAction>('DEFER'),
      iterationAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('COMPLETE'),
      parentAggMode: fc.constantFrom('ALL' as const, 'ANY' as const),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(failCompleteConfig, (cfg) => {
        const total = cfg.iterations * cfg.numSubsteps;
        const events = Array.from({ length: total + 10 }, () => 'FAIL' as EventType);
        const result = runForLoop(cfg, events);
        // All fail → parent fails → COMPLETE (not STOP)
        expect(result.terminalState).toBe('COMPLETE');
        // Verify COMPLETE came directly from the FOR loop, not from advancing
        // to step 2. The FOR loop consumes exactly iterations * numSubsteps
        // events; if it continued to step 2, eventsConsumed would be higher.
        const forLoopEvents = cfg.iterations * cfg.numSubsteps;
        expect(result.eventsConsumed).toBe(forLoopEvents);
      }),
      { numRuns: 200 },
    );
  });

  // Property 14: Fully sequential FOR always terminates
  // Config: both agg modes undefined (no iteration or parent aggregation),
  // substepPassAction: CONTINUE, substepFailAction: random (CONTINUE/STOP/BREAK/NEXT).
  it('fully sequential FOR always terminates', () => {
    const seqConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailAction: fc.constantFrom<SubstepAction>('CONTINUE', 'STOP', 'BREAK', 'NEXT'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('CONTINUE'),
      iterationFailAction: fc.constant<IterationAction>('CONTINUE'),
      iterationAggMode: fc.constant(undefined),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant(undefined),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(
        seqConfig,
        fc.array(eventArb, { minLength: 1, maxLength: 30 }),
        (config, events) => {
          const result = runForLoop(config, events);
          // Always terminates
          expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
          // No accumulation in sequential mode
          expect(result.iterationResults).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Property 15: Fully sequential FOR all-pass yields COMPLETE
  // All events PASS, all actions CONTINUE — loops exactly right number of times.
  it('fully sequential FOR all-pass yields COMPLETE', () => {
    const seqPassConfig = fc.record({
      iterations: fc.integer({ min: 1, max: 5 }),
      numSubsteps: fc.integer({ min: 1, max: 3 }),
      substepPassAction: fc.constant<SubstepAction>('CONTINUE'),
      substepFailAction: fc.constant<SubstepAction>('STOP'),
      substepFailRetry: fc.constant(0),
      iterationPassAction: fc.constant<IterationAction>('CONTINUE'),
      iterationFailAction: fc.constant<IterationAction>('CONTINUE'),
      iterationAggMode: fc.constant(undefined),
      iterationFailRetry: fc.constant(0),
      parentPassAction: fc.constant<ParentAction>('CONTINUE'),
      parentFailAction: fc.constant<ParentAction>('STOP'),
      parentAggMode: fc.constant(undefined),
      parentFailRetry: fc.constant(0),
    });

    fc.assert(
      fc.property(seqPassConfig, (cfg) => {
        const total = cfg.iterations * cfg.numSubsteps;
        const events = Array.from({ length: total + 10 }, () => 'PASS' as EventType);
        const result = runForLoop(cfg, events);
        // All pass → COMPLETE (via step 2 terminal)
        expect(result.terminalState).toBe('COMPLETE');
        // FOR loop consumes iterations * numSubsteps events, then step 2 consumes 1
        expect(result.eventsConsumed).toBe(total + 1);
        // No accumulation
        expect(result.iterationResults).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
