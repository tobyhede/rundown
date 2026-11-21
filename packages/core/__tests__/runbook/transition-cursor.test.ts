// Contract coverage for the `--step` / `--index` transition cursor (#901,
// handbook decision 2). NO core mocks: fixtures are seeded from the real
// `buildFrameKey` serialization and real `ResolvedStep` shapes, so the
// assertions pin the persisted-state contract rather than a synthetic mock.
//
// One case per rule, accept and refuse, so a rule that drifts fails exactly
// one named test.

import { describe, expect, it } from '@jest/globals';
import type { ForClause, ResolvedStep, Substep, Transitions } from '@rundown-org/parser';
import {
  resolveTransitionCursor,
  type TransitionCursor,
  type TransitionCursorResolution,
} from '../../src/runbook/transition-cursor.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/persisted-state-guards.js';
import type { ForContext, RunbookState } from '../../src/runbook/types.js';
import {
  brandRunIdForTest,
  brandStoredOutputsForTest,
  brandInitialTemplateVarsForTest,
} from '../../src/testing/effective-vars.js';

const tx: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

const substeps: readonly Substep[] = [
  { id: '1', description: 'A', transitions: tx },
  { id: '2', description: 'B', transitions: tx },
];

const baseSteps: readonly ResolvedStep[] = [
  { kind: 'base', name: '1', description: 'one', transitions: tx },
  { kind: 'base', name: '2', description: 'two', transitions: tx },
];

const substepSteps: readonly ResolvedStep[] = [
  { kind: 'base', name: '1', description: 'one', transitions: tx },
  {
    kind: 'substeps',
    name: '2',
    description: 'Substeps',
    aggregation: { strategy: 'ALL' },
    substeps,
    transitions: tx,
  },
];

function forSteps(forClause: ForClause): readonly ResolvedStep[] {
  return [
    {
      kind: 'for',
      name: '1',
      description: 'FOR step',
      forClause,
      substeps,
      transitions: tx,
    },
  ];
}

const promptedForSteps: readonly ResolvedStep[] = [
  {
    kind: 'prompted-for',
    name: '1',
    description: 'PROMPTED-FOR step',
    substeps,
    transitions: tx,
  },
];

function liveIteration(stepId: string, iteration: number): ForContext {
  return {
    stepId,
    iteration,
    start: 1,
    end: 5,
    variable: 'i',
    implicit: false,
    source: { kind: 'range' },
  };
}

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    prompted: false,
    templateVars: brandInitialTemplateVarsForTest({}),
    id: brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc'),
    runbook: { source: 'project', path: 'cursor-test.md' },
    runbookPath: 'cursor-test.md',
    step: '1',
    stepName: 'one',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    frontmatterOutputs: [],
    ...overrides,
  };
}

/** A run parked at substep 2.1. */
function atSubstep(substep = '1'): RunbookState {
  return makeState({
    step: '2',
    stepName: 'Substeps',
    substep,
    frameEntryCounts: { [buildFrameKey('2')]: 1 },
    activeFrameKey: buildFrameKey('2'),
  });
}

/** A run parked at substep 1.<substep> of FOR iteration 3. */
function atForIteration(substep = '1', iteration = 3): RunbookState {
  return makeState({
    step: '1',
    stepName: 'FOR step',
    substep,
    forStack: [liveIteration('1', iteration)],
    frameEntryCounts: { [buildFrameKey('1', iteration)]: 2 },
    activeFrameKey: buildFrameKey('1', iteration),
    activeEntry: 2,
  });
}

// Narrow a resolution to its cursor, failing the test on a refusal.
function resolveCursor(...args: Parameters<typeof resolveTransitionCursor>): TransitionCursor {
  const resolution = resolveTransitionCursor(...args);
  if (resolution.kind !== 'resolved') {
    throw new Error(`expected a resolved cursor, got refusal: ${resolution.message}`);
  }
  return resolution.cursor;
}

// Narrow a resolution to its refusal message, failing the test on a cursor.
function refusalMessage(resolution: TransitionCursorResolution): string {
  if (resolution.kind !== 'invalid_step_target') {
    throw new Error(
      `expected an invalid_step_target refusal, got cursor at ${resolution.cursor.at}`,
    );
  }
  return resolution.message;
}

describe('resolveTransitionCursor', () => {
  it('pins the real frame-key serialization the fixtures are seeded from', () => {
    expect(buildFrameKey('1')).toBe('1|');
    expect(buildFrameKey('1', 3)).toBe('1|3');
  });

  describe('--step is required', () => {
    it('refuses a missing --step, naming the current top-level position', () => {
      expect(refusalMessage(resolveTransitionCursor(baseSteps, makeState(), undefined))).toBe(
        '--step is required; the current position is 1',
      );
    });

    it('refuses a missing --step, naming the current substep position', () => {
      expect(refusalMessage(resolveTransitionCursor(substepSteps, atSubstep(), undefined))).toBe(
        '--step is required; the current position is 2.1',
      );
    });

    it('refuses a missing --step, naming the current FOR iteration position', () => {
      expect(
        refusalMessage(
          resolveTransitionCursor(
            forSteps({ variable: 'i', start: 1, end: 5 }),
            atForIteration(),
            undefined,
          ),
        ),
      ).toBe('--step is required; the current position is 1.3.1');
    });
  });

  describe('syntax', () => {
    it('refuses an unparseable step target', () => {
      expect(
        refusalMessage(resolveTransitionCursor(baseSteps, makeState(), { stepId: 'invalid!!!' })),
      ).toBe('Invalid step target: invalid!!!');
    });

    it('refuses a template AT expression', () => {
      expect(
        refusalMessage(
          resolveTransitionCursor(forSteps({ variable: 'i', start: 1, end: 5 }), atForIteration(), {
            stepId: '1.1 AT {{Index}}',
          }),
        ),
      ).toContain('template AT expression');
    });
  });

  describe('--step must name the active step', () => {
    it('accepts the active top-level step', () => {
      expect(resolveCursor(baseSteps, makeState(), { stepId: '1' })).toStrictEqual({
        step: '1',
        frame: { kind: 'active', frameKey: buildFrameKey('1'), entry: 1 },
        at: '1',
      });
    });

    it('refuses another step, naming the active step', () => {
      expect(refusalMessage(resolveTransitionCursor(baseSteps, makeState(), { stepId: '2' }))).toBe(
        '--step 2 targets step "2" but the active step is "1"',
      );
    });

    it('refuses another step even when it names a substep that would exist there', () => {
      expect(
        refusalMessage(resolveTransitionCursor(substepSteps, makeState(), { stepId: '2.1' })),
      ).toBe('--step 2.1 targets step "2" but the active step is "1"');
    });
  });

  describe('substep rules', () => {
    it('accepts --step naming the current substep', () => {
      expect(resolveCursor(substepSteps, atSubstep('2'), { stepId: '2.2' })).toStrictEqual({
        step: '2',
        substep: '2',
        frame: { kind: 'active', frameKey: buildFrameKey('2'), entry: 1 },
        at: '2.2',
      });
    });

    it('refuses --step naming a sibling substep, naming the current position', () => {
      expect(
        refusalMessage(resolveTransitionCursor(substepSteps, atSubstep('1'), { stepId: '2.2' })),
      ).toBe('--step 2.2 names substep "2" but the current position is 2.1');
    });

    it('refuses --step naming a substep that does not exist, naming the current position', () => {
      expect(
        refusalMessage(resolveTransitionCursor(substepSteps, atSubstep('1'), { stepId: '2.99' })),
      ).toBe('--step 2.99 names substep "99" but the current position is 2.1');
    });

    it('refuses a bare --step while a substep is active, naming the current substep', () => {
      expect(
        refusalMessage(resolveTransitionCursor(substepSteps, atSubstep('1'), { stepId: '2' })),
      ).toBe('--step 2 must name the current substep; the current position is 2.1');
    });

    it('accepts a bare --step when no substep is active (#763 reversal)', () => {
      const cursor = resolveCursor(baseSteps, makeState(), { stepId: '1' });
      expect(cursor.substep).toBeUndefined();
      expect(cursor.at).toBe('1');
    });

    it('refuses --step naming a substep when no substep is active', () => {
      expect(
        refusalMessage(resolveTransitionCursor(baseSteps, makeState(), { stepId: '1.1' })),
      ).toBe('--step 1.1 names substep "1" but step "1" has no active substep');
    });
  });

  describe('--index rules', () => {
    const steps = forSteps({ variable: 'i', start: 1, end: 5 });

    it('accepts --index naming the active FOR iteration and carries the live frame entry', () => {
      expect(
        resolveCursor(steps, atForIteration('1', 3), { stepId: '1.1', iteration: 3 }),
      ).toStrictEqual({
        step: '1',
        substep: '1',
        iteration: 3,
        frame: { kind: 'active', frameKey: buildFrameKey('1', 3), entry: 2 },
        at: '1.3.1',
      });
    });

    it('accepts the iteration in the AT slot of a three-level --step', () => {
      const cursor = resolveCursor(steps, atForIteration('1', 3), { stepId: '1.3.1' });
      expect(cursor.iteration).toBe(3);
      expect(cursor.at).toBe('1.3.1');
    });

    it('accepts --index on a prompted-for step at its live iteration', () => {
      const cursor = resolveCursor(promptedForSteps, atForIteration('1', 4), {
        stepId: '1.1',
        iteration: 4,
      });
      expect(cursor.iteration).toBe(4);
      expect(cursor.frame).toEqual({ kind: 'active', frameKey: buildFrameKey('1', 4), entry: 2 });
    });

    it('refuses a missing --index inside a FOR iteration, naming the current iteration', () => {
      expect(
        refusalMessage(resolveTransitionCursor(steps, atForIteration('1', 3), { stepId: '1.1' })),
      ).toBe('--index is required inside FOR step "1" (current iteration 3)');
    });

    it('refuses --index naming another iteration, naming the current iteration', () => {
      expect(
        refusalMessage(
          resolveTransitionCursor(steps, atForIteration('1', 3), { stepId: '1.1', iteration: 2 }),
        ),
      ).toBe('--index 2 names iteration 2 of FOR step "1" but the current iteration is 3');
    });

    it('refuses --index on a step that is not a FOR step', () => {
      expect(
        refusalMessage(
          resolveTransitionCursor(baseSteps, makeState(), { stepId: '1', iteration: 1 }),
        ),
      ).toBe('--index requires step "1" to be a FOR or PROMPTED-FOR step, but it is "base"');
    });

    it('refuses --index on a FOR step whose iteration has not opened', () => {
      // A FOR step with no live loop context has no active iteration for
      // `--index` to name; the refusal is distinct from the non-FOR kind so the
      // operator learns which of the two facts is missing.
      expect(
        refusalMessage(
          resolveTransitionCursor(steps, makeState({ stepName: 'FOR step' }), {
            stepId: '1',
            iteration: 1,
          }),
        ),
      ).toBe('--index 1 was given but step "1" is not at a FOR iteration');
    });
  });

  it('throws when the active step is absent from the definition (invariant, not caller input)', () => {
    expect(() =>
      resolveTransitionCursor(baseSteps, makeState({ step: '7' }), { stepId: '7' }),
    ).toThrow('Step "7" not found');
  });
});
