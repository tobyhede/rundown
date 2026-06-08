import { buildFrameKey } from '../../src/runbook/targeting.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { SessionService } from '../../src/runbook/session-service.js';
import type { RunId } from '../../src/runbook/types.js';

/**
 * Build a delegation linkage for a parent run id, used for both child creation
 * and claiming. `fill` fills the delegation token hash (the char repeated 64
 * times); reuse the same `fill` for create + claim to keep the child's
 * persisted linkage matching the claim record, and vary it to diverge them.
 *
 * @param parentId - Parent run id the child is delegated from.
 * @param fill - Single character repeated to form the token hash.
 * @returns Delegation linkage accepted by SessionService.claimRunbook.
 */
export const linkageFor = (
  parentId: RunId,
  fill: string,
): Parameters<SessionService['claimRunbook']>[1] => ({
  kind: 'delegation' as const,
  parentRunId: parentId,
  parentStepId: '1.1',
  parentStep: '1',
  parentFrameKey: buildFrameKey('1'),
  parentEntry: 1,
  tokenHash: assertDelegationTokenHash(`sha256:${fill.repeat(64)}`),
});

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
