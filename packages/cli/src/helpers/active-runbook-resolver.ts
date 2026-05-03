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
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @param options.allowStashed - When true, stashed claimed children resolve as
 *   `claim` (read-only inspection paths set this); when false (default), they
 *   resolve as `stale_claim` so write commands refuse to operate on a parked
 *   runbook and the user must `rd pop --claim-id` to resume.
 * @returns Discriminated active runbook resolution
 */
export async function resolveActiveRunbook(
  sessionService: SessionService,
  options: { readonly claimId?: ClaimId; readonly allowStashed?: boolean } = {},
): Promise<ActiveRunbookResolution> {
  if (options.claimId !== undefined) {
    const claimed = await sessionService.getActiveForClaimId(options.claimId, {
      includeStashed: options.allowStashed === true,
    });
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
        if (claimed.reason === 'stashed') {
          return {
            kind: 'stale_claim',
            claimId: options.claimId,
            message: `Claim id ${options.claimId} is currently stashed. Run \`rd pop --claim-id ${options.claimId}\` to resume.`,
          };
        }
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
