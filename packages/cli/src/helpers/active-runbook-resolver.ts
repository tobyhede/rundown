import type {
  AgentOwnerIdentity,
  AgentRunbookOwnership,
  RunbookState,
  SessionService,
} from '@rundown-org/core';
import type { CallerIdentityResult } from './caller-identity.js';

/**
 * Resolved active runbook target for a CLI caller.
 *
 * CLI-facing wrapper around the core {@link OwnedRunbookResolution} that adds
 * `default` (anonymous default-stack target) and `invalid_identity`
 * (env-var validation failure) variants. Use the core type for service-level
 * ownership semantics; use this type for CLI command dispatch.
 *
 * @see OwnedRunbookResolution from `@rundown-org/core`
 */
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
          // Identified callers must claim their own runbook — never fall through to
          // the default stack, which belongs to anonymous/parent callers.
          return { kind: 'none' };
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
    }
    case 'anonymous': {
      const state = await sessionService.getActive();
      return state ? { kind: 'default', state } : { kind: 'none' };
    }
    default: {
      const _exhaustive: never = caller;
      return _exhaustive;
    }
  }
}
