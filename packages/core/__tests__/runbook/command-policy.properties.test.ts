import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  activeFrame,
  actorContextFromEvidence,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  claimControllerContext,
  deriveEffectiveRole,
  resolveCommandIntent,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type ActorContext,
  type CallerEvidence,
  type CommandIntent,
  type DelegationExposure,
  type RunbookState,
} from '../../src/runbook/index.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// RunId fixtures must be 32 lowercase hex chars (`/^rd_[a-f0-9]{32}$/`);
// `assertRunId` rejects any char outside a-f0-9, so do not use g-z here.
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

/**
 * Build a delegating-run state that genuinely satisfies the
 * collection-pending policy guard: an unconsumed `delegation`-agent outcome
 * persisted at the active frame keeps {@link rejectBareMutationIfCollectionPending}
 * in its pending branch, so a bare mutation against this state is blocked.
 */
function pendingState(id = runIdA): RunbookState {
  const frame = activeFrame(buildFrameKey('1'), 1);
  const completionKey = buildCompletionKey(frame, '1');
  return {
    ...baseState(id),
    resolvedCompletions: {
      [completionKey]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: frame,
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
  };
}

const actorContextArb: fc.Arbitrary<ActorContext> = fc.oneof(
  fc.constant(UNKNOWN_ACTOR_CONTEXT),
  fc.constantFrom(runIdA, runIdB).map((id) => trustedRunControllerContext(id)),
  fc
    .constantFrom(runIdA, runIdB)
    .map((controlledRunId) => claimControllerContext({ claimId, tokenHash, controlledRunId })),
);

const intentArb: fc.Arbitrary<CommandIntent> = fc.oneof(
  fc.constant({ kind: 'inspect' } as const),
  fc.record({
    kind: fc.constant('delegating-run-advance' as const),
    command: fc.constantFrom('pass' as const, 'fail' as const),
    targeted: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('delegation-issuance' as const),
    command: fc.constant('delegate' as const),
    targeted: fc.boolean(),
  }),
  fc.constant({ kind: 'delegation-collection' } as const),
);

const KNOWN_KINDS = new Set([
  'allowed',
  'actor_context_required',
  'collect_requires_orchestrator',
  'delegation_collection_pending',
  'open_claims',
]);

describe('resolveCommandIntent properties', () => {
  it('is total: always returns a known outcome kind and never throws', () => {
    fc.assert(
      fc.property(actorContextArb, intentArb, (actorContext, intent) => {
        const outcome = resolveCommandIntent({
          actorContext,
          intent,
          targetSelector: { kind: 'default' },
          targetState: baseState(),
        });
        expect(KNOWN_KINDS.has(outcome.kind)).toBe(true);
      }),
    );
  });

  it('always allows inspect intent for any actor', () => {
    fc.assert(
      fc.property(actorContextArb, (actorContext) => {
        expect(
          resolveCommandIntent({
            actorContext,
            intent: { kind: 'inspect' },
            targetSelector: { kind: 'default' },
            targetState: baseState(),
          }).kind,
        ).toBe('allowed');
      }),
    );
  });

  it('never allows an unknown actor a non-inspect intent', () => {
    const nonInspect = intentArb.filter((intent) => intent.kind !== 'inspect');
    fc.assert(
      fc.property(nonInspect, (intent) => {
        expect(
          resolveCommandIntent({
            actorContext: UNKNOWN_ACTOR_CONTEXT,
            intent,
            targetSelector: { kind: 'default' },
            targetState: baseState(),
          }).kind,
        ).not.toBe('allowed');
      }),
    );
  });

  it('never blocks a targeted advance/issuance with delegation_collection_pending', () => {
    const targeted = fc.oneof(
      fc.record({
        kind: fc.constant('delegating-run-advance' as const),
        command: fc.constantFrom('pass' as const, 'fail' as const),
        targeted: fc.constant(true),
      }),
      fc.record({
        kind: fc.constant('delegation-issuance' as const),
        command: fc.constant('delegate' as const),
        targeted: fc.constant(true),
      }),
    );
    const target = pendingState();
    fc.assert(
      fc.property(targeted, (intent) => {
        // Anchor: the bare counterpart (no explicit target) IS blocked against
        // this same state, proving the fixture genuinely establishes a
        // pending-collection condition. Without this the bypass assertion below
        // could pass vacuously on a state that was never pending in the first place.
        expect(
          resolveCommandIntent({
            actorContext: trustedRunControllerContext(runIdA),
            intent: { ...intent, targeted: false },
            targetSelector: { kind: 'default' },
            targetState: target,
          }).kind,
        ).toBe('delegation_collection_pending');
        // The targeted command bypasses the collection-pending guard even though
        // the run has an unconsumed reported outcome.
        expect(
          resolveCommandIntent({
            actorContext: trustedRunControllerContext(runIdA),
            intent,
            targetSelector: { kind: 'explicit-step', step: '1.1' },
            targetState: target,
          }).kind,
        ).not.toBe('delegation_collection_pending');
      }),
    );
  });

  it('derives orchestrator_for_target iff the caller controls the target run', () => {
    fc.assert(
      fc.property(actorContextArb, fc.constantFrom(runIdA, runIdB), (actorContext, targetId) => {
        const role = deriveEffectiveRole(actorContext, baseState(targetId));
        const controlsTarget =
          (actorContext.kind === 'trusted_run_controller' && actorContext.runId === targetId) ||
          (actorContext.kind === 'claim_controller' && actorContext.controlledRunId === targetId);
        expect(role === 'orchestrator_for_target').toBe(controlsTarget);
      }),
    );
  });

  it('evidence role composition: orchestrator_for_target iff (run_controller or claim naming the target) or (direct_cli on a standalone target)', () => {
    const evidenceArb: fc.Arbitrary<CallerEvidence> = fc.oneof(
      fc.constant({ kind: 'direct_cli' } as const),
      fc.constantFrom(runIdA, runIdB).map((runId) => ({ kind: 'run_controller' as const, runId })),
      fc.constantFrom(runIdA, runIdB).map((controlledRunId) => ({
        kind: 'claim' as const,
        claimId,
        tokenHash,
        controlledRunId,
      })),
      fc.constant({ kind: 'plugin' } as const),
      fc.constant({ kind: 'mcp' } as const),
      fc.constant({ kind: 'unknown' } as const),
    );
    const exposureArb: fc.Arbitrary<DelegationExposure> = fc.constantFrom(
      'standalone' as const,
      'delegating' as const,
    );
    fc.assert(
      fc.property(
        evidenceArb,
        fc.constantFrom(runIdA, runIdB),
        exposureArb,
        (evidence, targetId, exposure) => {
          const role = deriveEffectiveRole(
            actorContextFromEvidence(evidence, { runId: targetId, exposure }),
            baseState(targetId),
          );
          const expectOrchestrator =
            (evidence.kind === 'direct_cli' && exposure === 'standalone') ||
            (evidence.kind === 'run_controller' && evidence.runId === targetId) ||
            (evidence.kind === 'claim' && evidence.controlledRunId === targetId);
          expect(role === 'orchestrator_for_target').toBe(expectOrchestrator);
        },
      ),
    );
  });
});
