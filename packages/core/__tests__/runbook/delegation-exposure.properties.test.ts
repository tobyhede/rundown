import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import type { ResolvedStep } from '@rundown-org/parser';
import {
  classifyDelegationExposure,
  type DelegationExposureInput,
} from '../../src/runbook/delegation-exposure.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { assertClaimId, assertRunId } from '../../src/runbook/index.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import type { RunbookState, SubstepState } from '../../src/runbook/types.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';
import {
  makeBaseStep,
  makeCommandStep,
  makeContextSnapshot,
  makeResolvedStepWithSubsteps,
  makeStepDelegation,
  makeSubstep,
} from '../helpers/step-factories.js';

const runId = assertRunId('rd_11111111111111111111111111111111');
const parentRunId = assertRunId('rd_22222222222222222222222222222222');
const childRunId = assertRunId('rd_33333333333333333333333333333333');
const claimIdA = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const claimIdB = assertClaimId('rdclm_abcdefghijklmnopqrstu2');
const tokenHash = assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`);

/**
 * One flag per documented exposure clause of {@link classifyDelegationExposure}:
 * (a) document DELEGATE substep, (b) open claims, (c) reported-but-uncollected
 * outcome, (d) substep delegation record, (e) parent linkage, (f) inline
 * composition — static runbook-list entries and runtime inline launch records.
 */
interface ExposureClauses {
  readonly documentDelegateSubstep: boolean;
  readonly documentRunbookList: boolean;
  readonly openClaimCount: number;
  readonly pendingOutcome: boolean;
  readonly delegationRecord: boolean;
  readonly inlineRecord: boolean;
  readonly parentLinkage: 'none' | 'inline' | 'delegation';
}

/** Clause-independent input variation that must never affect the classification. */
interface ExposureNoise {
  readonly plainStepCount: number;
  readonly plainSubstepStep: boolean;
  readonly plainDoneSubstepRecord: boolean;
  readonly recordStatus: 'running' | 'done';
  readonly recordResult: 'pass' | 'fail';
  readonly delegationCancelled: boolean;
}

const clausesArb: fc.Arbitrary<ExposureClauses> = fc.record({
  documentDelegateSubstep: fc.boolean(),
  documentRunbookList: fc.boolean(),
  openClaimCount: fc.nat({ max: 2 }),
  pendingOutcome: fc.boolean(),
  delegationRecord: fc.boolean(),
  inlineRecord: fc.boolean(),
  parentLinkage: fc.constantFrom('none' as const, 'inline' as const, 'delegation' as const),
});

const noiseArb: fc.Arbitrary<ExposureNoise> = fc.record({
  plainStepCount: fc.nat({ max: 2 }),
  plainSubstepStep: fc.boolean(),
  plainDoneSubstepRecord: fc.boolean(),
  recordStatus: fc.constantFrom('running' as const, 'done' as const),
  recordResult: fc.constantFrom('pass' as const, 'fail' as const),
  delegationCancelled: fc.boolean(),
});

function anyClauseFires(clauses: ExposureClauses): boolean {
  return (
    clauses.documentDelegateSubstep ||
    clauses.documentRunbookList ||
    clauses.openClaimCount > 0 ||
    clauses.pendingOutcome ||
    clauses.delegationRecord ||
    clauses.inlineRecord ||
    clauses.parentLinkage !== 'none'
  );
}

function makeOpenClaim(index: number): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId: index === 0 ? claimIdA : claimIdB,
    childRunId,
    tokenHash,
    parentRunId: runId,
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    claimedAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
  };
}

function delegationSubstepRecord(noise: ExposureNoise): SubstepState {
  return {
    id: 'd1',
    frameKey: buildFrameKey('1'),
    status: noise.recordStatus,
    ...(noise.recordStatus === 'done' ? { result: noise.recordResult } : {}),
    delegation: makeStepDelegation({
      childRunId,
      cancelledAt: noise.delegationCancelled ? '2026-07-03T00:00:02.000Z' : null,
    }),
  };
}

function inlineSubstepRecord(noise: ExposureNoise): SubstepState {
  return {
    id: 'i1',
    frameKey: buildFrameKey('1'),
    status: noise.recordStatus,
    ...(noise.recordStatus === 'done' ? { result: noise.recordResult } : {}),
    inline: {
      childRunbookPath: 'stage.runbook.md',
      childRunbookRef: { source: 'project', path: 'stage.runbook.md' },
      contextSnapshot: makeContextSnapshot(),
      childRunId,
      createdAt: '2026-07-03T00:00:00.000Z',
      startedAt: '2026-07-03T00:00:01.000Z',
    },
  };
}

function pendingOutcomeCompletions(): RunbookState['resolvedCompletions'] {
  const frame = activeFrame(buildFrameKey('1'), 1);
  const key = buildCompletionKey(frame, '1');
  return {
    [key]: buildResolvedCompletion({
      agentId: 'delegation',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrame: frame,
      completedAt: '2026-07-03T00:00:00.000Z',
    }),
  };
}

function buildSteps(clauses: ExposureClauses, noise: ExposureNoise): readonly ResolvedStep[] {
  const steps: ResolvedStep[] = [];
  for (let index = 0; index < noise.plainStepCount; index++) {
    const name = `p${String(index)}`;
    steps.push(index % 2 === 0 ? makeBaseStep({ name }) : makeCommandStep({ name }));
  }
  if (noise.plainSubstepStep) {
    steps.push(
      makeResolvedStepWithSubsteps({ name: 'plain', substeps: [makeSubstep({ id: '1' })] }),
    );
  }
  if (clauses.documentDelegateSubstep) {
    steps.push(
      makeResolvedStepWithSubsteps({
        name: 'delegate',
        substeps: [makeSubstep({ id: '1', delegate: true })],
      }),
    );
  }
  if (clauses.documentRunbookList) {
    steps.push(
      makeResolvedStepWithSubsteps({
        name: 'compose',
        substeps: [makeSubstep({ id: '1', runbooks: ['stage.runbook.md'] })],
      }),
    );
  }
  return steps;
}

function buildState(clauses: ExposureClauses, noise: ExposureNoise): RunbookState {
  const substepStates: SubstepState[] = [];
  if (noise.plainDoneSubstepRecord) {
    substepStates.push({
      id: 'n1',
      frameKey: buildFrameKey('1'),
      status: 'done',
      result: noise.recordResult,
    });
  }
  if (clauses.delegationRecord) {
    substepStates.push(delegationSubstepRecord(noise));
  }
  if (clauses.inlineRecord) {
    substepStates.push(inlineSubstepRecord(noise));
  }
  return {
    id: runId,
    runbook: { source: 'project', path: 'exposure-properties.md' },
    runbookPath: 'exposure-properties.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    lifecycle: 'running',
    startedAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    substepStates,
    resolvedCompletions: clauses.pendingOutcome ? pendingOutcomeCompletions() : {},
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...(clauses.parentLinkage === 'inline'
      ? {
          parentLinkage: {
            kind: 'inline' as const,
            parentRunId,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        }
      : {}),
    ...(clauses.parentLinkage === 'delegation'
      ? {
          parentLinkage: {
            kind: 'delegation' as const,
            tokenHash,
            parentRunId,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          },
        }
      : {}),
  };
}

function buildInput(clauses: ExposureClauses, noise: ExposureNoise): DelegationExposureInput {
  return {
    state: buildState(clauses, noise),
    steps: buildSteps(clauses, noise),
    openClaims: Array.from({ length: clauses.openClaimCount }, (_, index) => makeOpenClaim(index)),
  };
}

/**
 * State-derived sticky records that can be added to an existing input. Each
 * corresponds to one of the classifier's monotone clauses (b, c, d, f-runtime).
 */
type StickyAddition = 'open-claim' | 'pending-outcome' | 'delegation-record' | 'inline-record';

const additionsArb: fc.Arbitrary<readonly StickyAddition[]> = fc.uniqueArray(
  fc.constantFrom<StickyAddition>(
    'open-claim',
    'pending-outcome',
    'delegation-record',
    'inline-record',
  ),
);

function augmentInput(
  input: DelegationExposureInput,
  additions: readonly StickyAddition[],
  noise: ExposureNoise,
): DelegationExposureInput {
  const extraSubstepStates: SubstepState[] = [];
  if (additions.includes('delegation-record')) {
    extraSubstepStates.push({ ...delegationSubstepRecord(noise), id: 'd2' });
  }
  if (additions.includes('inline-record')) {
    extraSubstepStates.push({ ...inlineSubstepRecord(noise), id: 'i2' });
  }
  return {
    state: {
      ...input.state,
      substepStates: [...(input.state.substepStates ?? []), ...extraSubstepStates],
      resolvedCompletions: additions.includes('pending-outcome')
        ? { ...input.state.resolvedCompletions, ...pendingOutcomeCompletions() }
        : input.state.resolvedCompletions,
    },
    steps: input.steps,
    openClaims: additions.includes('open-claim')
      ? [...input.openClaims, makeOpenClaim(input.openClaims.length)]
      : input.openClaims,
  };
}

describe('classifyDelegationExposure properties', () => {
  it('OR-composition: delegating iff at least one clause fires, standalone iff none', () => {
    fc.assert(
      fc.property(clausesArb, noiseArb, (clauses, noise) => {
        const exposure = classifyDelegationExposure(buildInput(clauses, noise));
        expect(exposure).toBe(anyClauseFires(clauses) ? 'delegating' : 'standalone');
      }),
    );
  });

  it('monotonic stickiness: adding claims, outcomes, or delegation/inline records never flips delegating to standalone', () => {
    fc.assert(
      fc.property(clausesArb, noiseArb, additionsArb, (clauses, noise, additions) => {
        const base = buildInput(clauses, noise);
        const before = classifyDelegationExposure(base);
        const after = classifyDelegationExposure(augmentInput(base, additions, noise));
        if (additions.length === 0) {
          // No additions: classification is a pure function of the input.
          expect(after).toBe(before);
        } else {
          // Every addition fires a monotone state-derived clause, so the
          // augmented input is delegating regardless of the base — in
          // particular, a delegating base can never decay to standalone.
          expect(after).toBe('delegating');
        }
        if (before === 'delegating') {
          expect(after).toBe('delegating');
        }
      }),
    );
  });
});
