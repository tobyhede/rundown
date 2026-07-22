import { buildFrameKey } from '../../src/runbook/targeting.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { SessionService } from '../../src/runbook/session-service.js';
import type { RunbookStateManager } from '../../src/runbook/state.js';
import type { ClaimRunbookResult } from '../../src/runbook/claim-id.js';
import type { SessionMutationResult } from '../../src/runbook/storage/runbook-store.js';
import type { DelegationLinkage, RunId, SubstepState } from '../../src/runbook/types.js';
import { makeStepDelegation } from '../helpers/step-factories.js';

/**
 * Build a delegation linkage for a parent run id, used for both child creation
 * and claiming. `fill` fills the delegation token hash (the char repeated 64
 * times); reuse the same `fill` for create + claim to keep the child's
 * persisted linkage matching the claim record, and vary it to diverge them.
 *
 * @param parentId - Parent run id the child is delegated from.
 * @param fill - Single character repeated to form the token hash.
 * @param parentStepId - Substep id the delegation occupies in the parent frame.
 *   Defaults to `'1.1'`; sibling delegations under one parent must pass distinct
 *   ids so each occupies its own live substep slot.
 * @returns Delegation linkage accepted by SessionService.claimRunbook.
 */
export const linkageFor = (
  parentId: RunId,
  fill: string,
  parentStepId = '1.1',
): Parameters<SessionService['claimRunbook']>[1] => ({
  kind: 'delegation' as const,
  parentRunId: parentId,
  parentStepId,
  parentStep: '1',
  parentFrameKey: buildFrameKey('1'),
  parentEntry: 1,
  tokenHash: assertDelegationTokenHash(`sha256:${fill.repeat(64)}`),
});

/**
 * Seed the parent so the delegation described by `linkage` is live.
 *
 * The R2 claim-side latch refuses a claim unless the parent carries a live
 * delegation substep matching the incoming linkage — exactly what a real
 * delegation writes. Synthetic-linkage fixtures never set that up, so this
 * upserts the matching substep (merging with any siblings already seeded) with
 * the linkage's token. A parent that does not exist is left untouched, so a
 * test can still exercise the parent-unreadable path.
 *
 * @param manager - State manager owning the parent run.
 * @param linkage - Delegation linkage whose parent-side substep to seed.
 */
export async function seedLiveDelegation(
  manager: RunbookStateManager,
  linkage: DelegationLinkage,
): Promise<void> {
  const parent = await manager.load(linkage.parentRunId);
  if (!parent) {
    return;
  }
  const existing = parent.substepStates ?? [];
  const substep: SubstepState = {
    id: linkage.parentStepId,
    frameKey: linkage.parentFrameKey,
    status: 'running',
    delegation: makeStepDelegation({ tokenHash: linkage.tokenHash }),
  };
  const merged = [
    ...existing.filter(
      (s) => !(s.id === linkage.parentStepId && s.frameKey === linkage.parentFrameKey),
    ),
    substep,
  ];
  await manager.update(linkage.parentRunId, { substepStates: merged });
}

/**
 * Seed a live delegation on the parent, then claim it — the faithful fixture
 * equivalent of a real delegate-then-claim flow. Intended refusals downstream
 * of the parent-liveness gate (terminal child, linkage mismatch, missing child)
 * still surface, because the gate passes for a live parent.
 *
 * @param sessionService - Service under test.
 * @param manager - State manager owning the parent run.
 * @param childRunId - Child run being claimed.
 * @param linkage - Delegation linkage to seed and claim.
 * @returns The claim result.
 */
export async function claimLiveDelegation(
  sessionService: SessionService,
  manager: RunbookStateManager,
  childRunId: RunId,
  linkage: DelegationLinkage,
): Promise<ClaimRunbookResult> {
  await seedLiveDelegation(manager, linkage);
  return unwrapSessionMutation(await sessionService.claimRunbook(childRunId, linkage));
}

/**
 * Unwrap a committed session mutation in tests whose setup cannot be owned.
 *
 * @template T - Domain value carried by the committed arm.
 * @param result - Session mutation result to narrow.
 * @returns The committed domain value.
 * @throws {Error} When a fixture unexpectedly encounters an ownership refusal.
 */
export function unwrapSessionMutation<T>(result: SessionMutationResult<T>): T {
  if (result.status !== 'committed') {
    throw new Error(`Unexpected ${result.status} for ${result.runId}: ${result.message}`);
  }
  return result.value;
}

const isClaimed = <T extends { status: string }>(
  result: T,
): result is Extract<T, { status: 'claimed' }> => result.status === 'claimed';

/**
 * Narrow a claim result to the `claimed` variant or throw.
 *
 * @param result - Result returned by SessionService.claimRunbook.
 * @returns The same result narrowed to `status: 'claimed'`.
 * @throws {Error} when the result is not a successful claim.
 */
export const assertClaimed = <T extends { status: string }>(
  result: T,
): Extract<T, { status: 'claimed' }> => {
  if (!isClaimed(result)) {
    throw new Error(`Expected claim result, got status=${result.status}`);
  }
  return result;
};
