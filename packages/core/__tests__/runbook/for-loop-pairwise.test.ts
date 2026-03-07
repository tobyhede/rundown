/**
 * covertable pairwise regression tests for FOR loop compilation.
 *
 * Generates a covering array at strength 2 (pairwise) from 13 factors,
 * producing ~60-80 deterministic test cases. Each case:
 * 1. Builds a ForLoopConfig from the pairwise row
 * 2. Generates events from the event pattern
 * 3. Compiles the machine and runs it
 * 4. Asserts terminal state matches oracle prediction
 */

import covertable from 'covertable';
const make = (
  covertable as unknown as {
    make: (f: Record<string, unknown[]>, o?: { length?: number }) => unknown[];
  }
).make;
import {
  runForLoop,
  generateEvents,
  predictOutcome,
  type ForLoopConfig,
  type SubstepAction,
  type IterationAction,
  type ParentAction,
  type EventPattern,
} from './for-loop-test-helpers.js';

// ---------------------------------------------------------------------------
// Factor definitions for pairwise generation
// ---------------------------------------------------------------------------

const factors: Record<string, unknown[]> = {
  iterations: [1, 2, 3],
  numSubsteps: [1, 2],
  substepPassAction: ['CONTINUE', 'NEXT'],
  substepFailAction: ['CONTINUE', 'BREAK', 'STOP'],
  substepFailRetry: [0, 1],
  iterationAggMode: ['ALL', 'ANY', 'none'],
  iterationFailAction: ['DEFER', 'BREAK'],
  iterationFailRetry: [0, 1],
  parentAggMode: ['ALL', 'ANY', 'none'],
  parentPassAction: ['CONTINUE', 'COMPLETE'],
  parentFailAction: ['STOP', 'COMPLETE'],
  parentFailRetry: [0, 1],
  eventPattern: ['all-pass', 'all-fail', 'first-fail', 'last-fail', 'alternate'],
};

interface PairwiseRow {
  iterations: number;
  numSubsteps: number;
  substepPassAction: string;
  substepFailAction: string;
  substepFailRetry: number;
  iterationAggMode: 'ALL' | 'ANY' | 'none';
  iterationFailAction: string;
  iterationFailRetry: number;
  parentAggMode: 'ALL' | 'ANY' | 'none';
  parentPassAction: string;
  parentFailAction: string;
  parentFailRetry: number;
  eventPattern: string;
}

// ---------------------------------------------------------------------------
// Generate covering array
// ---------------------------------------------------------------------------

const pairwiseRows = make(factors, { length: 2 }) as unknown as PairwiseRow[];

// ---------------------------------------------------------------------------
// Convert pairwise row to ForLoopConfig
// ---------------------------------------------------------------------------

function rowToConfig(row: PairwiseRow): ForLoopConfig {
  return {
    iterations: row.iterations,
    numSubsteps: row.numSubsteps,
    substepPassAction: row.substepPassAction as SubstepAction,
    substepFailAction: row.substepFailAction as SubstepAction,
    substepFailRetry: row.substepFailRetry,
    // Iteration pass action defaults to DEFER (loops back with accumulation)
    iterationPassAction: 'DEFER' as IterationAction,
    iterationFailAction: row.iterationFailAction as IterationAction,
    iterationAggMode: row.iterationAggMode,
    iterationFailRetry: row.iterationFailRetry,
    parentPassAction: row.parentPassAction as ParentAction,
    parentFailAction: row.parentFailAction as ParentAction,
    parentAggMode: row.parentAggMode,
    parentFailRetry: row.parentFailRetry,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FOR loop pairwise regression', () => {
  it(`generates ${String(pairwiseRows.length)} pairwise test cases (sanity check)`, () => {
    // Pairwise at strength 2 with 13 factors should produce a reasonable number of cases
    expect(pairwiseRows.length).toBeGreaterThan(10);
    expect(pairwiseRows.length).toBeLessThan(200);
  });

  describe.each(pairwiseRows.map((row, i) => [i, row] as const))('case %i', (_index, row) => {
    it(`terminates in COMPLETE or STOPPED`, () => {
      const config = rowToConfig(row);
      const pattern = row.eventPattern as EventPattern;
      const events = generateEvents(config, pattern);
      const result = runForLoop(config, events);
      expect(result.terminalState).toMatch(/^(COMPLETE|STOPPED)$/);
    });

    it(`forStack is empty at terminal (unless substep-level STOP/COMPLETE)`, () => {
      const config = rowToConfig(row);
      const pattern = row.eventPattern as EventPattern;
      const events = generateEvents(config, pattern);
      const result = runForLoop(config, events);
      // Substep-level STOP/COMPLETE bypass the aggregation path and don't clear forStack.
      // This is by-design: the machine aborts immediately without cleanup.
      const substepMayBypassAggregation =
        config.substepPassAction === 'STOP' ||
        config.substepPassAction === 'COMPLETE' ||
        config.substepFailAction === 'STOP' ||
        config.substepFailAction === 'COMPLETE';
      if (!substepMayBypassAggregation) {
        expect(result.forStackLength).toBe(0);
      }
    });

    it(`oracle matches machine`, () => {
      const config = rowToConfig(row);
      const pattern = row.eventPattern as EventPattern;
      const events = generateEvents(config, pattern);

      const machineResult = runForLoop(config, events);
      const oracleResult = predictOutcome(config, events);

      expect(machineResult.terminalState).toBe(oracleResult);
    });
  });
});
