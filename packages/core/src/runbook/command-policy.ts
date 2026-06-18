import type { ActorContext, EffectiveRole } from './actor-context.js';
import type { ClaimId, ClaimRecord } from './claim-id.js';
import {
  type DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
import type { RunId } from './run-id.js';
import type { RunbookState } from './types.js';

/** Command intent categories owned by core command policy. */
export type CommandIntent =
  | {
      /** Inspect-only command intent. */
      readonly kind: 'inspect';
    }
  | {
      /** Bare or targeted pass/fail that may advance a delegating run. */
      readonly kind: 'delegating-run-advance';
      /** Transition command being evaluated. */
      readonly command: 'pass' | 'fail';
      /** True when the caller supplied an explicit target such as `--step` or `--claim-id`. */
      readonly targeted: boolean;
    }
  | {
      /** Delegate command issuing or reissuing delegation from a run. */
      readonly kind: 'delegation-issuance';
      /** Command name retained for frontend details. */
      readonly command: 'delegate';
      /** True when the caller supplied an explicit step or retry target. */
      readonly targeted: boolean;
    }
  | {
      /** Collect command applying reported delegation outcomes. */
      readonly kind: 'delegation-collection';
    };

/** Target selector shape parsed by a frontend before core policy evaluation. */
export type CommandTargetSelector =
  | {
      /** Default active run target. */
      readonly kind: 'default';
    }
  | {
      /** Explicit claim-id target selector. */
      readonly kind: 'claim';
      /** Claim id supplied by the caller. */
      readonly claimId: ClaimId;
    }
  | {
      /** Explicit step/scope target selector. */
      readonly kind: 'explicit-step';
      /** Step id supplied by the caller. */
      readonly step: string;
    };

/** Input to the core command-policy decision point. */
export interface ResolveCommandIntentInput {
  /** Caller evidence supplied by the frontend or integration boundary. */
  readonly actorContext: ActorContext;
  /** Domain command intent. */
  readonly intent: CommandIntent;
  /** Parsed target selector. */
  readonly targetSelector: CommandTargetSelector;
  /** Resolved target run, when the selector resolves to one. */
  readonly targetState?: RunbookState;
  /** Open claimed children for the target run, when already known. */
  readonly openClaims?: readonly ClaimRecord[];
}

/**
 * Core-owned policy decision consumed by CLI, MCP, and plugin adapters.
 *
 * This is a deliberate SUBSET of the spec's 12-member `DelegationPolicyOutcome`
 * union (spec lines 366-380). This slice implements only the members reachable
 * from the policy decisions it gates: `allowed`, `actor_context_required`,
 * `collect_requires_orchestrator`, `delegation_collection_pending`, and
 * `open_claims`. The collection-operation members (`missing_outcomes`,
 * `already_collected`) are deferred to Plan 4 (Core Collection Operation); the
 * claim/terminal members (`stale_claim`, `terminal_claim_confirmed`,
 * `terminal_claim_conflict`) and `not_delegatable` are deferred to the
 * collection/claim plans (Plan 4 / Plan 5). `target_not_delegating_scope` from
 * the spec is intentionally NOT implemented here: under the target-relative
 * model a run delegating upward is still a valid collection target, so the
 * orchestrator check is the only gate this slice needs. See the Self-Review
 * Notes for the full deferral list.
 */
export type DelegationPolicyOutcome =
  | {
      /** Policy allowed the command. */
      readonly kind: 'allowed';
      /** Effective role used for the allow decision. */
      readonly role: EffectiveRole;
      /** Target run id, when the command targets a run. */
      readonly targetRunId?: RunId;
    }
  | {
      /** Caller evidence is required for this role-specific mutation. */
      readonly kind: 'actor_context_required';
      /** Intent that was refused. */
      readonly intent: CommandIntent['kind'];
    }
  | {
      /** Caller is not the effective orchestrator for the collection target. */
      readonly kind: 'collect_requires_orchestrator';
      /** Target run the caller attempted to collect into. */
      readonly targetRunId: RunId;
    }
  | {
      /** Bare mutation is blocked by unconsumed reported delegation outcomes. */
      readonly kind: 'delegation_collection_pending';
      /** Delegating run that must be collected. */
      readonly parentRunId: RunId;
      /** Completion keys for reported outcomes blocking the command. */
      readonly outcomeCompletionKeys: readonly string[];
      /** Operator-facing guidance for frontend error rendering. */
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /** Bare mutation is blocked by active claimed children. */
      readonly kind: 'open_claims';
      /** Delegating run with open claims. */
      readonly parentRunId: RunId;
      /** Open claim records blocking the command. */
      readonly claims: readonly ClaimRecord[];
    };

/**
 * Derive effective role from actor evidence and a resolved target run.
 *
 * @param actorContext - Caller evidence
 * @param targetState - Resolved target run state
 * @returns Target-relative effective role
 */
export function deriveEffectiveRole(
  actorContext: ActorContext,
  targetState: RunbookState | undefined,
): EffectiveRole {
  if (!targetState || actorContext.kind === 'unknown') {
    return 'unknown_for_target';
  }
  if (actorContext.kind === 'trusted_run_controller') {
    return actorContext.runId === targetState.id ? 'orchestrator_for_target' : 'unknown_for_target';
  }
  return actorContext.controlledRunId === targetState.id
    ? 'orchestrator_for_target'
    : 'delegated_relative_to_target';
}

function allowed(
  role: EffectiveRole,
  targetState: RunbookState | undefined,
): DelegationPolicyOutcome {
  return {
    kind: 'allowed',
    role,
    ...(targetState ? { targetRunId: targetState.id } : {}),
  };
}

function requireOrchestratorForCollection(
  role: EffectiveRole,
  intent: CommandIntent,
  targetState: RunbookState | undefined,
): DelegationPolicyOutcome | undefined {
  if (role === 'orchestrator_for_target') return undefined;
  if (role === 'unknown_for_target' || !targetState) {
    return { kind: 'actor_context_required', intent: intent.kind };
  }
  return {
    kind: 'collect_requires_orchestrator',
    targetRunId: targetState.id,
  };
}

function rejectBareMutationIfCollectionPending(
  input: ResolveCommandIntentInput,
): DelegationPolicyOutcome | undefined {
  if (!input.targetState) return undefined;
  if (
    input.intent.kind !== 'delegating-run-advance' &&
    input.intent.kind !== 'delegation-issuance'
  ) {
    return undefined;
  }
  if (input.intent.targeted) return undefined;

  const pending = readDelegationCollectionPendingForPolicy(input.targetState);
  if (!pending.pending) return undefined;

  return {
    kind: 'delegation_collection_pending',
    parentRunId: pending.parentRunId,
    outcomeCompletionKeys: pending.outcomes.map((outcome) => outcome.completionKey),
    message: pending.message,
  };
}

/**
 * Resolve a command intent into a core-owned delegation policy outcome.
 *
 * @param input - Actor context, command intent, target selector, target state,
 *   and optional open-claim state
 * @returns Typed policy outcome for frontend adapters to render
 */
export function resolveCommandIntent(input: ResolveCommandIntentInput): DelegationPolicyOutcome {
  const role = deriveEffectiveRole(input.actorContext, input.targetState);

  if (input.intent.kind === 'inspect') {
    return allowed(role, input.targetState);
  }

  if (input.intent.kind === 'delegation-collection') {
    // The claim selector itself is NOT a rejection trigger (spec lines 345-348,
    // 674-676): the frontend resolves `--claim-id` to its claimed/controlled run
    // and passes that as `targetState`, so role derivation above already treats
    // the resolved claimed run as the target. The only gate here is the
    // orchestrator-for-target check.
    //
    // A target run delegating UPWARD (`parentLinkage.kind === 'delegation'`)
    // does NOT by itself disqualify it as a collection target: a middle
    // claim-controller may collect delegations issued by the run it controls
    // (spec lines 357-359). Whether outcomes actually exist to collect is the
    // collection operation's concern (Plan 4), not this policy slice. So there
    // is no `target_not_delegating_scope` rejection here.
    const orchestratorFailure = requireOrchestratorForCollection(
      role,
      input.intent,
      input.targetState,
    );
    if (orchestratorFailure) return orchestratorFailure;
    return allowed(role, input.targetState);
  }

  if (role === 'unknown_for_target') {
    return { kind: 'actor_context_required', intent: input.intent.kind };
  }

  const pendingFailure = rejectBareMutationIfCollectionPending(input);
  if (pendingFailure) return pendingFailure;

  if (
    input.intent.kind === 'delegating-run-advance' &&
    !input.intent.targeted &&
    input.openClaims &&
    input.openClaims.length > 0 &&
    input.targetState
  ) {
    return {
      kind: 'open_claims',
      parentRunId: input.targetState.id,
      claims: input.openClaims,
    };
  }

  return allowed(role, input.targetState);
}
