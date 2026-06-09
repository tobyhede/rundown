import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';

import {
  buildFrameKey,
  deriveActiveFrame,
  deriveDelegateFrontier,
  inferDelegationTarget,
  isPostDelegateAggregationCursor,
  type DelegationInferenceState,
  type FrameKey,
  type RunbookState,
  type SubstepState,
} from '../../src/runbook/index.js';
import {
  brandEffectiveVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

function makeState(): DelegationInferenceState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    step: '1',
  };
}

function makeSubstep(overrides: Partial<Substep> & { id: string; description: string }): Substep {
  return { transitions: DEFAULT_TRANSITIONS, ...overrides };
}

function makeStepWithSubsteps(
  name: string,
  substeps: readonly Substep[],
): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    transitions: DEFAULT_TRANSITIONS,
    substeps,
  };
}

function makeRunbookListSubstep(index: number, delegate: boolean): Substep {
  const substepNumber = String(index + 1);

  return makeSubstep({
    id: substepNumber,
    description: `Substep ${substepNumber}`,
    runbooks: [`child-${substepNumber}.runbook.md`],
    ...(delegate ? { delegate: true as const } : {}),
  });
}

function makeRunbookListSteps(flags: readonly boolean[]): readonly ResolvedStep[] {
  return [
    makeStepWithSubsteps(
      '1',
      flags.map((delegate, index) => makeRunbookListSubstep(index, delegate)),
    ),
  ];
}

describe('delegation inference invariants', () => {
  it('never selects runbook-list substeps that are not marked DELEGATE', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (flags) => {
        const firstDelegatedIndex = flags.findIndex(Boolean);
        const steps = makeRunbookListSteps(flags);

        if (firstDelegatedIndex === -1) {
          expect(() => inferDelegationTarget(makeState(), steps)).toThrow(
            expect.objectContaining({ code: 'RD-813' }),
          );
          return;
        }

        const result = inferDelegationTarget(makeState(), steps);
        const firstDelegatedStepNumber = String(firstDelegatedIndex + 1);

        expect(result).toEqual({
          runbookRef: `child-${firstDelegatedStepNumber}.runbook.md`,
          stepId: `1.${firstDelegatedStepNumber}`,
        });
      }),
    );
  });

  it('throws RD-814 for any DELEGATE substep missing a runbook reference', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _-]{0,20}$/),
        fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: undefined }),
        (description, prompt) => {
          const steps: ResolvedStep[] = [
            makeStepWithSubsteps('1', [
              makeSubstep({
                id: '1',
                description,
                delegate: true,
                prompt,
              }),
            ]),
          ];

          expect(() => inferDelegationTarget(makeState(), steps)).toThrow(
            expect.objectContaining({ code: 'RD-814' }),
          );
        },
      ),
    );
  });
});

/**
 * Generated description of a single per-frame delegation substep record.
 *
 * `token` is `undefined` for a token-less (non-recoverable) delegation, and
 * `cancelled` flips `cancelledAt` from `null` to a timestamp.
 */
interface DelegationSpec {
  readonly id: string;
  readonly frameKey: FrameKey;
  readonly token: string | undefined;
  readonly cancelled: boolean;
}

/**
 * Build a substep state carrying a delegation from a generated spec.
 *
 * @param spec - Generated delegation description.
 * @returns A substep state with a (possibly cancelled / token-less) delegation.
 */
function substepFromSpec(spec: DelegationSpec): SubstepState {
  return {
    id: spec.id,
    frameKey: spec.frameKey,
    status: 'pending',
    delegation: {
      ...(spec.token !== undefined ? { token: spec.token } : {}),
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: spec.cancelled ? '2026-01-02T00:00:00.000Z' : null,
    },
  };
}

/**
 * Build a minimal `RunbookState` positioned in `activeFrameKey` over the given
 * substep states. `forStack` is left undefined so the derived active frame is
 * the base frame (`<step>|`).
 *
 * @param step - Cursor step name.
 * @param activeFrameKey - Active frame key, or undefined to exercise the
 *   `deriveActiveFrame` fallback.
 * @param substepStates - Per-frame substep states.
 * @returns A runbook state suitable for `deriveDelegateFrontier`.
 */
function makeFrontierState(
  step: string,
  activeFrameKey: FrameKey | undefined,
  substepStates: readonly SubstepState[],
): RunbookState {
  return {
    id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step,
    stepName: 'Main step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: step, status: 'running' }],
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    ...(activeFrameKey !== undefined ? { activeFrameKey } : {}),
    substepStates,
  };
}

describe('deriveDelegateFrontier invariants', () => {
  const STEP = '1';
  // A small, bounded space of frames for step "1": the base frame and a few
  // FOR-iteration frames. Order-independence and frame-scoping only need a
  // handful of distinct frames to exercise.
  const frameArb: fc.Arbitrary<FrameKey> = fc.oneof(
    fc.constant(buildFrameKey(STEP)),
    fc.constant(buildFrameKey(STEP, 1)),
    fc.constant(buildFrameKey(STEP, 2)),
  );

  const specArb: fc.Arbitrary<DelegationSpec> = fc.record({
    id: fc.constantFrom('1', '2', '3'),
    frameKey: frameArb,
    token: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    cancelled: fc.boolean(),
  });

  const specsArb: fc.Arbitrary<readonly DelegationSpec[]> = fc.array(specArb, {
    minLength: 0,
    maxLength: 8,
  });

  it('returns only entries whose frame equals the active frame', () => {
    fc.assert(
      fc.property(specsArb, fc.option(frameArb, { nil: undefined }), (specs, activeFrameKey) => {
        const state = makeFrontierState(STEP, activeFrameKey, specs.map(substepFromSpec));
        // Mirror production's active-frame resolution exactly.
        const expectedFrame = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;

        for (const entry of deriveDelegateFrontier(state)) {
          // The entry id is `<step>.<substep>`; we cannot read frameKey off the
          // entry, so we assert via the source: every contributing substep state
          // in the expected frame. The invariant is enforced by reconstructing
          // which substeps could have produced this entry.
          const substepId = entry.id.slice(`${STEP}.`.length);
          const sourceInExpectedFrame = state.substepStates?.some(
            (ss) =>
              ss.id === substepId &&
              ss.frameKey === expectedFrame &&
              ss.delegation?.cancelledAt === null &&
              ss.delegation.token === entry.token,
          );
          expect(sourceInExpectedFrame).toBe(true);
        }
      }),
    );
  });

  it('never surfaces a cancelled or token-less delegation', () => {
    fc.assert(
      fc.property(specsArb, fc.option(frameArb, { nil: undefined }), (specs, activeFrameKey) => {
        const substepStates = specs.map(substepFromSpec);
        const state = makeFrontierState(STEP, activeFrameKey, substepStates);

        for (const entry of deriveDelegateFrontier(state)) {
          // Token must be a non-empty recoverable string.
          expect(typeof entry.token).toBe('string');
          expect(entry.token.length).toBeGreaterThan(0);
          // No cancelled delegation may match this entry's token.
          const matchesCancelled = substepStates.some(
            (ss) => ss.delegation?.token === entry.token && ss.delegation.cancelledAt !== null,
          );
          expect(matchesCancelled).toBe(false);
        }
      }),
    );
  });

  it('is order-independent: shuffling delegations yields a set-equal frontier', () => {
    fc.assert(
      fc.property(
        specsArb,
        fc.option(frameArb, { nil: undefined }),
        // A permutation of indices used to reorder the substep states.
        fc.array(fc.integer(), { maxLength: 8 }),
        (specs, activeFrameKey, shuffleSeed) => {
          const original = specs.map(substepFromSpec);
          // Stable deterministic shuffle driven by the generated seed.
          const shuffled = original
            .map((ss, i) => ({ ss, key: shuffleSeed[i] ?? i }))
            .sort((a, b) => a.key - b.key)
            .map((entry) => entry.ss);

          const baseFrontier = deriveDelegateFrontier(
            makeFrontierState(STEP, activeFrameKey, original),
          );
          const shuffledFrontier = deriveDelegateFrontier(
            makeFrontierState(STEP, activeFrameKey, shuffled),
          );

          const normalise = (entries: ReturnType<typeof deriveDelegateFrontier>) =>
            entries.map((e) => `${e.id} ${e.runbook} ${e.token}`).sort((a, b) => a.localeCompare(b));

          expect(normalise(shuffledFrontier)).toEqual(normalise(baseFrontier));
        },
      ),
    );
  });
});

describe('isPostDelegateAggregationCursor invariants', () => {
  // Document order: step 1 = DELEGATE (substeps 1.1/1.2), 2 and 3 = plain.
  function buildSteps(): readonly ResolvedStep[] {
    return [
      makeStepWithSubsteps('1', [
        makeSubstep({ id: '1', description: 'A', runbooks: ['child.runbook.md'], delegate: true }),
        makeSubstep({ id: '2', description: 'B', runbooks: ['child.runbook.md'], delegate: true }),
      ]),
      { kind: 'base', name: '2', description: 'Plain 2', transitions: DEFAULT_TRANSITIONS },
      { kind: 'base', name: '3', description: 'Plain 3', transitions: DEFAULT_TRANSITIONS },
    ];
  }

  const STEPS = buildSteps();
  const DELEGATE_SUBSTEP_IDS = ['1', '2'];

  // Generated substep-state records over the steps above. Frames are bounded to
  // the base/iteration frames of steps 1 and 2 so cross-step and cross-frame
  // coincidences are exercised without unbounded growth.
  const recordArb: fc.Arbitrary<SubstepState> = fc.record({
    id: fc.constantFrom('1', '2'),
    frameKey: fc.constantFrom(
      buildFrameKey('1'),
      buildFrameKey('1', 1),
      buildFrameKey('1', 2),
      buildFrameKey('2'),
    ),
    status: fc.constantFrom('pending' as const, 'running' as const, 'done' as const),
  });

  const recordsArb = fc.array(recordArb, { minLength: 0, maxLength: 10 });
  const cursorArb = fc.constantFrom('1', '2', '3', '99');

  it('true implies the doc-order predecessor is a DELEGATE step fully done in some frame', () => {
    fc.assert(
      fc.property(cursorArb, recordsArb, (step, substepStates) => {
        const state: DelegationInferenceState = {
          id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
          step,
          substepStates,
        };

        if (!isPostDelegateAggregationCursor(state, STEPS)) return;

        // Predecessor in document order must exist and be the DELEGATE step.
        const index = STEPS.findIndex((s) => s.name === step);
        expect(index).toBeGreaterThan(0);
        const predecessor = STEPS[index - 1];
        expect(predecessor.name).toBe('1');

        // Some single frame belonging to the predecessor has ALL delegate
        // substeps done.
        const frames = new Set(
          substepStates
            .filter((ss) => ss.status === 'done')
            .map((ss) => ss.frameKey)
            // Only frames belonging to predecessor step "1".
            .filter((fk) => (fk.split('|')[0] ?? fk) === '1'),
        );
        const someFrameFullyDone = [...frames].some((fk) =>
          DELEGATE_SUBSTEP_IDS.every((id) =>
            substepStates.some((ss) => ss.id === id && ss.frameKey === fk && ss.status === 'done'),
          ),
        );
        expect(someFrameFullyDone).toBe(true);
      }),
    );
  });

  it('is false for a freshly-started state (cursor on first step, no aggregation)', () => {
    fc.assert(
      fc.property(recordsArb, (substepStates) => {
        const state: DelegationInferenceState = {
          id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
          step: '1',
          substepStates,
        };
        // The first step has no document-order predecessor.
        expect(isPostDelegateAggregationCursor(state, STEPS)).toBe(false);
      }),
    );
  });

  it('is false when the predecessor is not a DELEGATE step (cursor on step 3)', () => {
    fc.assert(
      fc.property(recordsArb, (substepStates) => {
        const state: DelegationInferenceState = {
          id: brandRunIdForTest(`rd_${'1'.repeat(32)}`),
          step: '3',
          substepStates,
        };
        // Predecessor of step 3 is the plain step 2 — never an aggregated
        // DELEGATE successor regardless of stale done records.
        expect(isPostDelegateAggregationCursor(state, STEPS)).toBe(false);
      }),
    );
  });
});
