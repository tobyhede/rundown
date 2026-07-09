import { describe, expect, it } from '@jest/globals';
import {
  AbortCommandService,
  assertClaimId,
  assertClaimLookupKey,
  assertRunId,
  createRunControlGrants,
  buildFrameKey,
} from '../../src/runbook/index.js';
import type { CommandTargetReader } from '../../src/runbook/command-target-resolver.js';
import type { ClaimVerificationResult } from '../../src/runbook/claim-id.js';
import type { RunbookState } from '../../src/runbook/types.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const runId = assertRunId('rd_11111111111111111111111111111111');
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');

function state(): RunbookState {
  return {
    id: runId,
    runbook: { source: 'project', path: 'abort.md' },
    runbookPath: 'abort.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: {},
    activeEntry: 1,
    activeFrameKey: buildFrameKey('1'),
    startedAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
  };
}

function targetReader(options: {
  readonly verification?: ClaimVerificationResult;
}): CommandTargetReader {
  return {
    async getActive() {
      return null;
    },
    async resolveRunningStackMember() {
      return { kind: 'not_on_stack' };
    },
    async getActiveForClaimId() {
      return { status: 'missing', claimId };
    },
    async verifyClaimId() {
      return (
        options.verification ?? {
          status: 'verified',
          claim: {
            claimKey,
            controlledRunId: runId,
            grants: createRunControlGrants(runId),
          },
        }
      );
    },
    async listOpenClaimsForParent() {
      return [];
    },
  };
}

describe('AbortCommandService', () => {
  it('authorizes abort-delegation with an explicit bearer claim grant', async () => {
    const service = new AbortCommandService({ targetReader: targetReader({}) });

    const outcome = await service.authorizeAbortCommand({
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetState: state(),
      stepId: '1.1',
    });

    expect(outcome.kind).toBe('authorized');
    if (outcome.kind !== 'authorized') return;
    expect(outcome.authorization.request).toEqual({
      action: 'abort-delegation',
      runId,
      stepId: '1.1',
    });
    expect(
      outcome.authorization.claim.grants.some((grant) => grant.action === 'abort-delegation'),
    ).toBe(true);
  });

  it('refuses abort-delegation when the verified claim lacks the abort grant', async () => {
    const service = new AbortCommandService({
      targetReader: targetReader({
        verification: {
          status: 'verified',
          claim: {
            claimKey,
            controlledRunId: runId,
            grants: [{ action: 'mutate-run', runId }],
          },
        },
      }),
    });

    const outcome = await service.authorizeAbortCommand({
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetState: state(),
    });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.policy.kind).toBe('claim_grant_required');
  });
});
