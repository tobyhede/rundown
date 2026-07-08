import { describe, expect, it } from '@jest/globals';
import {
  assertClaimId,
  assertClaimLookupKey,
  assertRunId,
  buildFrameKey,
  deriveEffectiveRole,
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const runIdA = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const runIdB = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');

function baseState(id = runIdA): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'p.md' },
    runbookPath: 'p.md',
    step: '1',
    stepName: 'S',
    substep: '1',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [],
    resolvedCompletions: {},
    frameEntryCounts: { [buildFrameKey('1')]: 1 },
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'running',
    schemaVersion: 1,
    frontmatterOutputs: [],
  };
}

function verifiedContext(controlledRunId = runIdA) {
  return verifiedClaimContext({
    authority: { kind: 'bearer', claimId, claimKey },
    claim: {
      claimKey,
      controlledRunId,
      grants: [{ action: 'mutate-run', runId: controlledRunId }],
    },
  });
}

describe('verifiedClaimContext', () => {
  it('carries core-verified claim evidence', () => {
    expect(verifiedContext()).toEqual({
      kind: 'verified_claim',
      authority: { kind: 'bearer', claimId, claimKey },
      claim: {
        claimKey,
        controlledRunId: runIdA,
        grants: [{ action: 'mutate-run', runId: runIdA }],
      },
    });
  });

  it('derives orchestrator_for_target only for the claim controlled run', () => {
    expect(deriveEffectiveRole(verifiedContext(runIdA), baseState(runIdA))).toBe(
      'orchestrator_for_target',
    );
    expect(deriveEffectiveRole(verifiedContext(runIdB), baseState(runIdA))).toBe(
      'delegated_relative_to_target',
    );
  });

  it('derives unknown role for absent targets and unknown context', () => {
    expect(deriveEffectiveRole(UNKNOWN_ACTOR_CONTEXT, baseState(runIdA))).toBe(
      'unknown_for_target',
    );
    expect(deriveEffectiveRole(verifiedContext(runIdA), undefined)).toBe('unknown_for_target');
  });
});
