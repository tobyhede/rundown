import type { ClaimId, ClaimRecord, RunbookState, SessionService } from '@rundown-org/core';

/** Resolved active runbook target for a CLI command. */
export type ActiveRunbookResolution =
  | {
      readonly kind: 'claim';
      readonly claimId: ClaimId;
      readonly claim: ClaimRecord;
      readonly state: RunbookState;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string };

/**
 * Resolve the active runbook for a command, preferring explicit claim-id targeting.
 *
 * @param sessionService - Session service used to read claim and default active targets
 * @param options - Optional explicit claim-id target
 * @returns Discriminated active runbook resolution
 */
export async function resolveActiveRunbook(
  sessionService: SessionService,
  options: { readonly claimId?: ClaimId } = {},
): Promise<ActiveRunbookResolution> {
  if (options.claimId !== undefined) {
    const claimed = await sessionService.getActiveForClaimId(options.claimId);
    switch (claimed.status) {
      case 'claimed':
        return {
          kind: 'claim',
          claimId: options.claimId,
          claim: claimed.claim,
          state: claimed.state,
        };
      case 'missing':
        return {
          kind: 'stale_claim',
          claimId: options.claimId,
          message: `Claim id ${options.claimId} does not exist.`,
        };
      case 'stale':
        return {
          kind: 'stale_claim',
          claimId: options.claimId,
          message: `Claim id ${options.claimId} points at missing child state (${claimed.reason}).`,
        };
      case 'terminal':
        return {
          kind: 'stale_claim',
          claimId: options.claimId,
          message: `Claim id ${options.claimId} points at a ${claimed.lifecycle} child runbook.`,
        };
      case 'unlinked':
        return {
          kind: 'stale_claim',
          claimId: options.claimId,
          message: `Claim id ${options.claimId} is no longer linked to an active delegation (${claimed.reason}).`,
        };
      default: {
        const _exhaustive: never = claimed;
        return _exhaustive;
      }
    }
  }

  const state = await sessionService.getActive();
  return state ? { kind: 'default', state } : { kind: 'none' };
}
