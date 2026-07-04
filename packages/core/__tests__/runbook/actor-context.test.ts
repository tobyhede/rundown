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
  type DelegationExposure,
  type EvidenceTarget,
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

const EXPOSURES: readonly DelegationExposure[] = ['standalone', 'delegating'];

function target(runId = runIdA, exposure: DelegationExposure = 'standalone'): EvidenceTarget {
  return { runId, exposure };
}

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

describe('actorContextFromEvidence — the evidence × exposure truth table', () => {
  it('keeps direct_cli trusted for a standalone target (solo-runbook convenience lane)', () => {
    expect(actorContextFromEvidence({ kind: 'direct_cli' }, target(runIdA, 'standalone'))).toEqual(
      trustedRunControllerContext(runIdA),
    );
  });

  it('maps direct_cli on a DELEGATING target to the unknown context — ambient trust removed (#460)', () => {
    expect(actorContextFromEvidence({ kind: 'direct_cli' }, target(runIdA, 'delegating'))).toBe(
      UNKNOWN_ACTOR_CONTEXT,
    );
  });

  it.each(
    EXPOSURES,
  )('maps run_controller evidence to a trusted controller of the NAMED run for %s exposure', (exposure) => {
    expect(
      actorContextFromEvidence({ kind: 'run_controller', runId: runIdA }, target(runIdB, exposure)),
    ).toEqual(trustedRunControllerContext(runIdA));
  });

  it.each(
    EXPOSURES,
  )('maps claim evidence to a claim controller anchored on the controlled run for %s exposure', (exposure) => {
    expect(
      actorContextFromEvidence(
        { kind: 'claim', claimId, tokenHash, controlledRunId: runIdB },
        target(runIdA, exposure),
      ),
    ).toEqual(claimControllerContext({ claimId, tokenHash, controlledRunId: runIdB }));
  });

  it.each(
    EXPOSURES,
  )('maps plugin evidence to the unknown singleton for %s exposure', (exposure) => {
    expect(
      actorContextFromEvidence(
        { kind: 'plugin', agentId: 'agent-7', sessionId: 'session-9' },
        target(runIdA, exposure),
      ),
    ).toBe(UNKNOWN_ACTOR_CONTEXT);
  });

  it.each(EXPOSURES)('maps mcp evidence to the unknown singleton for %s exposure', (exposure) => {
    expect(
      actorContextFromEvidence({ kind: 'mcp', toolName: 'rd_pass' }, target(runIdA, exposure)),
    ).toBe(UNKNOWN_ACTOR_CONTEXT);
  });

  it.each(
    EXPOSURES,
  )('maps unknown evidence to the unknown singleton for %s exposure', (exposure) => {
    expect(actorContextFromEvidence({ kind: 'unknown' }, target(runIdA, exposure))).toBe(
      UNKNOWN_ACTOR_CONTEXT,
    );
  });

  it('derives orchestrator_for_target when run_controller evidence names the target run', () => {
    const context = actorContextFromEvidence(
      { kind: 'run_controller', runId: runIdA },
      target(runIdA, 'delegating'),
    );
    expect(deriveEffectiveRole(context, baseState(runIdA))).toBe('orchestrator_for_target');
  });

  it('derives unknown_for_target when run_controller evidence names a different run (wrong --run is refused downstream)', () => {
    const context = actorContextFromEvidence(
      { kind: 'run_controller', runId: runIdB },
      target(runIdA, 'delegating'),
    );
    expect(deriveEffectiveRole(context, baseState(runIdA))).toBe('unknown_for_target');
  });

  it('fails closed when exposure was classified for a different run than the one resolved (TOCTOU interleave)', () => {
    // Trust minted against run A; the resolver independently resolved run B.
    // deriveEffectiveRole compares actorContext.runId to the resolved target id
    // and yields unknown_for_target — the stack mutating between the two
    // lock-free reads can never transfer A's trust onto B.
    const context = actorContextFromEvidence({ kind: 'direct_cli' }, target(runIdA, 'standalone'));
    expect(deriveEffectiveRole(context, baseState(runIdB))).toBe('unknown_for_target');
  });
});

const exposureArb: fc.Arbitrary<DelegationExposure> = fc.constantFrom(
  'standalone' as const,
  'delegating' as const,
);

const callerEvidenceArb: fc.Arbitrary<CallerEvidence> = fc.oneof(
  fc.constant({ kind: 'direct_cli' } as const),
  fc.constantFrom(runIdA, runIdB).map((runId) => ({ kind: 'run_controller' as const, runId })),
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
  it('totality: never throws for any generated caller evidence and exposure', () => {
    fc.assert(
      fc.property(
        callerEvidenceArb,
        fc.constantFrom(runIdA, runIdB),
        exposureArb,
        (evidence, targetRunId, exposure) => {
          expect(() =>
            actorContextFromEvidence(evidence, { runId: targetRunId, exposure }),
          ).not.toThrow();
        },
      ),
    );
  });

  it('role composition: orchestrator_for_target iff (run_controller or claim naming the target) or (direct_cli on a standalone target)', () => {
    fc.assert(
      fc.property(
        callerEvidenceArb,
        fc.constantFrom(runIdA, runIdB),
        exposureArb,
        (evidence, targetRunId, exposure) => {
          const role = deriveEffectiveRole(
            actorContextFromEvidence(evidence, { runId: targetRunId, exposure }),
            baseState(targetRunId),
          );
          const expectOrchestrator =
            (evidence.kind === 'direct_cli' && exposure === 'standalone') ||
            (evidence.kind === 'run_controller' && evidence.runId === targetRunId) ||
            (evidence.kind === 'claim' && evidence.controlledRunId === targetRunId);
          expect(role === 'orchestrator_for_target').toBe(expectOrchestrator);
        },
      ),
    );
  });

  it('claim anchoring: controlledRunId comes from the evidence, not the target argument', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(runIdA, runIdB),
        fc.constantFrom(runIdA, runIdB),
        exposureArb,
        (controlledRunId, targetRunId, exposure) => {
          const context = actorContextFromEvidence(
            { kind: 'claim', claimId, tokenHash, controlledRunId },
            { runId: targetRunId, exposure },
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
        exposureArb,
        (evidence, targetRunId, exposure) => {
          expect(actorContextFromEvidence(evidence, { runId: targetRunId, exposure })).toBe(
            UNKNOWN_ACTOR_CONTEXT,
          );
        },
      ),
    );
  });

  it('direct_cli never yields trust over a delegating target (always-strict, no carve-outs)', () => {
    fc.assert(
      fc.property(fc.constantFrom(runIdA, runIdB), (targetRunId) => {
        expect(
          actorContextFromEvidence(
            { kind: 'direct_cli' },
            { runId: targetRunId, exposure: 'delegating' },
          ),
        ).toBe(UNKNOWN_ACTOR_CONTEXT);
      }),
    );
  });
});
