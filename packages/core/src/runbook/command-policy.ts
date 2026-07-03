import type { ActorContext, EffectiveRole } from './actor-context.js';
import type { ClaimId, ClaimRecord } from './claim-id.js';
import {
  type DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
import type { RunId } from './run-id.js';
import type { FrameKey } from './targeting.js';
import type { RunbookState } from './types.js';
import type { ExecutionObservationEffect } from '../events/execution-observation.js';
import type { TransitionObservationEvent } from '../events/transition-observation.js';

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
      /** Delegation command being evaluated. */
      readonly command: 'delegate';
      /** True when the caller supplied an explicit step or retry target. */
      readonly targeted: boolean;
    }
  | {
      /** Bare or claim-targeted complete/stop forcing a run terminal. */
      readonly kind: 'terminal-run-force';
      /** Terminal command being evaluated. */
      readonly command: 'complete' | 'stop';
      /** True when the caller supplied an explicit `--claim-id` target. */
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
    }
  | {
      /** Explicit run-id target selector from `--run <rd_…>`. */
      readonly kind: 'run';
      /** Run id supplied by the caller as both target and named authority. */
      readonly runId: RunId;
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
 * This is NOT a pure subset of the spec's `DelegationPolicyOutcome` union (spec
 * lines 403-416): it is a subset of the spec's claim/terminal members AND a
 * superset on collection-operation members. Implemented: `allowed`,
 * `actor_context_required`, `collect_requires_orchestrator`,
 * `delegation_collection_pending`, `open_claims`, plus the collection-operation
 * members added by Plan 4 (Core Collection Operation) that the spec union does
 * not list: `missing_outcomes`, `already_collected`, `collection_frame_not_active`,
 * `collection_applied`, and `collection_failed`. The spec's claim/terminal
 * members (`stale_claim`, `terminal_claim_confirmed`, `terminal_claim_conflict`)
 * and `not_delegatable` are absent here not because they are deferred, but
 * because they are modeled in purpose-built sibling types: claim-target
 * resolution lives in `CommandTargetResolution` (`command-target-resolver.ts`)
 * and whether a run can be delegated is reported by the delegation-service
 * result (`delegation-service.ts`). They are intentionally kept out of this union.
 * `target_not_delegating_scope` from the spec is intentionally NOT implemented
 * here: under the target-relative model a run delegating upward is still a valid
 * collection target, so the orchestrator check is the only gate this slice needs.
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
    }
  | {
      /** Collection target has delegation substeps without reported outcomes. */
      readonly kind: 'missing_outcomes';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Delegated substep ids still lacking delegation outcomes. */
      readonly missingSubsteps: readonly string[];
    }
  | {
      /** Collection found no unapplied outcomes for the selected scope. */
      readonly kind: 'already_collected';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
    }
  | {
      /**
       * Requested frame is not the cursor's active frame. Drain was
       * observation-only and applied nothing. This is a DISTINCT variant from
       * `already_collected` because the CLI must render the existing
       * `not-active` JSON payload faithfully (status string `not-active`,
       * carrying `frameKey` / `activeFrameKey` / `unresolved`) — folding it into
       * `already_collected` (rendered `already-aggregated`) would break the
       * asserted `not-active` contract. The carried fields mirror drain's
       * `not_active` result.
       */
      readonly kind: 'collection_frame_not_active';
      /** Target run that was inspected. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Frame key requested via the scope/frame override. */
      readonly frameKey: FrameKey;
      /** Frame key the target run cursor is actually positioned on. */
      readonly activeFrameKey: FrameKey;
      /** Count of substeps still without a persisted delegation outcome. */
      readonly unresolved: number;
    }
  | {
      /** Collection applied one or more delegation outcomes. */
      readonly kind: 'collection_applied';
      /** Target run that received the collected outcomes. */
      readonly targetRunId: RunId;
      /** Step selected for collection. */
      readonly step: string;
      /** Number of delegation outcomes consumed. */
      readonly applied: number;
      /** Number of outcomes still unresolved after this collection. */
      readonly unresolved: number;
      /** Lifecycle of the target run after collection. */
      readonly lifecycle: RunbookState['lifecycle'];
      /** True when collection reported this run's terminal delegation outcome upward. */
      readonly reportedTerminalOutcome: boolean;
      /**
       * Ordered transition observations projected from the applied collection
       * transitions. This is an in-memory command outcome only; it is never
       * persisted into `.rundown/runs/`.
       */
      readonly transitionObservations: readonly TransitionObservationEvent[];
      /**
       * Set when collection drove a RETRY re-entry into a DELEGATE frontier.
       * Carries the projected STEP_ENTERED observation(s) with fresh delegation
       * tokens. Present only after the one-shot frontier was consumed.
       */
      readonly reEntryObservations?: readonly ExecutionObservationEffect[];
    }
  | {
      /** Collection failed after core rejected a persisted delegation outcome. */
      readonly kind: 'collection_failed';
      /** Target run that was being collected. */
      readonly targetRunId: RunId;
      /**
       * Machine/core reason. Every member has a real producer (no dead arms):
       * - `not_delegate_step` — `collectDelegationOutcomes` non-DELEGATE-step guard
       * - `step_not_found` — `collectDelegationOutcomes` stale-state guard
       * - `target_mismatch` — `drainResolvedCompletions` `status: 'failed'`
       *   (CompletionTargetMismatch.reason is the only drain failure reason).
       * - `frontier_consume_failed` — collect projected a retry re-entry
       *   frontier but failed to sync `DELEGATE_FRONTIER_CONSUMED`, so no
       *   frontier observations were returned.
       *   There is NO `state_error` reason; drain never produces one.
       */
      readonly reason:
        | 'target_mismatch'
        | 'not_delegate_step'
        | 'step_not_found'
        | 'frontier_consume_failed';
      /**
       * User-facing error code, attached by core so the CLI renders a flat
       * passthrough (no CLI reason→code ternary — keeps "no CLI lifecycle
       * decisions" and type-driven dispatch intact):
       * - `not_delegate_step` → `NOT_DELEGATE_STEP`
       * - `step_not_found` → `STEP_NOT_FOUND`
       * - `target_mismatch` / `frontier_consume_failed` → `COLLECT_OPERATION_FAILED`
       */
      readonly code: 'NOT_DELEGATE_STEP' | 'STEP_NOT_FOUND' | 'COLLECT_OPERATION_FAILED';
      /** Operator-facing failure message. */
      readonly message: string;
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
    input.intent.kind !== 'delegation-issuance' &&
    input.intent.kind !== 'terminal-run-force'
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
    // The claim selector itself is NOT a rejection trigger: the frontend
    // resolves `--claim-id` to its claimed/controlled run and passes that as
    // `targetState`, so role derivation above already treats the resolved
    // claimed run as the target. A target run delegating upward does not
    // disqualify it either (a middle claim-controller may collect delegations
    // issued by the run it controls). The only gate here is the
    // orchestrator-for-target check.
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
