import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  assertRunId,
  buildFrameKey,
  claimControllerContext,
  deriveEffectiveRole,
  resolveCommandIntent,
  trustedRunControllerContext,
  UNKNOWN_ACTOR_CONTEXT,
  type ActorContext,
  type CommandIntent,
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

const actorContextArb: fc.Arbitrary<ActorContext> = fc.oneof(
  fc.constant(UNKNOWN_ACTOR_CONTEXT),
  fc.constantFrom(runIdA, runIdB).map((id) => trustedRunControllerContext(id, 'direct-cli')),
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
    fc.assert(
      fc.property(targeted, (intent) => {
        expect(
          resolveCommandIntent({
            actorContext: trustedRunControllerContext(runIdA, 'direct-cli'),
            intent,
            targetSelector: { kind: 'explicit-step', step: '1.1' },
            targetState: baseState(),
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
});
