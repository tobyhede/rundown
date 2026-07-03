import type { ClaimId } from './claim-id.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { RunId } from './run-id.js';

/** Caller evidence supplied to core before evaluating target-relative command policy. */
export type ActorContext =
  | {
      /** Trusted controller of one concrete run. */
      readonly kind: 'trusted_run_controller';
      /** Run controlled by this caller. */
      readonly runId: RunId;
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
 * @returns Actor context for a target-relative trusted run controller
 */
export function trustedRunControllerContext(runId: RunId): ActorContext {
  return { kind: 'trusted_run_controller', runId };
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

/**
 * Typed caller evidence supplied by a frontend before core maps it to an
 * {@link ActorContext}.
 *
 * Frontends describe *who is calling and what they can prove*, never a final
 * actor context and never a bare source label. Source tagging is not a trust
 * mechanism: `plugin` and `mcp` evidence — including any agent id, session id,
 * or tool name they carry — never grants run-controller trust on its own. The
 * only trust-granting variants are `direct_cli` (the local direct CLI
 * compatibility lane), `claim` (reconstructable claim-controller evidence),
 * and `run_controller` (caller-named run authority from an explicit `--run`).
 *
 * Extend this envelope only when a frontend can supply real trusted controller
 * evidence; adding fields to `plugin` or `mcp` must not make them trusted by
 * themselves.
 */
export type CallerEvidence =
  | {
      /** Direct local CLI invocation eligible for run-controller compatibility. */
      readonly kind: 'direct_cli';
    }
  | {
      /**
       * Caller-named run authority from an explicit `--run <rd_…>` target;
       * trust-granting over the NAMED run only.
       */
      readonly kind: 'run_controller';
      /** Run the caller names as both its authority and its target. */
      readonly runId: RunId;
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
      /** Reconstructable claim-controller evidence for a delegated run. */
      readonly kind: 'claim';
      /** Claim id controlled by the caller. */
      readonly claimId: ClaimId;
      /** Token hash that identifies the claimed delegation attempt. */
      readonly tokenHash: DelegationTokenHash;
      /** Delegated run controlled by the caller. */
      readonly controlledRunId: RunId;
    }
  | {
      /** No trusted evidence was supplied. */
      readonly kind: 'unknown';
    };

/**
 * Map typed caller evidence to a target-relative {@link ActorContext}.
 *
 * Core owns this mapping so that frontends never construct trust directly.
 * `direct_cli` evidence yields a trusted run controller for `targetRunId`;
 * `run_controller` evidence yields a trusted run controller for the
 * evidence's own named `runId` (not `targetRunId` — `deriveEffectiveRole`
 * refuses a mismatch with the resolved target, so a wrong `--run` needs no
 * special case here); `claim` evidence yields a claim controller anchored on
 * the evidence's own `controlledRunId` (not `targetRunId`); every other
 * variant — including `plugin` and `mcp` regardless of the metadata they
 * carry — yields {@link UNKNOWN_ACTOR_CONTEXT}.
 *
 * @param evidence - Typed caller evidence supplied by a frontend
 * @param targetRunId - Run the command targets, used only for `direct_cli`
 * @returns The actor context core will evaluate against target-relative policy
 */
export function actorContextFromEvidence(
  evidence: CallerEvidence,
  targetRunId: RunId,
): ActorContext {
  switch (evidence.kind) {
    case 'direct_cli':
      return trustedRunControllerContext(targetRunId);
    case 'run_controller':
      return trustedRunControllerContext(evidence.runId);
    case 'claim':
      return claimControllerContext({
        claimId: evidence.claimId,
        tokenHash: evidence.tokenHash,
        controlledRunId: evidence.controlledRunId,
      });
    case 'plugin':
    case 'mcp':
    case 'unknown':
      return UNKNOWN_ACTOR_CONTEXT;
  }
}
