import type { ClaimId, VerifiedClaim, VerifiedClaimAuthority } from './claim-id.js';
import type { DelegationExposure } from './delegation-exposure.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';

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

/**
 * Build trusted run-controller actor context.
 *
 * @param _runId - Run id formerly treated as trusted authority.
 * @returns Unknown actor context; run identifiers no longer prove authority.
 */
export function trustedRunControllerContext(_runId: RunId): ActorContext {
  return UNKNOWN_ACTOR_CONTEXT;
}

/**
 * Build claim-controller actor context.
 *
 * @param _input - Former shape-only claim-controller evidence.
 * @param _input.claimId - Former claim id metadata.
 * @param _input.tokenHash - Former delegation token hash metadata.
 * @param _input.controlledRunId - Former controlled run metadata.
 * @returns Unknown actor context; shape-only claim data no longer proves authority.
 */
export function claimControllerContext(_input: {
  readonly claimId: ClaimId;
  readonly tokenHash: DelegationTokenHash;
  readonly controlledRunId: RunId;
}): ActorContext {
  return UNKNOWN_ACTOR_CONTEXT;
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
      /** Legacy direct CLI metadata; never sufficient for trust. */
      readonly kind: 'direct_cli';
    }
  | {
      /** Legacy run id metadata; never sufficient for trust. */
      readonly kind: 'run_controller';
      /** Run id formerly treated as authority. */
      readonly runId: RunId;
    }
  | {
      /** Legacy shape-only claim metadata; never sufficient for trust. */
      readonly kind: 'claim';
      /** Claim id metadata supplied by an old frontend. */
      readonly claimId: ClaimId;
      /** Delegation token hash metadata supplied by an old frontend. */
      readonly tokenHash: DelegationTokenHash;
      /** Controlled run id metadata supplied by an old frontend. */
      readonly controlledRunId: RunId;
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

/**
 * The resolved target a caller's evidence is mapped against.
 *
 * Frontend evidence no longer maps directly to trusted actor context. Core
 * services verify claim bearers and then call {@link verifiedClaimContext}.
 */
export interface EvidenceTarget {
  /** Run the command targets. */
  readonly runId: RunId;
  /** The target run's delegation exposure, classified at decision time. */
  readonly exposure: DelegationExposure;
}

/**
 * Map frontend evidence to actor context.
 *
 * @param _evidence - Typed caller evidence supplied by a frontend.
 * @param _target - Resolved target run id plus classified exposure.
 * @returns Unknown context. Core services must verify claim bearer evidence.
 */
export function actorContextFromEvidence(
  _evidence: CallerEvidence,
  _target?: EvidenceTarget,
): ActorContext {
  return UNKNOWN_ACTOR_CONTEXT;
}
