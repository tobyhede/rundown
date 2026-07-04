import type { ClaimId } from './claim-id.js';
import type { DelegationExposure } from './delegation-exposure.js';
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
 * only trust-granting variants are `run_controller` (caller-named run
 * authority from an explicit `--run`), `claim` (reconstructable
 * claim-controller evidence), and `direct_cli` — the STANDALONE-run
 * convenience lane only: on any delegation-exposed target the only
 * trust-granting evidence is `run_controller` or `claim` ("everyone names
 * their authority").
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
 * The resolved target a caller's evidence is mapped against: the run's id and
 * its delegation exposure at decision time.
 *
 * The signature change to carry exposure is deliberately compile-breaking so
 * every call site must supply it — invalid states unrepresentable. Exposure
 * and target resolution may come from two separate lock-free reads; the id
 * binding through `deriveEffectiveRole` (trust minted for run A is
 * `unknown_for_target` against run B) is the fail-closed backstop for any
 * interleave, and implementations should classify from the same
 * `RunbookState` instance the resolver returns wherever it is already in
 * hand.
 */
export interface EvidenceTarget {
  /** Run the command targets. */
  readonly runId: RunId;
  /** The target run's delegation exposure, classified at decision time. */
  readonly exposure: DelegationExposure;
}

/**
 * Map typed caller evidence to a target-relative {@link ActorContext}.
 *
 * Core owns this mapping so that frontends never construct trust directly.
 * `direct_cli` is the STANDALONE-run convenience lane only: it yields a
 * trusted run controller for `target.runId` iff the target's exposure is
 * `standalone`; on any delegation-exposed target it yields
 * {@link UNKNOWN_ACTOR_CONTEXT} — the structural fix for #460 ("everyone
 * names their authority"). `run_controller` evidence yields a trusted run
 * controller for the evidence's own named `runId` (not the target —
 * `deriveEffectiveRole` refuses a mismatch with the resolved target, so a
 * wrong `--run` needs no special case here); `claim` evidence yields a claim
 * controller anchored on the evidence's own `controlledRunId`; every other
 * variant — including `plugin` and `mcp` regardless of the metadata they
 * carry — yields {@link UNKNOWN_ACTOR_CONTEXT}.
 *
 * @param evidence - Typed caller evidence supplied by a frontend
 * @param target - Resolved target run id plus its classified exposure
 * @returns The actor context core will evaluate against target-relative policy
 */
export function actorContextFromEvidence(
  evidence: CallerEvidence,
  target: EvidenceTarget,
): ActorContext {
  switch (evidence.kind) {
    case 'direct_cli':
      // The standalone convenience lane. On a delegation-exposed target the
      // ambient grant is gone — this arm is the structural fix for #460.
      return target.exposure === 'standalone'
        ? trustedRunControllerContext(target.runId)
        : UNKNOWN_ACTOR_CONTEXT;
    case 'run_controller':
      // Caller-named authority. deriveEffectiveRole refuses a mismatch with
      // the resolved target, so no target comparison happens here.
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
