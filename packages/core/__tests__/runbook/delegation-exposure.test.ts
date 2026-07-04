import { describe, expect, it } from '@jest/globals';
import type { ResolvedStep } from '@rundown-org/parser';
import { classifyDelegationExposure } from '../../src/runbook/delegation-exposure.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { assertClaimId, assertRunId } from '../../src/runbook/index.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import type { RunbookState } from '../../src/runbook/types.js';
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
const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const tokenHash = assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`);

/** Steps with no delegation or composition anywhere — includes substep-less members. */
function plainSteps(): readonly ResolvedStep[] {
  return [
    makeBaseStep({ name: '1' }),
    makeCommandStep({ name: '2' }),
    makeResolvedStepWithSubsteps({ name: '3', substeps: [makeSubstep({ id: '1' })] }),
  ];
}

function stepsWithDelegateSubstep(): readonly ResolvedStep[] {
  return [
    makeBaseStep({ name: '1' }),
    makeResolvedStepWithSubsteps({
      name: '2',
      substeps: [makeSubstep({ id: '1', delegate: true })],
    }),
  ];
}

function stepsWithInlineRunbookListSubstep(): readonly ResolvedStep[] {
  return [
    makeBaseStep({ name: '1' }),
    makeResolvedStepWithSubsteps({
      name: '2',
      substeps: [makeSubstep({ id: '1', runbooks: ['stage.runbook.md'] })],
    }),
  ];
}

function plainState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: runId,
    runbook: { source: 'project', path: 'exposure-test.md' },
    runbookPath: 'exposure-test.md',
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
    substepStates: [],
    resolvedCompletions: {},
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

function openClaim(): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId,
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

function stateWithPendingOutcome(): RunbookState {
  const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  return plainState({
    resolvedCompletions: {
      [key]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-07-03T00:00:00.000Z',
      }),
    },
  });
}

function stateWithDoneDelegationSubstep(): RunbookState {
  return plainState({
    substepStates: [
      {
        id: '1',
        frameKey: buildFrameKey('1'),
        status: 'done',
        result: 'pass',
        delegation: makeStepDelegation({ childRunId }),
      },
    ],
  });
}

function stateWithDoneInlineSubstep(): RunbookState {
  return plainState({
    substepStates: [
      {
        id: '1',
        frameKey: buildFrameKey('1'),
        status: 'done',
        result: 'pass',
        inline: {
          childRunbookPath: 'stage.runbook.md',
          childRunbookRef: { source: 'project', path: 'stage.runbook.md' },
          contextSnapshot: makeContextSnapshot(),
          childRunId,
          createdAt: '2026-07-03T00:00:00.000Z',
          startedAt: '2026-07-03T00:00:01.000Z',
        },
      },
    ],
  });
}

function stateWithInlineParentLinkage(): RunbookState {
  return plainState({
    parentLinkage: {
      kind: 'inline',
      parentRunId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
  });
}

function stateWithDelegationParentLinkage(): RunbookState {
  return plainState({
    parentLinkage: {
      kind: 'delegation',
      tokenHash,
      parentRunId,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
  });
}

describe('classifyDelegationExposure', () => {
  it('classifies a linear runbook with no delegation anywhere as standalone', () => {
    expect(
      classifyDelegationExposure({ state: plainState(), steps: plainSteps(), openClaims: [] }),
    ).toBe('standalone');
  });

  it('classifies a run whose document authors a DELEGATE substep as delegating (before any issuance)', () => {
    expect(
      classifyDelegationExposure({
        state: plainState(),
        steps: stepsWithDelegateSubstep(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('classifies a run with open claims as delegating', () => {
    expect(
      classifyDelegationExposure({
        state: plainState(),
        steps: plainSteps(),
        openClaims: [openClaim()],
      }),
    ).toBe('delegating');
  });

  it('classifies a run with reported-but-uncollected outcomes as delegating', () => {
    expect(
      classifyDelegationExposure({
        state: stateWithPendingOutcome(),
        steps: plainSteps(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('stays delegating after claims close: substepState delegation history is sticky', () => {
    expect(
      classifyDelegationExposure({
        state: stateWithDoneDelegationSubstep(),
        steps: plainSteps(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('classifies an inline-linked child run as delegating', () => {
    expect(
      classifyDelegationExposure({
        state: stateWithInlineParentLinkage(),
        steps: plainSteps(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('classifies a delegation-linked (claimed child) run as delegating', () => {
    expect(
      classifyDelegationExposure({
        state: stateWithDelegationParentLinkage(),
        steps: plainSteps(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('classifies an inline-composing PARENT as delegating before any launch (static runbook-list clause f)', () => {
    // Root run whose only composition is inline runbook-list entries — no
    // DELEGATE substep, no claims, no pending outcomes, no parent linkage.
    // Without clause (f) this classified standalone (the #460 pattern one
    // level up: a lingering grandchild bare-drives the popped-back root).
    expect(
      classifyDelegationExposure({
        state: plainState(),
        steps: stepsWithInlineRunbookListSubstep(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });

  it('stays delegating after an inline stage completes: substepState inline records are sticky (clause f runtime signal)', () => {
    expect(
      classifyDelegationExposure({
        state: stateWithDoneInlineSubstep(),
        steps: plainSteps(),
        openClaims: [],
      }),
    ).toBe('delegating');
  });
});
