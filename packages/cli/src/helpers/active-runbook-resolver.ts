import type {
  AgentOwnerIdentity,
  AgentRunbookOwnership,
  RunbookState,
  SessionService,
} from '@rundown-org/core';
import type { CallerIdentityResult } from './caller-identity.js';

/** Resolved active runbook target for a CLI caller. */
export type ActiveRunbookResolution =
  | {
      readonly kind: 'owned';
      readonly identity: AgentOwnerIdentity;
      readonly ownership: AgentRunbookOwnership;
      readonly state: RunbookState;
    }
  | { readonly kind: 'default'; readonly state: RunbookState }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'stale_owner';
      readonly identity: AgentOwnerIdentity;
      readonly ownership: AgentRunbookOwnership;
      readonly reason: 'missing-state' | 'not-running' | 'agent-mismatch';
      readonly message: string;
    }
  | { readonly kind: 'invalid_identity'; readonly message: string };

/**
 * Resolve the active runbook for a CLI caller, preferring caller-owned children.
 *
 * @param sessionService - Session service used to read owner-specific and default active targets
 * @param caller - Caller identity resolution from the CLI environment
 * @returns Discriminated active runbook resolution
 */
export async function resolveActiveRunbook(
  sessionService: SessionService,
  caller: CallerIdentityResult,
): Promise<ActiveRunbookResolution> {
  switch (caller.kind) {
    case 'invalid':
      return { kind: 'invalid_identity', message: caller.message };
    case 'identified': {
      const owned = await sessionService.getActiveForOwner(caller.identity);
      switch (owned.status) {
        case 'owned':
          return {
            kind: 'owned',
            identity: owned.identity,
            ownership: owned.ownership,
            state: owned.state,
          };
        case 'unowned':
          break;
        case 'stale':
          return {
            kind: 'stale_owner',
            identity: owned.identity,
            ownership: owned.ownership,
            reason: owned.reason,
            message: `Owned runbook ${owned.ownership.childRunId} is no longer active (${owned.reason}).`,
          };
        default: {
          const _exhaustive: never = owned;
          return _exhaustive;
        }
      }
      break;
    }
    case 'anonymous':
      break;
    default: {
      const _exhaustive: never = caller;
      return _exhaustive;
    }
  }

  const state = await sessionService.getActive();
  return state ? { kind: 'default', state } : { kind: 'none' };
}
