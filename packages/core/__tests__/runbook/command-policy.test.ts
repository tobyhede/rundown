import { describe, expect, it } from '@jest/globals';
import {
  activeFrame,
  assertClaimId,
  assertClaimSecretHash,
  assertDelegationTokenHash,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  createRunControlGrants,
  deriveEffectiveRole,
  resolveCommandIntent,
  UNKNOWN_ACTOR_CONTEXT,
  verifiedClaimContext,
  type ClaimGrant,
  type ClaimLookupKey,
  type RunId,
  type ClaimRecord,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const parentRunId = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const childRunId = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const claimId = assertClaimId(
  'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
);
const claimKey = 'rdclk_11111111111111111111111111111111' as ClaimLookupKey;
const tokenHash = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);

function state(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: parentRunId,
    runbook: { source: 'project', path: 'parent.md' },
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Parent',
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
    ...overrides,
  };
}

function claimRecord(): ClaimRecord {
  return {
    claimKey,
    secretHash: assertClaimSecretHash(`sha256:${'b'.repeat(64)}`),
    controlledRunId: childRunId,
    delegation: {
      childRunId,
      tokenHash,
      parentRunId,
      parentStepId: '1.1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
    grants: [
      { action: 'mutate-run', runId: childRunId },
      {
        action: 'report-delegation-result',
        childRunId,
        tokenHash,
        parentRunId,
        parentStepId: '1.1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
    ],
    issuedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function verifiedRunContext(
  runId: RunId,
  grants: readonly ClaimGrant[] = createRunControlGrants(runId),
) {
  return verifiedClaimContext({
    authority: { kind: 'bearer', claimId, claimKey },
    claim: {
      claimKey,
      controlledRunId: runId,
      grants,
    },
  });
}

function stateWithReportedOutcome(): RunbookState {
  const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
  return state({
    resolvedCompletions: {
      [completionKey]: buildResolvedCompletion({
        agentId: 'delegation',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
  });
}

describe('verifiedClaimContext', () => {
  it('builds verified claim context without a source tag', () => {
    const context = verifiedRunContext(parentRunId);

    expect(context).toMatchObject({
      kind: 'verified_claim',
      authority: { kind: 'bearer', claimId, claimKey },
      claim: { claimKey, controlledRunId: parentRunId },
    });
    expect('source' in context).toBe(false);
  });
});

describe('resolveCommandIntent', () => {
  it('rejects unknown collection in the strict core policy model', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: UNKNOWN_ACTOR_CONTEXT,
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });

  it('rejects unknown bare transition in the strict core policy model', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: UNKNOWN_ACTOR_CONTEXT,
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'actor_context_required',
      intent: 'delegating-run-advance',
    });
  });

  it('allows a mutation only when a verified claim has the exact grant', () => {
    const parent = state();
    const actorContext = verifiedRunContext(parent.id, [
      { action: 'mutate-run', runId: parent.id },
    ]);

    expect(
      resolveCommandIntent({
        actorContext,
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'claim', claimId },
        targetState: parent,
        openClaims: [],
      }),
    ).toMatchObject({ kind: 'allowed' });
  });

  it('denies a mutation when a verified claim has no matching grant', () => {
    const parent = state();
    const child = state({ id: childRunId });
    const actorContext = verifiedRunContext(child.id, [{ action: 'mutate-run', runId: child.id }]);

    expect(
      resolveCommandIntent({
        actorContext,
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'claim', claimId },
        targetState: parent,
        openClaims: [],
      }),
    ).toEqual({
      kind: 'claim_grant_required',
      intent: 'delegating-run-advance',
      targetRunId: parent.id,
    });
  });

  it('allows direct CLI compatibility context to collect on the controlled target run', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(targetState.id),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: targetState.id,
    });
  });

  it('allows collect --claim-id when the actor is orchestrator for the resolved claimed run', () => {
    // The frontend resolves the claim to its claimed run and passes that run as
    // `targetState`; the claim selector itself is not a rejection trigger.
    const claimedRun = state({ id: childRunId });

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(claimedRun.id),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'claim', claimId },
        targetState: claimedRun,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: childRunId,
    });
  });

  it('allows an orchestrator to collect a run they control even when it has upward delegation linkage', () => {
    // A run delegating upward is still a valid collection target for the actor
    // that controls it (spec lines 357-359). Linkage alone is not a rejection.
    const delegated = state({
      id: childRunId,
      parentLinkage: {
        kind: 'delegation',
        parentRunId,
        parentStepId: '1.1',
        tokenHash,
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
      },
    });

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(delegated.id),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState: delegated,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: childRunId,
    });
  });

  it.each([
    {
      command: 'pass' as const,
      intent: {
        kind: 'delegating-run-advance' as const,
        command: 'pass' as const,
        targeted: false,
      },
    },
    {
      command: 'fail' as const,
      intent: {
        kind: 'delegating-run-advance' as const,
        command: 'fail' as const,
        targeted: false,
      },
    },
    {
      command: 'delegate' as const,
      intent: {
        kind: 'delegation-issuance' as const,
        command: 'delegate' as const,
        targeted: false,
      },
    },
  ])('rejects bare $command while delegation collection is pending', (caseDef) => {
    const targetState = stateWithReportedOutcome();

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(targetState.id),
        intent: caseDef.intent,
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'delegation_collection_pending',
      parentRunId,
      outcomeCompletionKeys: [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')],
      message:
        'A delegated claim has reported an outcome that must be collected by the orchestrator.',
    });
  });

  it('allows targeted pass while collection is pending because it is not a bare parent advance', () => {
    const targetState = stateWithReportedOutcome();

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(targetState.id),
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: true },
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        targetState,
      }),
    ).toEqual({
      kind: 'allowed',
      role: 'orchestrator_for_target',
      targetRunId: targetState.id,
    });
  });

  it('maps open claims through the policy when no reported outcome is pending', () => {
    const targetState = state();
    const claim = claimRecord();

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(targetState.id),
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: false },
        targetSelector: { kind: 'default' },
        targetState,
        openClaims: [claim],
      }),
    ).toEqual({
      kind: 'open_claims',
      parentRunId,
      claims: [claim],
    });
  });

  it('rejects a verified claim collecting into a run without a matching collect grant', () => {
    const targetState = state();

    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(childRunId, [
          { action: 'collect-for-run', runId: childRunId },
        ]),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
        targetState,
      }),
    ).toEqual({
      kind: 'claim_grant_required',
      intent: 'delegation-collection',
      targetRunId: parentRunId,
    });
  });

  it('rejects a collection when no target run resolves', () => {
    // With no resolved target, the role collapses to `unknown_for_target` and the
    // orchestrator gate refuses for want of caller evidence — covering the
    // collection path when `targetState` is absent.
    expect(
      resolveCommandIntent({
        actorContext: verifiedRunContext(parentRunId),
        intent: { kind: 'delegation-collection' },
        targetSelector: { kind: 'default' },
      }),
    ).toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });
});

describe('post-flip determinations', () => {
  it('fails closed when a verified claim lacks the grant for a different target run', () => {
    const contextForA = verifiedRunContext(parentRunId, [
      { action: 'mutate-run', runId: parentRunId },
    ]);
    expect(
      resolveCommandIntent({
        actorContext: contextForA,
        intent: { kind: 'delegating-run-advance', command: 'pass', targeted: true },
        targetSelector: { kind: 'default' },
        targetState: state({ id: childRunId }),
      }),
    ).toEqual({
      kind: 'claim_grant_required',
      intent: 'delegating-run-advance',
      targetRunId: childRunId,
    });
  });

  it('refuses a bare collect (direct_cli, unknown role) on a delegating parent with the --run remediation', () => {
    const outcome = resolveCommandIntent({
      actorContext: UNKNOWN_ACTOR_CONTEXT,
      intent: { kind: 'delegation-collection' },
      targetSelector: { kind: 'default' },
      targetState: state(),
    });
    expect(outcome).toEqual({
      kind: 'actor_context_required',
      intent: 'delegation-collection',
    });
  });
});

describe('resolveCommandIntent run-navigation', () => {
  it('refuses run-navigation without actor evidence', () => {
    const outcome = resolveCommandIntent({
      actorContext: UNKNOWN_ACTOR_CONTEXT,
      intent: { kind: 'run-navigation', command: 'goto', targeted: true },
      targetSelector: { kind: 'default' },
      targetState: state(),
    });
    expect(outcome).toEqual({ kind: 'actor_context_required', intent: 'run-navigation' });
  });

  it('allows run-navigation for the trusted controller of the target', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'run-navigation', command: 'goto', targeted: true },
      targetSelector: { kind: 'default' },
      targetState: state(),
    });
    expect(outcome).toMatchObject({ kind: 'allowed', role: 'orchestrator_for_target' });
  });

  it('does not refuse run-navigation for pending collection (navigation is operator control flow, not completion)', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'run-navigation', command: 'goto', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: stateWithReportedOutcome(),
    });
    expect(outcome).toMatchObject({ kind: 'allowed' });
  });

  it('does not refuse run-navigation for open claims (navigation is operator control flow, not completion)', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'run-navigation', command: 'goto', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: state(),
      openClaims: [claimRecord()],
    });
    expect(outcome).toMatchObject({ kind: 'allowed' });
  });
});

describe('resolveCommandIntent terminal-run-force', () => {
  it('refuses a bare terminal force with no actor evidence as actor_context_required', () => {
    const outcome = resolveCommandIntent({
      actorContext: UNKNOWN_ACTOR_CONTEXT,
      intent: { kind: 'terminal-run-force', command: 'complete', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: state(),
    });
    expect(outcome).toEqual({ kind: 'actor_context_required', intent: 'terminal-run-force' });
  });

  it('refuses a bare terminal force when the delegating run is collection pending', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'terminal-run-force', command: 'stop', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: stateWithReportedOutcome(),
    });
    expect(outcome.kind).toBe('delegation_collection_pending');
  });

  it('allows a bare terminal force through open delegated children (decision #2, force-through)', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'terminal-run-force', command: 'complete', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: state(),
      openClaims: [claimRecord()], // open_claims is NOT extended to terminal-run-force
    });
    expect(outcome.kind).toBe('allowed');
  });

  it('allows a targeted terminal force (claim path) unconditionally on the collection sub-gate', () => {
    const outcome = resolveCommandIntent({
      actorContext: verifiedRunContext(parentRunId),
      intent: { kind: 'terminal-run-force', command: 'complete', targeted: true },
      targetSelector: { kind: 'default' },
      targetState: stateWithReportedOutcome(),
    });
    expect(outcome.kind).toBe('allowed'); // targeted → collection-pending sub-gate skipped
  });
});

describe('deriveEffectiveRole', () => {
  it('treats a trusted controller of the target run as orchestrator', () => {
    const targetState = state();
    expect(deriveEffectiveRole(verifiedRunContext(targetState.id), targetState)).toBe(
      'orchestrator_for_target',
    );
  });

  it('treats a trusted controller of a different run as unknown for the target', () => {
    const targetState = state();
    expect(deriveEffectiveRole(verifiedRunContext(childRunId), targetState)).toBe(
      'delegated_relative_to_target',
    );
  });

  it('treats a claim controller of the target run as orchestrator', () => {
    const claimedRun = state({ id: childRunId });
    expect(deriveEffectiveRole(verifiedRunContext(childRunId), claimedRun)).toBe(
      'orchestrator_for_target',
    );
  });

  it('treats a claim controller of a different run as delegated relative to the target', () => {
    // A claim controller that does not control the target is delegated relative
    // to it — distinct from `unknown_for_target`, which carries no evidence at all.
    const targetState = state();
    expect(deriveEffectiveRole(verifiedRunContext(childRunId), targetState)).toBe(
      'delegated_relative_to_target',
    );
  });

  it('treats unknown actor evidence as unknown for the target', () => {
    expect(deriveEffectiveRole(UNKNOWN_ACTOR_CONTEXT, state())).toBe('unknown_for_target');
  });

  it('treats an absent target run as unknown for the target', () => {
    expect(deriveEffectiveRole(verifiedRunContext(parentRunId), undefined)).toBe(
      'unknown_for_target',
    );
  });
});
