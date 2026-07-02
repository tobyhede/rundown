// Real-contract coverage for the explicit --step / --index cursor resolver
// (#499 replacement suite): NO core mocks. Fixtures are seeded from the real
// buildFrameKey serialization (`step|iteration`: '1|', '1|3') and real
// ResolvedStep shapes, so the active-vs-inactive frame assertions pin the
// persisted-state contract instead of a synthetic mock that drifts with the
// fixtures. Supersedes packages/cli/__tests__/helpers/transitions-explicit-target.test.ts
// (deleted when the CLI copy of the resolver is deleted).

import { describe, expect, it } from '@jest/globals';
import type { ForClause, ResolvedStep, Substep, Transitions } from '@rundown-org/parser';
import {
  buildFrameKey,
  resolveManualCompletionCursor,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandRunIdForTest, brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const tx: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

const substeps: readonly Substep[] = [
  { id: '1', description: 'A', transitions: tx },
  { id: '2', description: 'B', transitions: tx },
];

const substepSteps: readonly ResolvedStep[] = [
  {
    kind: 'substeps',
    name: '1',
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

function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc'),
    runbook: { source: 'project', path: 'cursor-test.md' },
    runbookPath: 'cursor-test.md',
    step: '1',
    stepName: 'Substeps',
    substep: '1',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    activeFrameKey: buildFrameKey('1'), // real contract: '1|'
    activeEntry: 1,
    startedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

describe('resolveManualCompletionCursor', () => {
  it('pins the real frame-key serialization the fixtures are seeded from', () => {
    expect(buildFrameKey('1')).toBe('1|');
    expect(buildFrameKey('1', 3)).toBe('1|3');
  });

  it('builds an active-frame cursor from the explicit --step target', () => {
    const cursor = resolveManualCompletionCursor(substepSteps, makeState(), { stepId: '1.1' });
    expect(cursor).toEqual({
      step: '1',
      substep: '1',
      frame: { kind: 'active', frameKey: buildFrameKey('1'), entry: 1 },
      at: '1.1',
    });
  });

  it('targets the explicit substep, not the active-state substep', () => {
    const cursor = resolveManualCompletionCursor(substepSteps, makeState({ substep: '1' }), {
      stepId: '1.2',
    });
    expect(cursor.substep).toBe('2');
  });

  it('carries the live active entry on an active-frame target', () => {
    const cursor = resolveManualCompletionCursor(
      substepSteps,
      makeState({ activeEntry: 2, frameEntryCounts: { [buildFrameKey('1')]: 2 } }),
      { stepId: '1.2' },
    );
    expect(cursor.frame).toEqual({ kind: 'active', frameKey: buildFrameKey('1'), entry: 2 });
  });

  it('builds an inactive (sentinel) frame when --index targets a non-active FOR iteration', () => {
    const cursor = resolveManualCompletionCursor(
      forSteps({ variable: 'i', start: 1, end: 5 }),
      makeState({
        activeFrameKey: buildFrameKey('1', 1),
        frameEntryCounts: { [buildFrameKey('1', 1)]: 1 },
      }),
      { stepId: '1.1', iteration: 3 },
    );
    expect(cursor.iteration).toBe(3);
    expect(cursor.frame).toEqual({ kind: 'inactive', frameKey: buildFrameKey('1', 3) });
  });

  it('builds an active frame when --index targets the live FOR iteration', () => {
    const cursor = resolveManualCompletionCursor(
      forSteps({ variable: 'i', start: 1, end: 5 }),
      makeState({
        activeFrameKey: buildFrameKey('1', 3),
        activeEntry: 2,
        frameEntryCounts: { [buildFrameKey('1', 3)]: 2 },
      }),
      { stepId: '1.1', iteration: 3 },
    );
    expect(cursor.frame).toEqual({ kind: 'active', frameKey: buildFrameKey('1', 3), entry: 2 });
  });

  it('defaults to the live FOR iteration (from forStack) without an explicit iteration', () => {
    // deriveActiveFrame reads the top of state.forStack; seed a live iteration-3
    // context so the default resolves to the real active frame key '1|3'.
    const cursor = resolveManualCompletionCursor(
      forSteps({ variable: 'i', start: 1, end: 5 }),
      makeState({
        forStack: [
          {
            stepId: '1',
            iteration: 3,
            start: 1,
            end: 5,
            variable: 'i',
            implicit: false,
            source: { kind: 'range' },
          },
        ],
        activeFrameKey: buildFrameKey('1', 3),
        activeEntry: 2,
        frameEntryCounts: { [buildFrameKey('1', 3)]: 2 },
      }),
      { stepId: '1.1' },
    );
    expect(cursor.iteration).toBe(3);
    expect(cursor.frame).toEqual({ kind: 'active', frameKey: buildFrameKey('1', 3), entry: 2 });
  });

  it('defaults a prompted-for step to the live iteration without an explicit iteration', () => {
    // Coverage carried over from the deleted CLI suite (#499): prompted-for has
    // no forClause, so the default-iteration path must not run a bounds check
    // and still resolves to the live iteration from the forStack.
    const cursor = resolveManualCompletionCursor(
      promptedForSteps,
      makeState({
        forStack: [
          {
            stepId: '1',
            iteration: 4,
            start: 1,
            variable: 'i',
            implicit: false,
            source: { kind: 'range' },
          },
        ],
        activeFrameKey: buildFrameKey('1', 4),
        activeEntry: 1,
        frameEntryCounts: { [buildFrameKey('1', 4)]: 1 },
      }),
      { stepId: '1.1' },
    );
    expect(cursor.iteration).toBe(4);
    expect(cursor.frame).toEqual({ kind: 'active', frameKey: buildFrameKey('1', 4), entry: 1 });
  });

  it('adopts a numeric AT from a three-level step id as the iteration', () => {
    const cursor = resolveManualCompletionCursor(
      forSteps({ variable: 'i', start: 1, end: 5 }),
      makeState({
        activeFrameKey: buildFrameKey('1', 1),
        frameEntryCounts: { [buildFrameKey('1', 1)]: 1 },
      }),
      { stepId: '1.2.1' },
    );
    expect(cursor.iteration).toBe(2);
    expect(cursor.frame).toEqual({ kind: 'inactive', frameKey: buildFrameKey('1', 2) });
  });

  it('allows --index on a prompted-for step without a bounds check', () => {
    const cursor = resolveManualCompletionCursor(
      promptedForSteps,
      makeState({
        activeFrameKey: buildFrameKey('1', 1),
        frameEntryCounts: { [buildFrameKey('1', 1)]: 1 },
      }),
      { stepId: '1.1', iteration: 9 },
    );
    expect(cursor.iteration).toBe(9);
    expect(cursor.frame).toEqual({ kind: 'inactive', frameKey: buildFrameKey('1', 9) });
  });

  it('skips the upper-bound check for an open-window file source', () => {
    const cursor = resolveManualCompletionCursor(
      forSteps({ variable: 'item', start: 1, source: 'items' }),
      makeState({
        activeFrameKey: buildFrameKey('1', 1),
        frameEntryCounts: { [buildFrameKey('1', 1)]: 1 },
      }),
      { stepId: '1.1', iteration: 999 },
    );
    expect(cursor.iteration).toBe(999);
  });

  it('throws on an invalid step target', () => {
    expect(() =>
      resolveManualCompletionCursor(substepSteps, makeState(), { stepId: 'invalid!!!' }),
    ).toThrow('Invalid step target: invalid!!!');
  });

  it('throws when the explicit step does not match the active step', () => {
    expect(() =>
      resolveManualCompletionCursor(substepSteps, makeState(), { stepId: '2.1' }),
    ).toThrow('targets step "2" but the active step is "1"');
  });

  it('throws when the explicit target has no substep (bare step id)', () => {
    expect(() => resolveManualCompletionCursor(substepSteps, makeState(), { stepId: '1' })).toThrow(
      'must include a substep',
    );
  });

  it('throws when the target substep does not exist in the step', () => {
    expect(() =>
      resolveManualCompletionCursor(substepSteps, makeState(), { stepId: '1.99' }),
    ).toThrow('substep "99" does not exist');
  });

  it('throws when the state is not at a substep', () => {
    const baseSteps: readonly ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx },
    ];
    expect(() =>
      resolveManualCompletionCursor(baseSteps, makeState({ substep: undefined }), {
        stepId: '1.1',
      }),
    ).toThrow('--step requires the runbook to be at a substep');
  });

  it('throws on a template AT expression', () => {
    expect(() =>
      resolveManualCompletionCursor(forSteps({ variable: 'i', start: 1, end: 5 }), makeState(), {
        stepId: '1.1 AT {{Index}}',
      }),
    ).toThrow('template AT expression');
  });

  it('throws when the iteration is below FOR start', () => {
    expect(() =>
      resolveManualCompletionCursor(forSteps({ variable: 'i', start: 3, end: 5 }), makeState(), {
        stepId: '1.1',
        iteration: 2,
      }),
    ).toThrow('below FOR start 3');
  });

  it('throws when the iteration exceeds FOR end', () => {
    expect(() =>
      resolveManualCompletionCursor(forSteps({ variable: 'i', start: 1, end: 5 }), makeState(), {
        stepId: '1.1',
        iteration: 6,
      }),
    ).toThrow('exceeds FOR end 5');
  });

  it('throws when an iteration targets a non-FOR step', () => {
    expect(() =>
      resolveManualCompletionCursor(substepSteps, makeState(), { stepId: '1.1', iteration: 3 }),
    ).toThrow('--index requires step "1" to be a FOR or PROMPTED-FOR step');
  });
});
