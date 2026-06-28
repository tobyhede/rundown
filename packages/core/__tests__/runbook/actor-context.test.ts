import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  actorContextFromEvidence,
  buildFrameKey,
  claimControllerContext,
  deriveEffectiveRole,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type CallerEvidence,
  type RunbookState,
} from '../../src/runbook/index.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// RunId fixtures must be 32 lowercase hex chars (`/^rd_[a-f0-9]{32}$/`).
const runIdA = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const runIdB = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimId = assertClaimId('rdclm_abcdefghijklmnopqrstu1');
const tokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

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

describe('actorContextFromEvidence', () => {
  it('maps direct CLI evidence to a trusted run controller for the target run', () => {
    expect(actorContextFromEvidence({ kind: 'direct_cli' }, runIdA)).toEqual(
      trustedRunControllerContext(runIdA),
    );
  });

  it('maps complete claim evidence to a claim controller anchored on the controlled run', () => {
    expect(
      actorContextFromEvidence(
        { kind: 'claim', claimId, tokenHash, controlledRunId: runIdB },
        runIdA,
      ),
    ).toEqual(claimControllerContext({ claimId, tokenHash, controlledRunId: runIdB }));
  });

  it('maps plugin evidence without trusted metadata to the unknown singleton', () => {
    expect(
      actorContextFromEvidence(
        { kind: 'plugin', agentId: 'agent-7', sessionId: 'session-9' },
        runIdA,
      ),
    ).toBe(UNKNOWN_ACTOR_CONTEXT);
  });

  it('maps mcp evidence without trusted metadata to the unknown singleton', () => {
    expect(actorContextFromEvidence({ kind: 'mcp', toolName: 'rd_pass' }, runIdA)).toBe(
      UNKNOWN_ACTOR_CONTEXT,
    );
  });

  it('maps unknown evidence to the unknown singleton', () => {
    expect(actorContextFromEvidence({ kind: 'unknown' }, runIdA)).toBe(UNKNOWN_ACTOR_CONTEXT);
  });
});

const callerEvidenceArb: fc.Arbitrary<CallerEvidence> = fc.oneof(
  fc.constant({ kind: 'direct_cli' } as const),
  fc.record({
    kind: fc.constant('plugin' as const),
    agentId: fc.option(fc.string(), { nil: undefined }),
    sessionId: fc.option(fc.string(), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant('mcp' as const),
    toolName: fc.option(fc.string(), { nil: undefined }),
  }),
  fc
    .constantFrom(runIdA, runIdB)
    .map((controlledRunId) => ({ kind: 'claim' as const, claimId, tokenHash, controlledRunId })),
  fc.constant({ kind: 'unknown' } as const),
);

const pluginMcpEvidenceArb: fc.Arbitrary<CallerEvidence> = fc.oneof(
  fc.record({
    kind: fc.constant('plugin' as const),
    agentId: fc.option(fc.string(), { nil: undefined }),
    sessionId: fc.option(fc.string(), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant('mcp' as const),
    toolName: fc.option(fc.string(), { nil: undefined }),
  }),
);

describe('actorContextFromEvidence properties', () => {
  it('totality: never throws for any generated caller evidence', () => {
    fc.assert(
      fc.property(callerEvidenceArb, fc.constantFrom(runIdA, runIdB), (evidence, targetRunId) => {
        expect(() => actorContextFromEvidence(evidence, targetRunId)).not.toThrow();
      }),
    );
  });

  it('role composition: orchestrator_for_target iff direct CLI or claim on the target run', () => {
    fc.assert(
      fc.property(callerEvidenceArb, fc.constantFrom(runIdA, runIdB), (evidence, targetRunId) => {
        const role = deriveEffectiveRole(
          actorContextFromEvidence(evidence, targetRunId),
          baseState(targetRunId),
        );
        const expectOrchestrator =
          evidence.kind === 'direct_cli' ||
          (evidence.kind === 'claim' && evidence.controlledRunId === targetRunId);
        expect(role === 'orchestrator_for_target').toBe(expectOrchestrator);
      }),
    );
  });

  it('claim anchoring: controlledRunId comes from the evidence, not the target argument', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(runIdA, runIdB),
        fc.constantFrom(runIdA, runIdB),
        (controlledRunId, targetRunId) => {
          const context = actorContextFromEvidence(
            { kind: 'claim', claimId, tokenHash, controlledRunId },
            targetRunId,
          );
          expect(context.kind).toBe('claim_controller');
          if (context.kind === 'claim_controller') {
            expect(context.controlledRunId).toBe(controlledRunId);
          }
        },
      ),
    );
  });

  it('plugin/MCP metadata never grants trust on its own', () => {
    fc.assert(
      fc.property(
        pluginMcpEvidenceArb,
        fc.constantFrom(runIdA, runIdB),
        (evidence, targetRunId) => {
          expect(actorContextFromEvidence(evidence, targetRunId)).toBe(UNKNOWN_ACTOR_CONTEXT);
        },
      ),
    );
  });
});
