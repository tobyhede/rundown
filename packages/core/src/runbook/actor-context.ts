import type { ClaimId } from './claim-id.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';

/** Frontend or integration source that supplied trusted run-controller evidence. */
export type ActorContextSource = 'direct-cli' | 'plugin' | 'mcp';

/** Caller evidence supplied to core before evaluating target-relative command policy. */
export type ActorContext =
  | {
      /** Trusted controller of one concrete run. */
      readonly kind: 'trusted_run_controller';
      /** Run controlled by this caller. */
      readonly runId: RunId;
      /** Frontend or integration source that supplied the controller evidence. */
      readonly source: ActorContextSource;
    }
  | {
      /** Controller of a claimed delegated run. */
      readonly kind: 'claim_controller';
      /** Claim id that binds the caller to the controlled run. */
      readonly claimId: ClaimId;
      /** Token hash that identifies the claimed delegation attempt. */
      readonly tokenHash: DelegationTokenHash;
      /** Delegated run controlled by this caller. */
      readonly controlledRunId: RunId;
    }
  | {
      /** No trusted actor evidence was supplied. */
      readonly kind: 'unknown';
    };

/**
 * Effective role after resolving actor evidence against one target run.
 *
 * - `orchestrator_for_target`: the caller controls the target run itself and may
 *   orchestrate it (collect, advance).
 * - `delegated_relative_to_target`: the caller controls a different run that is
 *   delegated relative to the target, not the target itself.
 * - `unknown_for_target`: no trusted evidence ties the caller to the target.
 */
export type EffectiveRole =
  | 'orchestrator_for_target'
  | 'delegated_relative_to_target'
  | 'unknown_for_target';

/** Shared singleton for strict inspect-only callers with no trusted evidence. */
export const UNKNOWN_ACTOR_CONTEXT: ActorContext = { kind: 'unknown' };

/**
 * Build trusted run-controller actor context.
 *
 * @param runId - Run controlled by the caller
 * @param source - Frontend or integration source that supplied this evidence
 * @returns Actor context for a target-relative trusted run controller
 */
export function trustedRunControllerContext(
  runId: RunId,
  source: ActorContextSource,
): ActorContext {
  return { kind: 'trusted_run_controller', runId, source };
}

/**
 * Build claim-controller actor context.
 *
 * @param input - Claim-controller evidence
 * @param input.claimId - Claim id controlled by the caller
 * @param input.tokenHash - Token hash for the claim
 * @param input.controlledRunId - Delegated run controlled by the caller
 * @returns Actor context for a claim controller
 */
export function claimControllerContext(input: {
  readonly claimId: ClaimId;
  readonly tokenHash: DelegationTokenHash;
  readonly controlledRunId: RunId;
}): ActorContext {
  return {
    kind: 'claim_controller',
    claimId: input.claimId,
    tokenHash: input.tokenHash,
    controlledRunId: input.controlledRunId,
  };
}
