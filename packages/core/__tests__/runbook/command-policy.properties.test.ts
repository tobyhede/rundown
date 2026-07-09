import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  activeFrame,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  createRunControlGrants,
  deriveEffectiveRole,
  resolveCommandIntent,
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type ActorContext,
  type CommandIntent,
  type RunbookState,
} from '../../src/runbook/index.js';
import {
  assertClaimId,
  assertClaimLookupKey,
  assertClaimSecretHash,
  type ClaimRecord,
} from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// RunId fixtures must be 32 lowercase hex chars (`/^rd_[a-f0-9]{32}$/`);
// `assertRunId` rejects any char outside a-f0-9, so do not use g-z here.
const runIdA = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const runIdB = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimKey = assertClaimLookupKey('rdclk_11111111111111111111111111111111');
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const secretHash = assertClaimSecretHash(`sha256:${'b'.repeat(64)}`);
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

/** Open claimed child of {@link runIdA}, used to arm the open-claims guard. */
function openClaim(): ClaimRecord {
  return {
    claimKey,
    secretHash,
    controlledRunId: runIdB,
    delegation: {
      childRunId: runIdB,
      tokenHash,
      parentRunId: runIdA,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
    grants: createRunControlGrants(runIdB),
    issuedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const actorContextArb: fc.Arbitrary<ActorContext> = fc.oneof(
  fc.constant(UNKNOWN_ACTOR_CONTEXT),
  fc.constantFrom(runIdA, runIdB).map((controlledRunId) =>
    verifiedClaimContext({
      authority: { kind: 'bearer', claimId, claimKey },
      claim: { claimKey, controlledRunId, grants: createRunControlGrants(controlledRunId) },
    }),
  ),
);

function verifiedRunControlContext(controlledRunId = runIdA): ActorContext {
  return verifiedClaimContext({
    authority: { kind: 'bearer', claimId, claimKey },
    claim: {
      claimKey,
      controlledRunId,
      grants: createRunControlGrants(controlledRunId),
    },
  });
}

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
  fc.record({
    kind: fc.constant('terminal-run-force' as const),
    command: fc.constantFrom('complete' as const, 'stop' as const),
    targeted: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('run-navigation' as const),
    command: fc.constant('goto' as const),
    targeted: fc.boolean(),
  }),
  fc.constant({ kind: 'delegation-collection' } as const),
);

const KNOWN_KINDS = new Set([
  'allowed',
  'actor_context_required',
  'claim_grant_required',
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

  it('never allows an unknown actor for bearer-required intents', () => {
    const bearerRequired = intentArb.filter(
      (intent) => intent.kind === 'delegation-issuance' || intent.kind === 'delegation-collection',
    );
    fc.assert(
      fc.property(bearerRequired, (intent) => {
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

  it('never blocks a targeted advance/issuance/terminal-force with delegation_collection_pending', () => {
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
      fc.record({
        kind: fc.constant('terminal-run-force' as const),
        command: fc.constantFrom('complete' as const, 'stop' as const),
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
            actorContext: verifiedRunControlContext(runIdA),
            intent: { ...intent, targeted: false },
            targetSelector: { kind: 'default' },
            targetState: target,
          }).kind,
        ).toBe('delegation_collection_pending');
        // The targeted command bypasses the collection-pending guard even though
        // the run has an unconsumed reported outcome.
        expect(
          resolveCommandIntent({
            actorContext: verifiedRunControlContext(runIdA),
            intent,
            targetSelector: { kind: 'explicit-step', step: '1.1' },
            targetState: target,
          }).kind,
        ).not.toBe('delegation_collection_pending');
      }),
    );
  });

  it('exempts run-navigation from the collection-pending and open-claims guards for a controlling actor', () => {
    // The run-navigation intent is documented as role-gated like an advance but
    // exempt from the collection-pending and open-claims guards: navigation is
    // operator control flow, not completion. Pin that a controlling actor's
    // goto — bare or targeted — is allowed against a state that blocks a bare
    // advance, with and without open claims.
    const navigation = fc.record({
      kind: fc.constant('run-navigation' as const),
      command: fc.constant('goto' as const),
      targeted: fc.boolean(),
    });
    const openClaimsArb = fc.constantFrom<readonly ClaimRecord[]>([], [openClaim()]);
    const target = pendingState();
    fc.assert(
      fc.property(navigation, openClaimsArb, (intent, openClaims) => {
        // Anchor: a bare advance against this state/claims combination is
        // blocked, proving the guards genuinely fire for this fixture.
        expect(
          resolveCommandIntent({
            actorContext: verifiedRunControlContext(runIdA),
            intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
            targetSelector: { kind: 'default' },
            targetState: target,
            openClaims,
          }).kind,
        ).not.toBe('allowed');
        expect(
          resolveCommandIntent({
            actorContext: verifiedRunControlContext(runIdA),
            intent,
            targetSelector: { kind: 'default' },
            targetState: target,
            openClaims,
          }).kind,
        ).toBe('allowed');
      }),
    );
  });

  it('derives orchestrator_for_target iff the caller controls the target run', () => {
    fc.assert(
      fc.property(actorContextArb, fc.constantFrom(runIdA, runIdB), (actorContext, targetId) => {
        const role = deriveEffectiveRole(actorContext, baseState(targetId));
        const controlsTarget =
          actorContext.kind === 'verified_claim' && actorContext.claim.controlledRunId === targetId;
        expect(role === 'orchestrator_for_target').toBe(controlsTarget);
      }),
    );
  });
});
