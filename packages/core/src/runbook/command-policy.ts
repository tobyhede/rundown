import type { ActorContext, EffectiveRole } from './actor-context.js';
import {
  authorizeClaim,
  type ClaimAuthorizationRequest,
  type ClaimId,
  type ClaimRecord,
} from './claim-id.js';
import type { DelegationRuntimeCapabilities } from './delegation-credential.js';
import {
  type DELEGATION_COLLECTION_PENDING_MESSAGE,
  readDelegationCollectionPendingForPolicy,
} from './delegation-lifecycle-read-model.js';
import type { InlineUpwardPropagationResult } from './inline-parent-advance.js';
import type { RunId } from './run-id.js';
import type { AbandonedAttemptSetOutcome } from './storage/execution-lease.js';
import type { GuardedMutationResult } from './storage/mutation-result.js';
import type { FrameKey } from './targeting.js';
import type { RunbookState } from './types.js';
import type { ErrorCodes } from '../errors/codes.js';
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
      /** Retry command reissuing a delegation from a run. */
      readonly kind: 'delegation-issuance';
      /** Delegation retry command being evaluated. */
      readonly command: 'retry';
      /** Retry always targets a concrete delegation step. */
      readonly targeted: true;
      /** Concrete delegation step id being retried. */
      readonly stepId: string;
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
    }
  | {
      /**
       * Goto navigating a run's cursor. Role-gated like an advance (unknown
       * callers are refused), but exempt from the collection-pending and
       * open-claims guards: navigation is operator control flow, not
       * completion — it consumes no reported outcomes and closes no claims.
       */
      readonly kind: 'run-navigation';
      /** Navigation command being evaluated. */
      readonly command: 'goto';
      /** True when the caller supplied an explicit target. */
      readonly targeted: boolean;
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
      /** Run id supplied by the caller as target selection only. */
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
 * `actor_context_required`, `claim_grant_required`,
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
      /** Verified claim lacks the exact grant required for the mutation. */
      readonly kind: 'claim_grant_required';
      /** Intent that was refused. */
      readonly intent: CommandIntent['kind'];
      /** Target run that needed authorization, when known. */
      readonly targetRunId?: RunId;
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
      /**
       * The subset of `missingSubsteps` whose outcome WAS reported, under a
       * frame entry the collection scope has since left.
       *
       * Missing splits into two situations with different remedies, and the
       * refusal is a wall unless it says which one it is (#749): a substep that
       * never reported is waiting on its child, while one stranded by a
       * RETRY/GOTO re-entry will never resolve on its own — the row is
       * unreachable for the drain, and `rundown delegate --retry` is what clears
       * it and re-issues the substep. Empty when every missing substep is simply
       * still in flight.
       */
      readonly supersededSubsteps: readonly string[];
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
       * Set only when a terminal collect target carried INLINE linkage and the
       * seam advanced its composing parent. Carries the inline-advance outcome so
       * the CLI can map it to an exit code via `inlineAdvanceRequiresFailureExit`,
       * and — on the `linkage-cycle` arm — the trip naming the run to prune, which
       * the CLI renders before collapsing it fail-closed (#603). Undefined for
       * delegation targets and non-linked targets. In-memory command outcome only
       * — never persisted.
       */
      readonly terminalInlineAdvance?: InlineUpwardPropagationResult;
      /**
       * Ordered transition observations projected from the applied collection
       * transitions. This is an in-memory command outcome only; it is never
       * persisted into the SQLite run state.
       */
      readonly transitionObservations: readonly TransitionObservationEvent[];
      /**
       * Set when collection drove a RETRY re-entry into a DELEGATE frontier.
       * Carries the projected STEP_ENTERED observation(s) with fresh delegation
       * tokens. Present only after the one-shot frontier was consumed.
       */
      readonly reEntryObservations?: readonly ExecutionObservationEffect[];
      /**
       * Verified collector-bound delegation capabilities for the continuation
       * the frontend drives next. Collection can leave the target run standing
       * one transition short of a DELEGATE step, and machine-owned issuance needs
       * a verified issuer at that moment; without one the continuation is refused
       * `actor_context_required` rather than advanced. The following turn then
       * projects the frontier that issuance stored, which needs the same-issuer
       * deriver — a descriptor naming a different issuer claim is refused RD-821.
       *
       * The two travel as ONE branded value rather than two optional fields
       * precisely because they are two halves of one authority: the bearer
       * holding `collect-for-run` over `targetRunId`, which is a run-control
       * claim and therefore also holds `delegate-from-run` over it. Only
       * `delegationRuntimeCapabilities` can produce the value, so the pairing is
       * established by construction and a consumer cannot forward one half alone.
       *
       * Runtime-only, and set only on a non-terminal (`running`) outcome: a
       * closure cannot be serialised, and must never reach persisted context, a
       * snapshot, or a diagnostic (CLAUDE.md § Actor dependencies).
       */
      readonly delegationRuntime?: DelegationRuntimeCapabilities;
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
       * - `target_mismatch` — `prepareResolvedCompletionDrain` `status: 'failed'`
       *   (CompletionTargetMismatch.reason is the only drain failure reason).
       * - `frontier_projection_refused` — the verified collector cannot derive
       *   the persisted frontier or the derived bearer does not match its hash.
       *   There is NO `state_error` reason; the drain never produces one.
       *
       * `frontier_consume_failed` was REMOVED rather than retained unused. It
       * reported a frontier that projected but whose consume did not commit —
       * a state only a separately committed consume can reach. A fenced collect
       * derives its consume inside the one transaction, so the condition is
       * unrepresentable and nothing can construct the arm. Keeping it would
       * have made this docstring's own "no dead arms" promise false. RD-829
       * itself is still live on a different shape: the execution loop emits its
       * own envelope from the unfenced `projectAndConsumeReEntryFrontier`
       * (`packages/cli/src/services/execution.ts`), which still commits its
       * consume separately.
       */
      readonly reason:
        | 'target_mismatch'
        | 'not_delegate_step'
        | 'step_not_found'
        | 'frontier_projection_refused';
      /**
       * User-facing error code, attached by core so the CLI renders a flat
       * passthrough (no CLI reason→code ternary — keeps "no CLI lifecycle
       * decisions" and type-driven dispatch intact):
       * - `not_delegate_step` → `NOT_DELEGATE_STEP`
       * - `step_not_found` → `STEP_NOT_FOUND`
       * - `target_mismatch` → `COLLECT_OPERATION_FAILED`
       * - `frontier_projection_refused` → `RD-821`
       *
       * `RD-821` names the CONDITION rather than the command, so the shared
       * re-entry seam reports it identically whether `collect` or the execution
       * loop drove it (F6).
       */
      readonly code:
        | 'NOT_DELEGATE_STEP'
        | 'STEP_NOT_FOUND'
        | 'COLLECT_OPERATION_FAILED'
        | typeof ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code;
      /** Operator-facing failure message. */
      readonly message: string;
    };

/**
 * Every outcome `rundown collect` can produce, policy and transactional alike.
 *
 * A WRAPPER, not a widening of {@link DelegationPolicyOutcome}. That union is
 * shared with `lifecycle-command-service.ts`, so adding transaction arms to it
 * in place would force every unrelated consumer to handle refusals it can never
 * receive — and would erase, by collapsing, the collection-specific variants the
 * CLI renders today. Composing instead keeps each policy arm's JSON/text shape,
 * exit code, and code mapping exactly as they are, and adds the transactional
 * refusals as new arms alongside them.
 *
 * The refusal arms are DERIVED from the canonical storage results rather than
 * restated. A structurally parallel restatement compiles but de-brands `RunId` /
 * `ExecutionEpoch` down to `string` / `number` and lets the two spellings drift;
 * this composition is the same one the CLI's `TransactionalMutationRefusal`
 * already derives, so core's producer and the CLI's renderer cannot disagree
 * about the arm set.
 *
 * `committed` is excluded on purpose: a committed collect is reported by its
 * collection-specific arm (`collection_applied`, `already_collected`, …), never
 * by a bare transaction success that says nothing about what was collected.
 */
export type CollectionWorkflowResult =
  | DelegationPolicyOutcome
  | Exclude<GuardedMutationResult<never>, { readonly kind: 'committed' }>
  | AbandonedAttemptSetOutcome;

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
  return actorContext.claim.controlledRunId === targetState.id
    ? 'orchestrator_for_target'
    : 'delegated_relative_to_target';
}

function requestForIntent(
  intent: CommandIntent,
  targetState: RunbookState | undefined,
): ClaimAuthorizationRequest | undefined {
  if (!targetState) return undefined;
  switch (intent.kind) {
    case 'delegating-run-advance':
    case 'terminal-run-force':
    case 'run-navigation':
      return { action: 'mutate-run', runId: targetState.id };
    case 'delegation-issuance':
      if (intent.command === 'delegate') {
        return { action: 'delegate-from-run', runId: targetState.id };
      }
      return {
        action: 'retry-delegation',
        runId: targetState.id,
        stepId: intent.stepId,
      };
    case 'delegation-collection':
      return { action: 'collect-for-run', runId: targetState.id };
    case 'inspect':
      return undefined;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
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

  if (!input.targetState) {
    return { kind: 'actor_context_required', intent: input.intent.kind };
  }

  const pendingFailure = rejectBareMutationIfCollectionPending(input);
  const hasOpenClaims =
    (input.intent.kind === 'delegating-run-advance' ||
      input.intent.kind === 'terminal-run-force') &&
    'targeted' in input.intent &&
    !input.intent.targeted &&
    input.openClaims !== undefined &&
    input.openClaims.length > 0;
  const requiresBearer =
    input.actorContext.kind === 'verified_claim' ||
    input.intent.kind === 'delegation-issuance' ||
    input.intent.kind === 'delegation-collection' ||
    input.targetSelector.kind === 'run' ||
    pendingFailure !== undefined ||
    hasOpenClaims;

  const request = requiresBearer ? requestForIntent(input.intent, input.targetState) : undefined;
  if (request !== undefined) {
    if (input.actorContext.kind !== 'verified_claim') {
      return { kind: 'actor_context_required', intent: input.intent.kind };
    }
    const decision = authorizeClaim(input.actorContext.claim, request);
    if (decision.kind === 'denied') {
      return {
        kind: 'claim_grant_required',
        intent: input.intent.kind,
        targetRunId: input.targetState.id,
      };
    }
  }

  if (pendingFailure) return pendingFailure;

  if (
    input.intent.kind === 'delegating-run-advance' &&
    !input.intent.targeted &&
    input.openClaims &&
    input.openClaims.length > 0
  ) {
    return {
      kind: 'open_claims',
      parentRunId: input.targetState.id,
      claims: input.openClaims,
    };
  }

  return allowed(role, input.targetState);
}
