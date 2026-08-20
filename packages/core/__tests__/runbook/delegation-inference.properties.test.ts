/* eslint-disable @typescript-eslint/no-deprecated --
 * This suite deliberately pins the behavior of deprecated inference helpers
 * (superseded by resolveDelegationIssuance) that stay on the published API
 * surface until a major release. */
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
  findPendingDelegation,
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
  brandInitialTemplateVarsForTest,
} from '../../src/testing/effective-vars.js';
import { makeDelegationCredentialDescriptor } from '../../src/testing/delegation-fixtures.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';

import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/index.js';

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
 * `cancelled` flips `cancelledAt` from `null` to a timestamp.
 */
interface DelegationSpec {
  readonly id: string;
  readonly frameKey: FrameKey;
  readonly cancelled: boolean;
  /** When true, the delegation is claimed (`childRunId` set, not pending). */
  readonly claimed: boolean;
}

/**
 * Build a substep state carrying a delegation from a generated spec.
 *
 * `index` is folded into the persisted credential coordinate so generated
 * delegations retain the production invariant that each issuance is distinct.
 *
 * @param spec - Generated delegation description.
 * @param index - Position in the generated array; disambiguates issuance coordinates.
 * @returns A substep state with a possibly cancelled or claimed delegation.
 */
function substepFromSpec(spec: DelegationSpec, index: number): SubstepState {
  return {
    id: spec.id,
    frameKey: spec.frameKey,
    status: 'pending',
    delegation: {
      credential: makeDelegationCredentialDescriptor({
        parentStepId: `1.${spec.id}`,
        parentFrameKey: spec.frameKey,
        parentEntry: index + 1,
      }),
      // Derived from `index` so no two generated delegations share a verifier.
      // A constant hash here would silently disarm every assertion that pairs a
      // projected entry with its source substep: mis-attribution, stale-versus-
      // superseded selection, and hash miscomputation all become unobservable
      // when every candidate value is byte-identical.
      tokenHash: assertDelegationTokenHash(`sha256:${index.toString(16).padStart(64, '0')}`),
      childRunbookPath: 'child.runbook.md',
      childRunbookRef: { source: 'project', path: 'child.runbook.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
      childRunId: spec.claimed ? brandRunIdForTest(`rd_${'2'.repeat(32)}`) : null,
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
    prompted: false,
    templateVars: brandInitialTemplateVarsForTest({}),
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
    schemaVersion: CURRENT_SCHEMA_VERSION,
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
    cancelled: fc.boolean(),
    claimed: fc.boolean(),
  });

  const specsArb: fc.Arbitrary<readonly DelegationSpec[]> = fc.array(specArb, {
    minLength: 0,
    maxLength: 8,
  });

  it('returns only entries whose frame equals the active frame', () => {
    fc.assert(
      fc.property(specsArb, fc.option(frameArb, { nil: undefined }), (specs, activeFrameKey) => {
        const state = makeFrontierState(
          STEP,
          activeFrameKey,
          specs.map((spec, index) => substepFromSpec(spec, index)),
        );
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
              ss.delegation.childRunId === null &&
              ss.delegation.credential === entry.credential &&
              ss.delegation.tokenHash === entry.tokenHash,
          );
          expect(sourceInExpectedFrame).toBe(true);
        }
      }),
    );
  });

  it('never surfaces a cancelled or claimed delegation or plaintext token', () => {
    fc.assert(
      fc.property(specsArb, fc.option(frameArb, { nil: undefined }), (specs, activeFrameKey) => {
        const substepStates = specs.map((spec, index) => substepFromSpec(spec, index));
        const state = makeFrontierState(STEP, activeFrameKey, substepStates);

        for (const entry of deriveDelegateFrontier(state)) {
          expect(entry).not.toHaveProperty('token');
          expect(entry.credential).toBeDefined();
          expect(entry.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
          // No cancelled delegation may match this issuance descriptor.
          const matchesCancelled = substepStates.some(
            (ss) =>
              ss.delegation?.credential === entry.credential && ss.delegation.cancelledAt !== null,
          );
          expect(matchesCancelled).toBe(false);
          const matchesClaimed = substepStates.some(
            (ss) =>
              ss.delegation?.credential === entry.credential && ss.delegation.childRunId !== null,
          );
          expect(matchesClaimed).toBe(false);
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
          const original = specs.map((spec, index) => substepFromSpec(spec, index));
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
            entries
              .map(
                (entry) =>
                  `${entry.id}\u0000${entry.runbook}\u0000${JSON.stringify(entry.credential)}\u0000${entry.tokenHash}`,
              )
              .sort((a, b) => a.localeCompare(b));

          expect(normalise(shuffledFrontier)).toEqual(normalise(baseFrontier));
        },
      ),
    );
  });

  it('pairs each entry with the verifier of the substep that issued it', () => {
    // The disclosure boundary re-derives a bearer from `credential` and refuses
    // unless it hashes to `tokenHash`. Pairing an entry's descriptor with a
    // sibling's verifier would therefore make a legitimately issued credential
    // undisclosable — so the pairing itself is the invariant, not the shape of
    // either field. Only meaningful because generated verifiers are distinct.
    // The pairing assertions live inside a loop over the derived frontier, so a
    // generator that never produced a disclosable entry would satisfy this
    // property without executing a single one. Counting observations and
    // asserting the total afterwards is what makes the property falsifiable —
    // the same defect class F21 fixed by making `tokenHash` discriminating.
    let observed = 0;
    fc.assert(
      fc.property(specsArb, fc.option(frameArb, { nil: undefined }), (specs, activeFrameKey) => {
        const substepStates = specs.map((spec, index) => substepFromSpec(spec, index));
        const state = makeFrontierState(STEP, activeFrameKey, substepStates);

        for (const entry of deriveDelegateFrontier(state)) {
          observed += 1;
          const source = substepStates.find((ss) => ss.delegation?.credential === entry.credential);
          expect(source).toBeDefined();
          expect(entry.tokenHash).toBe(source?.delegation?.tokenHash);
        }
      }),
    );
    expect(observed).toBeGreaterThan(0);
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

describe('findPendingDelegation invariants', () => {
  const STEP = '1';
  const frameArb: fc.Arbitrary<FrameKey> = fc.oneof(
    fc.constant(buildFrameKey(STEP)),
    fc.constant(buildFrameKey(STEP, 1)),
    fc.constant(buildFrameKey(STEP, 2)),
  );
  const idArb = fc.constantFrom('1', '2', '3');
  const specArb: fc.Arbitrary<DelegationSpec> = fc.record({
    id: idArb,
    frameKey: frameArb,
    cancelled: fc.boolean(),
    claimed: fc.boolean(),
  });
  const specsArb = fc.array(specArb, { minLength: 0, maxLength: 8 });

  // Production guarantees one substep state per (id, frameKey); dedupe the
  // generated specs to mirror that invariant so the single-result lookup is
  // fully order-deterministic.
  function uniqueStates(specs: readonly DelegationSpec[]): SubstepState[] {
    const byKey = new Map<string, SubstepState>();
    for (const [index, spec] of specs.entries()) {
      byKey.set(`${spec.id}|${spec.frameKey}`, substepFromSpec(spec, index));
    }
    return [...byKey.values()];
  }

  it('is defined iff some substep matches id, frame, non-cancelled, and unclaimed', () => {
    fc.assert(
      fc.property(specsArb, idArb, frameArb, (specs, targetId, targetFrame) => {
        const substepStates = uniqueStates(specs);
        const state = makeFrontierState(STEP, targetFrame, substepStates);
        const result = findPendingDelegation(state, `${STEP}.${targetId}`, targetFrame);

        const expectMatch = substepStates.some(
          (ss) =>
            ss.id === targetId &&
            ss.frameKey === targetFrame &&
            ss.delegation?.cancelledAt === null &&
            ss.delegation.childRunId === null,
        );
        expect(result !== undefined).toBe(expectMatch);

        if (result) {
          expect(result).not.toHaveProperty('token');
          expect(result.credential).toBeDefined();
          expect(result.tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
          // The returned delegation must belong to a substep matching the
          // *targeted* id and frame (not merely exist somewhere), so a lookup
          // that ignored id or frameKey would be caught here too.
          const isMatchingSubstepDelegation = substepStates.some(
            (ss) =>
              ss.id === targetId &&
              ss.frameKey === targetFrame &&
              ss.delegation === result &&
              ss.delegation.cancelledAt === null &&
              ss.delegation.childRunId === null,
          );
          expect(isMatchingSubstepDelegation).toBe(true);
        }
      }),
    );
  });

  it('is invariant under input reordering (determinism)', () => {
    fc.assert(
      fc.property(
        specsArb,
        idArb,
        frameArb,
        fc.array(fc.integer(), { maxLength: 8 }),
        (specs, targetId, targetFrame, shuffleSeed) => {
          const original = uniqueStates(specs);
          const shuffled = original
            .map((ss, i) => ({ ss, key: shuffleSeed[i] ?? i }))
            .sort((a, b) => a.key - b.key)
            .map((entry) => entry.ss);

          const stepId = `${STEP}.${targetId}`;
          const base = findPendingDelegation(
            makeFrontierState(STEP, targetFrame, original),
            stepId,
            targetFrame,
          );
          const reordered = findPendingDelegation(
            makeFrontierState(STEP, targetFrame, shuffled),
            stepId,
            targetFrame,
          );

          expect(reordered?.credential).toEqual(base?.credential);
          expect(reordered?.tokenHash).toBe(base?.tokenHash);
        },
      ),
    );
  });
});
