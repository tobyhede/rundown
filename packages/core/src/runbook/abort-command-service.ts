import type { ActorContext, CallerEvidence } from './actor-context.js';
import type {
  ClaimAuthorizationRequest,
  VerifiedClaim,
  VerifiedClaimAuthority,
} from './claim-id.js';
import type { DelegationPolicyOutcome } from './command-policy.js';
import { resolveMutationAuthority, type CommandTargetReader } from './command-target-resolver.js';
import type { RunbookState } from './types.js';

/**
 * Dependencies for the core abort command authorization seam.
 *
 * The seam only needs read access for claim verification and implicit singleton
 * lookup. The CLI remains responsible for token parsing, output formatting, and
 * lock ownership while it migrates to this seam.
 */
export interface AbortCommandServiceDependencies {
  /** Reader used to verify bearer claims and resolve implicit authority. */
  readonly targetReader: CommandTargetReader;
}

/**
 * Abort command authorization input.
 */
export interface AbortCommandAuthorizationInput {
  /** Caller evidence supplied by the frontend. */
  readonly callerEvidence: CallerEvidence;
  /** Target runbook state for the abort operation. */
  readonly targetState: RunbookState;
  /** Optional substep id when aborting a specific delegated frontier. */
  readonly stepId?: string;
}

/**
 * Verified abort authorization payload.
 */
export interface AuthorizedAbortCommand {
  /** Verified authority source. */
  readonly authority: VerifiedClaimAuthority;
  /** Shared verified claim payload. */
  readonly claim: VerifiedClaim;
  /** Exact request authorized by core. */
  readonly request: ClaimAuthorizationRequest;
  /** Verified actor context carrying the claim and authority source. */
  readonly actorContext: ActorContext;
}

/**
 * Abort authorization result.
 */
export type AbortCommandAuthorizationResult =
  | { readonly kind: 'authorized'; readonly authorization: AuthorizedAbortCommand }
  | { readonly kind: 'refused'; readonly policy: DelegationPolicyOutcome };

/**
 * Core-owned abort command authorization seam.
 */
export class AbortCommandService {
  readonly #deps: AbortCommandServiceDependencies;

  /**
   * Construct an abort command service from core dependencies.
   *
   * @param deps - Read-side dependencies used to verify claim authority.
   */
  constructor(deps: AbortCommandServiceDependencies) {
    this.#deps = deps;
  }

  /**
   * Resolve abort authorization for a target run.
   *
   * @param input - Caller evidence, target state, and optional substep id.
   * @returns Verified authority or a typed policy refusal.
   */
  async authorizeAbortCommand(
    input: AbortCommandAuthorizationInput,
  ): Promise<AbortCommandAuthorizationResult> {
    const request: ClaimAuthorizationRequest =
      input.stepId === undefined
        ? { action: 'abort-delegation', runId: input.targetState.id }
        : { action: 'abort-delegation', runId: input.targetState.id, stepId: input.stepId };
    const presentedClaimId =
      input.callerEvidence.kind === 'claim_bearer' ? input.callerEvidence.claimId : undefined;
    const authority = await resolveMutationAuthority({
      targetReader: this.#deps.targetReader,
      ...(presentedClaimId !== undefined ? { presentedClaimId } : {}),
      targetState: input.targetState,
      request,
    });
    if (authority.kind !== 'verified') {
      return {
        kind: 'refused',
        policy:
          presentedClaimId !== undefined && authority.reason === 'no-authorizing-claim'
            ? {
                kind: 'claim_grant_required',
                intent: 'delegation-issuance',
                targetRunId: input.targetState.id,
              }
            : { kind: 'actor_context_required', intent: 'delegation-issuance' },
      };
    }
    return {
      kind: 'authorized',
      authorization: {
        authority: authority.authority,
        claim: authority.claim,
        request,
        actorContext: {
          kind: 'verified_claim',
          authority: authority.authority,
          claim: authority.claim,
        },
      },
    };
  }
}
