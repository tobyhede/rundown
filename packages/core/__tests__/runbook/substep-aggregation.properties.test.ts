/**
 * Property tests for non-FOR substep aggregation with DEFER semantics.
 *
 * Tests DEFER routing, deferredResults accumulation, and ALL/ANY aggregation.
 * Six properties at 200 runs each (1,200 total).
 */

import fc from 'fast-check';
import {
  inferSteps,
  makeTransitions,
  runMachine,
  DEFER_TRANSITIONS,
  DEFAULT_TRANSITIONS,
  type StepInput,
} from './compiler-property-helpers.js';
import type { Substep } from '../../src/runbook/types.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildAggregationSteps(opts: {
  numSubsteps: number;
  aggregationMode: 'ALL' | 'ANY';
  substepActions: ('DEFER' | 'CONTINUE')[];
  parentPassAction: string;
  parentFailAction: string;
  parentFailRetry?: number;
}): StepInput[] {
  const substeps: Substep[] = Array.from({ length: opts.numSubsteps }, (_, i) => ({
    id: String(i + 1),
    description: `Substep ${String(i + 1)}`,
    transitions: opts.substepActions[i] === 'DEFER' ? DEFER_TRANSITIONS : DEFAULT_TRANSITIONS,
  }));

  return [
    {
      name: '1',
      description: 'Aggregation step',
      transitions: makeTransitions(
        opts.aggregationMode,
        opts.parentPassAction,
        opts.parentFailAction,
        opts.parentFailRetry ?? 0,
      ),
      substeps,
    },
    {
      name: '2',
      description: 'Terminal step',
      transitions: makeTransitions('ALL', 'COMPLETE', 'STOP'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Substep aggregation properties', () => {
  // Property 1: ALL-pass with all PASS + DEFER
  it('ALL aggregation with all PASS+DEFER substeps fires parent PASS path', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (numSubsteps) => {
        const steps = inferSteps(
          buildAggregationSteps({
            numSubsteps,
            aggregationMode: 'ALL',
            substepActions: Array.from({ length: numSubsteps }, () => 'DEFER' as const),
            parentPassAction: 'CONTINUE',
            parentFailAction: 'STOP',
          }),
        );
        const events = Array.from({ length: numSubsteps + 5 }, () => 'PASS' as const);
        const result = runMachine(steps, events);
        expect(result.terminalState).toBe('COMPLETE');
      }),
      { numRuns: 200 },
    );
  });

  // Property 2: ALL-fail with any FAIL + DEFER
  it('ALL aggregation with any FAIL+DEFER substep fires parent FAIL path', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (numSubsteps, failIdx) => {
          const adjustedFailIdx = failIdx % numSubsteps;
          const steps = inferSteps(
            buildAggregationSteps({
              numSubsteps,
              aggregationMode: 'ALL',
              substepActions: Array.from({ length: numSubsteps }, () => 'DEFER' as const),
              parentPassAction: 'CONTINUE',
              parentFailAction: 'STOP',
            }),
          );
          // Send PASS for all substeps except failIdx which gets FAIL
          const events: ('PASS' | 'FAIL')[] = Array.from({ length: numSubsteps }, (_, i) =>
            i === adjustedFailIdx ? 'FAIL' : 'PASS',
          );
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('STOPPED');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 3: ANY-pass with at least one PASS + DEFER
  it('ANY aggregation with at least one PASS+DEFER substep fires parent PASS path', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        (numSubsteps, passIdx) => {
          const adjustedPassIdx = passIdx % numSubsteps;
          const steps = inferSteps(
            buildAggregationSteps({
              numSubsteps,
              aggregationMode: 'ANY',
              substepActions: Array.from({ length: numSubsteps }, () => 'DEFER' as const),
              parentPassAction: 'CONTINUE',
              parentFailAction: 'STOP',
            }),
          );
          // All FAIL except one PASS
          const events: ('PASS' | 'FAIL')[] = Array.from({ length: numSubsteps }, (_, i) =>
            i === adjustedPassIdx ? 'PASS' : 'FAIL',
          );
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('COMPLETE');
        },
      ),
      { numRuns: 200 },
    );
  });

  // Property 4: ANY-fail with all FAIL + DEFER
  it('ANY aggregation with all FAIL+DEFER substeps fires parent FAIL path', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (numSubsteps) => {
        const steps = inferSteps(
          buildAggregationSteps({
            numSubsteps,
            aggregationMode: 'ANY',
            substepActions: Array.from({ length: numSubsteps }, () => 'DEFER' as const),
            parentPassAction: 'CONTINUE',
            parentFailAction: 'STOP',
          }),
        );
        const events = Array.from({ length: numSubsteps }, () => 'FAIL' as const);
        const result = runMachine(steps, events);
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 5: CONTINUE substeps don't feed deferredResults
  it('only DEFER substeps contribute to deferredResults count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 4 }), (numSubsteps) => {
        // First substep is DEFER, rest are CONTINUE
        const substepActions = Array.from({ length: numSubsteps }, (_, i) =>
          i === 0 ? ('DEFER' as const) : ('CONTINUE' as const),
        );
        const steps = inferSteps(
          buildAggregationSteps({
            numSubsteps,
            aggregationMode: 'ANY',
            substepActions,
            parentPassAction: 'CONTINUE',
            parentFailAction: 'STOP',
          }),
        );
        // FAIL the DEFER substep (index 0), PASS all CONTINUE substeps
        const events: ('PASS' | 'FAIL')[] = [
          'FAIL',
          ...Array.from({ length: numSubsteps - 1 }, () => 'PASS' as const),
        ];
        const result = runMachine(steps, events);
        // ANY aggregation: if CONTINUE substeps leaked into deferredResults,
        // their PASS results would satisfy ANY and fire parent PASS → COMPLETE.
        // Only DEFER substep's FAIL should be in deferredResults → parent FAIL → STOPPED.
        expect(result.terminalState).toBe('STOPPED');
      }),
      { numRuns: 200 },
    );
  });

  // Property 6: Aggregated flag on parent exit
  it('parent aggregation sets aggregated flag on lastAction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom('ALL' as const, 'ANY' as const),
        (numSubsteps, mode) => {
          const steps = inferSteps(
            buildAggregationSteps({
              numSubsteps,
              aggregationMode: mode,
              substepActions: Array.from({ length: numSubsteps }, () => 'DEFER' as const),
              parentPassAction: 'COMPLETE',
              parentFailAction: 'STOP',
            }),
          );
          const events = Array.from({ length: numSubsteps }, () => 'PASS' as const);
          const result = runMachine(steps, events);
          expect(result.terminalState).toBe('COMPLETE');
          // Parent aggregation fired → aggregated flag must be set
          expect(result.lastAction?.aggregated).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});
