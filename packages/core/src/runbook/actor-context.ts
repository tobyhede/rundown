import type { ClaimId, VerifiedClaim, VerifiedClaimAuthority } from './claim-id.js';

/** Caller context after core has verified bearer claim proof. */
export type ActorContext =
  | {
      /** Verified claim bearer authorized by core session proof checks. */
      readonly kind: 'verified_claim';
      /** Source proving authority for this verified claim. */
      readonly authority: VerifiedClaimAuthority;
      /** Non-secret verified claim data and explicit grants. */
      readonly claim: VerifiedClaim;
    }
  | {
      /** No trusted actor evidence was supplied. */
      readonly kind: 'unknown';
    };

/**
 * Effective role after resolving actor evidence against one target run.
 *
 * Grant authorization is the policy boundary. This remains only for legacy
 * diagnostics and tests during the migration.
 */
export type EffectiveRole =
  | 'orchestrator_for_target'
  | 'delegated_relative_to_target'
  | 'unknown_for_target';

/** Shared singleton for strict inspect-only callers with no trusted evidence. */
export const UNKNOWN_ACTOR_CONTEXT: ActorContext = { kind: 'unknown' };

/**
 * Build verified-claim actor context from core-verified proof data.
 *
 * @param input - Verified claim context input.
 * @param input.authority - Source proving authority for this verified claim.
 * @param input.claim - Verified non-secret claim data and grants.
 * @returns Actor context carrying verified claim authority.
 */
export function verifiedClaimContext(input: {
  readonly authority: VerifiedClaimAuthority;
  readonly claim: VerifiedClaim;
}): ActorContext {
  return { kind: 'verified_claim', authority: input.authority, claim: input.claim };
}

/** Typed caller evidence supplied by a frontend before core verifies claim proof. */
export type CallerEvidence =
  | {
      /** Bearer claim evidence supplied by the caller. */
      readonly kind: 'claim_bearer';
      /** Bearer claim id to verify in core. */
      readonly claimId: ClaimId;
    }
  | {
      /** Bare direct CLI metadata; never sufficient for trust. */
      readonly kind: 'direct_cli';
    }
  | {
      /** Claude Code plugin subprocess; metadata is descriptive only. */
      readonly kind: 'plugin';
      /** Optional plugin agent id; never sufficient for trust. */
      readonly agentId?: string;
      /** Optional plugin session id; never sufficient for trust. */
      readonly sessionId?: string;
    }
  | {
      /** MCP server subprocess; metadata is descriptive only. */
      readonly kind: 'mcp';
      /** Optional MCP tool name; never sufficient for trust. */
      readonly toolName?: string;
    }
  | {
      /** No trusted evidence was supplied. */
      readonly kind: 'unknown';
    };
