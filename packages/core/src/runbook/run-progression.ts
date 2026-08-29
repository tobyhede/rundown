/**
 * XState-owned Run Progression activation (#851 / ADR 0003).
 *
 * The one public seam through which a continuation drives a run: a core
 * runtime explicitly activates the run's compiled machine under one verified,
 * run-bound {@link RunProgressionAuthority} and mechanically executes
 * machine-selected fenced turns until the composition awaits external input,
 * hands back a refusal, or reaches a terminal. Each turn contains at most one
 * durable commit, owned by the domain operation the machine selected —
 * completion application keeps its compare-and-swap, command execution keeps
 * capture/lease/effect/commit, terminal mutation keeps transaction-owned Run
 * Release. Observations are delivered synchronously through the caller's sink
 * after each commit.
 *
 * The activation returns exactly one closed {@link RunProgressionOutcome}:
 * `waiting`, `completed`, `stopped`, `refused`, or `failed`. `stopped` is
 * reserved for an actual stopped lifecycle; a refusal that committed no
 * terminal returns `refused` and emits no `runbook_stopped` observation.
 * Coordination statuses (`handled`, `blocked`, refusal hand-back overloads) do
 * not cross this seam.
 *
 * Frontends supply native effect callables ({@link InlineChildDispatch},
 * {@link TerminalPropagation}) and render the observation stream; they do not
 * decide progression.
 *
 * Completion selection and execution-unit entry are machine-owned turns. Fresh,
 * claimed, resumed, and terminally propagated runs all enter this activation;
 * there is no alternate frontend progression path.
 *
 * @module runbook/run-progression
 */

import { isDeepStrictEqual } from 'node:util';
import { createActor, toPromise } from 'xstate';
import type { ExecutionEventEmitter } from '../events/emitter.js';
import {
  deriveTerminalDrainObservationEvent,
  deriveTransitionObservation,
} from '../events/transition-observation.js';
import type { ExecutionObservationEffect } from '../events/execution-observation.js';
import { ErrorCodes } from '../errors/codes.js';
import { Errors } from '../errors/factory.js';
import { CLIErrorCodes } from '../output/zod-schemas.js';
import type { RunbookActorService } from './actor-service.js';
import {
  RECOVERY_REQUIRED_STATE_NAME,
  type RunbookEvent,
  type RunProgressionMachineFeedback,
} from './compiler.js';
import {
  COMPLETION_TARGET_MISMATCH_CODE,
  RunbookCompletionService,
  projectDelegationTerminalOutcome,
} from './completion-service.js';
import type { EffectfulActorMutationRunner } from './effectful-actor-mutation-runner.js';
import { findStepOrThrow } from './execution-units.js';
import type { ExecutionUnitEntry } from './execution-unit-entry.js';
import {
  FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
  FRONTIER_CONSUME_FAILED_MESSAGE,
  FRONTIER_PROJECTION_REFUSED_MESSAGE,
} from './re-entry-frontier.js';
import {
  SESSION_REFUSAL_CODE_BY_KIND,
  TRANSACTIONAL_REFUSAL_CODE_BY_KIND,
} from './storage/refusal-codes.js';
import type { RunId } from './run-id.js';
import type { RunProgressionAuthority } from './run-progression-authority.js';
import { isConcurrentStateModificationError } from './state.js';
import {
  DEFAULT_MUTATE_ATTEMPTS,
  mutateBackoffMs,
  type SessionMutationRefusal,
  type SessionMutationResult,
} from './storage/runbook-store.js';
import type { AbandonedAttemptSetOutcome } from './storage/execution-lease.js';
import type { GuardedMutationResult } from './storage/mutation-result.js';
import type { SessionService } from './session-service.js';
import {
  asTerminalSnapshotOrDefault,
  isRunbookComplete,
  isRunbookStopped,
} from './snapshot-utils.js';
import type { RunbookStateManager } from './state.js';
import { countNumberedSteps } from './step-utils.js';
import { buildStepPosition, deriveActiveFrame, findSubstepState } from './targeting.js';
import { inferFrameEntryFromState } from './frame-entry.js';
import { extractLastMessage } from './transition-kernel.js';
import type { InlineLaunchIntent } from '../events/types.js';
import type { InlineParentAdvanceRefusal } from './inline-parent-advance.js';
import { INLINE_PARENT_CYCLE_CODE, reportDelegatedTerminal } from './inline-parent-advance.js';
import { getErrorMessage } from '../errors.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import { inlineTerminalFlowBackActor } from './actors/inline-terminal-flow-back-actor.js';
import type { ResolvedStep, RunbookState } from './types.js';
import type { PreparedRunControlClaim } from './session-service.js';
import type { ClaimRunbookResult } from './claim-id.js';
import { delegationRuntimeCapabilities } from './delegation-credential.js';
import {
  mintInlineCompositionProgressionAuthority,
  mintRunProgressionAuthority,
} from './run-progression-authority.js';

/**
 * Machine-readable recovery classification for a non-terminal outcome.
 *
 * - `retryable` — the condition is transient; repeating the same gesture can
 *   succeed (execution contention, a frontier consume that did not commit).
 * - `provide_authority` — the gesture is valid but the presented authority is
 *   absent or insufficient; retry with verified claim authority.
 * - `permanent` — no retry of the same gesture can succeed; recovery is a
 *   different explicit action (finish, stop, prune, or restart the run).
 */
export type RunProgressionRecovery = 'retryable' | 'provide_authority' | 'permanent';

/**
 * The one inline parent-advance refusal reason → recovery mapping.
 *
 * The boundary derivation frontend propagation folds use when an
 * {@link InlineParentAdvanceRefusal} is what refused: each reason maps to the
 * same classification the activation gives the identical condition on its own
 * direct turns, so one condition cannot report two recoveries depending on the
 * path that surfaced it (#853 review F3). Keys are exhaustive over the refusal
 * reasons by the `satisfies` check.
 *
 * Frontends that must not value-import the core barrel (several CLI suites load
 * it under partial barrel mocks) restate this literal locally and pin it with
 * `satisfies InlineAdvanceRecoveryByReason`, exactly as the refusal-code maps
 * are restated against `refusal-codes.ts`.
 */
export const INLINE_ADVANCE_RECOVERY_BY_REASON = {
  target_mismatch: 'permanent',
  actor_context_required: 'provide_authority',
  projection_refused: 'permanent',
  consume_failed: 'retryable',
} as const satisfies Record<InlineParentAdvanceRefusal['reason'], RunProgressionRecovery>;

/**
 * Shape of {@link INLINE_ADVANCE_RECOVERY_BY_REASON}, for compile-time-only
 * derivations in frontends that restate the literal (see its doc).
 */
export type InlineAdvanceRecoveryByReason = typeof INLINE_ADVANCE_RECOVERY_BY_REASON;

/**
 * Derive the recovery classification for an inline parent-advance refusal.
 *
 * A lookup into the canonical map above; a reason added to the refusal union
 * fails compilation at the map rather than absorbing into a default arm.
 *
 * @param reason - The typed reason on the refusal.
 * @returns The core recovery classification for that condition.
 */
export function recoveryForInlineAdvanceRefusal(
  reason: InlineParentAdvanceRefusal['reason'],
): RunProgressionRecovery {
  return INLINE_ADVANCE_RECOVERY_BY_REASON[reason];
}

/**
 * Why an activation yielded without a terminal.
 *
 * - `awaiting_input` — the run rests on a prompted or command-free unit and
 *   needs an operator or agent gesture to continue.
 * - `inline_child_active` — an inline child launch is owned by another live
 *   process or was superseded; observe again once it settles.
 * - `inline_flow_back_settled` — synchronous inline flow-back already drove
 *   this run's progression; the outcome reports its rest state.
 */
export type RunProgressionWaitReason =
  | 'awaiting_input'
  | 'inline_child_active'
  | 'inline_flow_back_settled';

/**
 * Why an activation refused without applying a terminal.
 *
 * Each reason corresponds to one diagnosed condition on the migrated path and
 * keeps the error code that condition already reported before the migration.
 */
export type RunProgressionRefusalReason =
  | 'run_missing'
  | 'command_not_committed'
  | 'completion_not_committed'
  | 'completion_target_mismatch'
  | 'recovery_required'
  | 'actor_context_required'
  | 'projection_refused'
  | 'consume_failed'
  | 'frontier_disclosure_failed'
  | 'entry_render_failed'
  | 'frontier_reselect_exhausted'
  | 'claim_superseded'
  | 'recovery_required'
  | 'aggregate_recovery_required'
  | 'terminal_release_refused'
  | 'inline_launch_refused'
  | 'inline_child_unlinked'
  | 'inline_flow_back_refused'
  | 'terminal_propagation_refused';

/**
 * Enumerated invocation-layer disruption.
 *
 * Live since #853: the observation commit gate constructs the
 * `observation_delivery_failed` arm whenever the caller's sink throws during
 * synchronous post-commit delivery — a broken renderer ends every activation
 * this way, so frontends must handle it. The run itself is untouched at its
 * last committed boundary.
 */
export type RunProgressionFailureReason = 'observation_delivery_failed';

/**
 * The closed outcome of one Run Progression activation.
 *
 * Every arm names the responsible run. `refused` and `failed` additionally
 * carry a typed reason, the operator-facing message, the stable diagnostic
 * code where the refusing seam supplied one, and the core-derived
 * {@link RunProgressionRecovery} classification.
 */
export type RunProgressionOutcome =
  | {
      /** Progression rests awaiting external input or another process. */
      readonly kind: 'waiting';
      /** Run at which progression yielded. */
      readonly runId: RunId;
      /** Why the activation yielded. */
      readonly reason: RunProgressionWaitReason;
    }
  | {
      /** The run committed a completed lifecycle. */
      readonly kind: 'completed';
      /** The completed run. */
      readonly runId: RunId;
    }
  | {
      /** The run committed a stopped lifecycle. */
      readonly kind: 'stopped';
      /** The stopped run. */
      readonly runId: RunId;
    }
  | {
      /** A turn refused; nothing terminal was applied and the run keeps its lifecycle. */
      readonly kind: 'refused';
      /** Run whose turn refused. */
      readonly runId: RunId;
      /** The diagnosed condition. */
      readonly reason: RunProgressionRefusalReason;
      /** Stable diagnostic code, when the refusing seam supplied one. */
      readonly code?: string;
      /** Operator-facing message composed at the point of diagnosis. */
      readonly message: string;
      /** Core-derived recovery classification. */
      readonly recovery: RunProgressionRecovery;
    }
  | {
      /** An enumerated invocation-layer disruption ended the activation. */
      readonly kind: 'failed';
      /** Run whose invocation failed. */
      readonly runId: RunId;
      /** The enumerated disruption. */
      readonly reason: RunProgressionFailureReason;
      /** Operator-facing message. */
      readonly message: string;
      /** Core-derived recovery classification. */
      readonly recovery: RunProgressionRecovery;
    };

/** Input to the frontend-supplied inline child dispatch callable. */
export interface InlineChildDispatchInput {
  /** One-shot launch intent the machine prepared for this frame. */
  readonly intent: InlineLaunchIntent;
  /** The composing run's own prompted flag, inherited by a fresh child. */
  readonly prompted: boolean;
  /** Graph loaded from this activation's authority-bound durable state. */
  readonly steps: readonly ResolvedStep[];
  /**
   * The activation's GATED observation sink, supplied by core at invocation.
   *
   * Every parent-stream emission the callable makes must go through this sink
   * (never a raw emitter captured by closure), and the callable's own deeper
   * rendering should surface a broken reporting channel as
   * {@link ObservationDeliveryError} — that is what keeps the observation
   * commit gate (#853) uniform across the inline-child turn: a renderer
   * failure inside the dispatch ends the activation with the typed `failed`
   * outcome instead of an untyped escape.
   */
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
}

/**
 * What dispatching one inline child launch concluded.
 *
 * The callable owns the external effects (latch, child creation or resumption,
 * child execution, synchronous flow-back); the activation owns the decision to
 * invoke it and folds this result into the closed outcome.
 */
export type InlineChildDispatchResult =
  | {
      /** Nested activation's stable whole-composition outcome. */
      readonly kind: 'composition_outcome';
      readonly outcome: RunProgressionOutcome;
    }
  | {
      /** The launch is owned elsewhere or the child awaits; observe again later. */
      readonly kind: 'waiting';
    }
  | {
      /** Synchronous flow-back already drove the composing run's progression. */
      readonly kind: 'flow_back_complete';
    }
  | {
      /** Flow-back handled progression but concluded fail-closed; diagnostics already observed. */
      readonly kind: 'flow_back_refused';
      /** Run whose upward turn actually refused, including a deeper ancestor. */
      readonly runId: RunId;
      /** Registered code of the refusing condition, when its fold preserved one. */
      readonly code?: string;
      /** Operator-facing message, when the fold preserved one. */
      readonly message?: string;
      /**
       * Boundary-derived recovery for the refusing condition. `permanent` when
       * the fold had no typed refusal to derive from — a fail-closed
       * conclusion whose diagnostics already streamed.
       */
      readonly recovery: RunProgressionRecovery;
    }
  | {
      /** The launch itself refused fail-closed; diagnostics already observed. */
      readonly kind: 'launch_refused';
      /** Registered code of the refusing condition. Required: every refusing arm has one. */
      readonly code: string;
      /** Operator-facing message. */
      readonly message: string;
      /**
       * Boundary-derived recovery for the refusing condition: contention-shaped
       * refusals (a held session, a spent run-start CAS budget) are
       * `retryable`; structural refusals (missing runbook, broken linkage,
       * inconsistent latch state) are `permanent`. Derived from the refusing
       * arm's typed shape at the boundary that diagnosed it — never inferred
       * from message text.
       */
      readonly recovery: 'retryable' | 'permanent';
    }
  | {
      /** Degenerate: the child concluded but no linkage drove flow-back. */
      readonly kind: 'child_terminal';
      /** The child's terminal status. */
      readonly status: 'completed' | 'stopped';
    };

/**
 * Frontend-supplied Category-C callable performing one inline child launch.
 *
 * @param input - The machine-prepared intent and the composing run's prompted flag.
 * @returns How the dispatch concluded.
 */
export type InlineChildDispatch = (
  input: InlineChildDispatchInput,
) => Promise<InlineChildDispatchResult>;

/** Input to the frontend-supplied terminal propagation callable. */
export interface TerminalPropagationInput {
  /** The run this activation drove to terminal. */
  readonly runId: RunId;
  /**
   * Where the terminal result came from.
   *
   * An explicit PASS/FAIL — whether authored by an operator, a command result,
   * or a resolved child completion — must survive even when the authored action
   * reaches the opposite lifecycle (PASS STOP, FAIL COMPLETE). A terminal
   * discovered while resuming recovers that provenance from durable
   * `lastResult`; only a row without one is loop-inferred.
   */
  readonly source: TerminalPropagationSource;
  /**
   * The activation's GATED observation sink, supplied by core at invocation —
   * same contract as {@link InlineChildDispatchInput.sink}: the propagation's
   * rendering surfaces a broken reporting channel as
   * {@link ObservationDeliveryError}, keeping the commit gate uniform across
   * the propagation turn.
   */
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
}

/** Typed source of the result propagated from a terminal run. */
export type TerminalPropagationSource =
  | { readonly kind: 'explicit-result'; readonly result: 'pass' | 'fail' }
  | { readonly kind: 'loop-inferred' };

/**
 * Recover terminal propagation provenance from one authoritative durable row.
 *
 * `lastResult` records the authored PASS/FAIL independently of the lifecycle it
 * reached, including the intentionally opposite PASS STOP and FAIL COMPLETE
 * cases. Its absence is the only condition in which lifecycle inference is
 * honest. Every reload/convergence path uses this helper so they cannot silently
 * invert an authored result merely because another process committed it.
 *
 * @param state - Authoritative persisted state carrying optional result provenance.
 * @returns The propagation source represented by that durable state.
 */
function terminalPropagationSourceFromState(
  state: Pick<RunbookState, 'lastResult'>,
): TerminalPropagationSource {
  return state.lastResult === undefined
    ? { kind: 'loop-inferred' }
    : { kind: 'explicit-result', result: state.lastResult };
}

/**
 * What propagating a driven run's terminal concluded.
 *
 * `propagated` covers the no-op cases (unlinked or vanished run) and a
 * successful upward report. `advanced` names the composing parent and its
 * stable post-flow-back condition, so the activation reports the parent rather
 * than reusing the child's terminal. `refused` is the fail-closed arm whose
 * diagnostics the callable has already observed.
 */
export type TerminalPropagationResult =
  | {
      /** A nested parent activation reached the composition's stable outcome. */
      readonly kind: 'composition_outcome';
      readonly outcome: RunProgressionOutcome;
    }
  | {
      /** Propagation completed or there was nothing to propagate. */
      readonly kind: 'propagated';
    }
  | {
      /** Inline flow-back left the composing parent active and awaiting work. */
      readonly kind: 'advanced';
      /** The composing parent whose stable condition the activation now reports. */
      readonly runId: RunId;
      /** The parent absorbed the child and either remains active or reached STOP. */
      readonly status: 'waiting' | 'stopped';
    }
  | {
      /** Propagation refused fail-closed; diagnostics already observed. */
      readonly kind: 'refused';
      /** Run whose upward turn actually refused (often an ancestor). */
      readonly runId: RunId;
      /** Stable diagnostic code, when the refusing arm supplied one. */
      readonly code?: string;
      /** Operator-facing message. */
      readonly message: string;
      /**
       * Boundary-derived recovery for the refusing condition, mirroring
       * {@link InlineChildDispatchResult}'s `launch_refused` arm: derived from
       * the refusing arm's typed shape at the boundary that diagnosed it (a
       * consume-failed frontier is `retryable`, an absent deriver is
       * `provide_authority`, a target mismatch or linkage cycle is
       * `permanent`) — never re-stamped by the activation and never inferred
       * from message text.
       */
      readonly recovery: RunProgressionRecovery;
    };

/**
 * Frontend-supplied Category-C callable propagating a driven run's terminal to
 * its linked parent.
 *
 * @param input - The terminal run.
 * @returns How propagation concluded.
 */
export type TerminalPropagation = (
  input: TerminalPropagationInput,
) => Promise<TerminalPropagationResult>;

/** Dependencies for one Run Progression activation. */
export interface RunProgressionDeps {
  /** State manager bound to the project directory. */
  readonly manager: RunbookStateManager;
  /** Actor service compiled for this project's runbooks. */
  readonly actorService: RunbookActorService;
  /** Session service owning run targeting. */
  readonly sessionService: SessionService;
  /** Fenced mutation runner for command turns. */
  readonly actorMutationRunner: EffectfulActorMutationRunner;
  /**
   * Derive the compiled graph from the run state loaded by this activation.
   *
   * The activation never accepts a separately selected state or graph: it loads
   * `authority.runId` and passes that exact state here, making an authority/graph
   * mismatch unrepresentable at the public seam.
   */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
  /** Synchronous observation sink; events are delivered after each commit. */
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  /** Inline child launch callable (Category C). */
  readonly dispatchInlineChild: InlineChildDispatch;
  /** Driven-terminal propagation callable (Category C). */
  readonly propagateTerminal: TerminalPropagation;
}

/**
 * The durable/observation boundary at which an explicit activation enters.
 *
 * `resume` means the activation owns reporting and releasing any terminal it
 * discovers. `after_observed_transition` is minted by the core transition seam
 * after its initiating commit and is consumed only after the frontend delivers
 * that commit's observation. A terminal boundary records whether Run Release
 * was part of that same commit, so activation cannot replay either operation.
 */
export type RunProgressionEntryBoundary =
  | { readonly kind: 'resume' }
  | {
      readonly kind: 'after_observed_transition';
      readonly lifecycle: 'running';
    }
  | {
      readonly kind: 'after_observed_transition';
      readonly lifecycle: 'completed' | 'stopped';
      readonly terminalTarget: 'released' | 'retained_by_policy';
      readonly source: TerminalPropagationSource;
    };

/**
 * Core's explicit decision about whether a committed domain operation should
 * activate Run Progression next.
 *
 * The `activate` arm carries the already-verified authority and the exact
 * parsed graph verified alongside it; a frontend never reconstructs either or
 * infers continuation from unrelated observation fields.
 */
export type RunProgressionDirective =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'activate';
      readonly authority: RunProgressionAuthority;
      /** Event-envelope identity available even if the run vanishes before activation. */
      readonly runbook: RunbookState['runbook'];
      /** Exact parsed graph verified alongside this authority. */
      readonly steps: readonly ResolvedStep[];
      readonly entryBoundary: RunProgressionEntryBoundary;
    };

/**
 * Resolve after `ms` milliseconds.
 *
 * Local to this module for the same reason the store, the lease, and the
 * inline fence each keep their own: it is two lines, and exporting it would
 * invite it to be used as a general-purpose sleep rather than the pacing
 * between re-derives it is.
 *
 * @param ms - Milliseconds to pause.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bind a run-control claim prepared by core to the exact freshly-created run.
 *
 * The launch pipeline may carry this value, but cannot construct either input:
 * the claim is minted by {@link SessionService} and the durable state by core's
 * initializer. Keeping this constructor in core preserves the authority brand
 * while allowing inline launch to enter the same public progression seam.
 *
 * @param state - Exact initialized child state.
 * @param steps - Parsed child runbook graph.
 * @param prepared - Core-minted run-control claim for the child.
 * @returns An activation directive bound to the child and claim.
 * @throws {Error} When the prepared claim controls a different run.
 */
export function progressionDirectiveForStartedRun(
  state: RunbookState,
  steps: readonly ResolvedStep[],
  prepared: PreparedRunControlClaim,
): Extract<RunProgressionDirective, { kind: 'activate' }> {
  if (prepared.claim.controlledRunId !== state.id) {
    throw new Error(`Prepared run-control claim does not control run ${state.id}`);
  }
  return {
    kind: 'activate',
    authority: mintRunProgressionAuthority({
      runId: state.id,
      claimKey: prepared.claim.claimKey,
      delegationRuntime: prepared.delegationRuntime,
    }),
    runbook: state.runbook,
    steps,
    entryBoundary: { kind: 'resume' },
  };
}

/**
 * Bind a freshly minted delegated-child claim to its first progression.
 *
 * @param state - Exact initialized child state controlled by the claim.
 * @param steps - Parsed graph for the initialized child.
 * @param claimed - Fresh bearer and persisted claim record returned by core.
 * @returns An activation directive carrying claim-bound delegation capabilities.
 * @throws {Error} When the claim controls a different run.
 */
export function progressionDirectiveForClaimedRun(
  state: RunbookState,
  steps: readonly ResolvedStep[],
  claimed: Extract<ClaimRunbookResult, { readonly status: 'claimed' }>,
): Extract<RunProgressionDirective, { kind: 'activate' }> {
  if (claimed.claim.controlledRunId !== state.id) {
    throw new Error(`Claimed run-control claim does not control run ${state.id}`);
  }
  const authority = {
    kind: 'bearer' as const,
    claimId: claimed.claimId,
    claimKey: claimed.claim.claimKey,
  };
  return {
    kind: 'activate',
    authority: mintRunProgressionAuthority({
      runId: state.id,
      claimKey: claimed.claim.claimKey,
      delegationRuntime: delegationRuntimeCapabilities(authority),
    }),
    runbook: state.runbook,
    steps,
    entryBoundary: { kind: 'resume' },
  };
}

/**
 * Decide whether a caller-observed terminal run still owes composition a turn.
 *
 * Core, not the frontend, answers two questions here. WHETHER to continue: only
 * an INLINE-linked terminal does, because a delegated child's outcome is
 * recorded against its parent by the same fenced transaction that applied the
 * terminal, and an unlinked run composes with nothing — activating either would
 * re-record what is already durable. WHERE the activation starts: the caller has
 * already observed and rendered this terminal, so the boundary is
 * `after_observed_transition`, which reports and propagates without re-emitting
 * the terminal or re-releasing a run the applying transaction already released.
 *
 * Terminality is already durable, so no caller claim is needed to mutate the
 * child. The minted authority is restricted to inline-composition flow-back;
 * ancestor authority is resolved and validated by core before any parent turn.
 *
 * `loadSteps` is a callable rather than a parsed graph so a run that composes
 * with nothing never parses its runbook: eager parsing turned an unreadable or
 * moved child runbook into a throw AFTER the terminal was durably applied.
 *
 * @param state - Durable terminal child state.
 * @param loadSteps - Parses the graph for the terminal run, called only when it continues.
 * @returns An activation for an inline-linked terminal, or `none`.
 * @throws {Error} When the supplied state is not terminal.
 */
export function progressionDirectiveForTerminalRun(
  state: RunbookState,
  loadSteps: (state: RunbookState) => readonly ResolvedStep[],
): RunProgressionDirective {
  if (state.lifecycle !== 'completed' && state.lifecycle !== 'stopped') {
    throw new Error(`Run ${state.id} is not terminal`);
  }
  if (state.parentLinkage?.kind !== 'inline') return { kind: 'none' };
  return {
    kind: 'activate',
    authority: mintInlineCompositionProgressionAuthority(state.id),
    runbook: state.runbook,
    steps: loadSteps(state),
    entryBoundary: {
      kind: 'after_observed_transition',
      lifecycle: state.lifecycle,
      terminalTarget: 'released',
      source: terminalPropagationSourceFromState(state),
    },
  };
}

/**
 * Commit one pure machine transition under exact Run Progression authority.
 *
 * Used for launch-intent consume/abandon feedback whose XState handlers contain
 * only pure assigns. A loser re-captures authority and re-derives the transition;
 * no stale actor snapshot is ever written over a concurrent terminal commit.
 *
 * @param authority - Core-minted authority for the exact run.
 * @param manager - Durable state manager.
 * @param actorService - Actor compiler used for pure transition derivation.
 * @param steps - Parsed graph for the run.
 * @param event - Pure internal machine event.
 * @returns The guarded commit or typed refusal.
 */
export async function commitRunProgressionEvent(
  authority: RunProgressionAuthority,
  manager: RunbookStateManager,
  actorService: RunbookActorService,
  steps: readonly ResolvedStep[],
  event: Extract<RunbookEvent, { type: 'INLINE_LAUNCH_CONSUMED' | 'INLINE_LAUNCH_ABANDONED' }>,
): Promise<GuardedMutationResult<RunbookState>> {
  let last: GuardedMutationResult<RunbookState> | undefined;
  for (let attempt = 0; attempt < DEFAULT_MUTATE_ATTEMPTS; attempt += 1) {
    const captured =
      authority.claimKey === undefined
        ? await manager.captureRunAuthorityState(authority.runId)
        : await manager.captureAuthorityState(authority.runId, authority.claimKey);
    if (captured.kind !== 'captured') return captured;
    const prepared = await actorService.prepareActorMutation(
      authority.runId,
      captured.state,
      steps,
      event,
    );
    const committed = await manager.saveState(captured.authority, prepared.nextState);
    if (committed.kind !== 'concurrent_modification') return committed;
    last = committed;
    if (attempt < DEFAULT_MUTATE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, mutateBackoffMs(attempt)));
    }
  }
  if (last === undefined) throw new Error('Run Progression event commit exhausted no attempts');
  return last;
}

/** Maximum distinct inline ancestors one activation may validate. */
export const MAX_INLINE_ANCESTOR_DEPTH = 64;

/** A core-owned refusal while resolving one exact inline-composition edge. */
export type InlineAncestorProgressionResolution =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'activate';
      /**
       * The immediate composing parent's activation. Only this edge is turned
       * into a directive: every ancestor above it is validated from durable
       * state, but activating it is the recursive flow-back's job one level up,
       * so parsing its graph here would cost a parser crossing per ancestor on
       * every terminal — twice, since the flow-back resolves before and after
       * recording the completion.
       */
      readonly directive: Extract<RunProgressionDirective, { kind: 'activate' }>;
    }
  | {
      readonly kind: 'refused';
      readonly runId: RunId;
      readonly reason:
        | 'missing_inline_parent'
        | 'inline_parent_cycle'
        | 'inline_parent_depth'
        | 'unrelated_inline_parent';
      readonly message: string;
    };

/**
 * Resolve the immediate composing parent from durable linkage, while validating
 * the whole contiguous-inline ancestry before returning any activation.
 *
 * The child authority is branded and run-bound; the child row is therefore
 * loaded from that authority rather than supplied by a frontend. Every upward
 * edge must still name the parent's exact active cursor, frame, and entry. The
 * launch latch metadata is intentionally absent here: it is consumed when the
 * child launch commits, while the child's linkage is write-once. A missing
 * parent, cycle, or superseded cursor refuses before the caller records a
 * completion. Parent claim authority is deliberately not copied from the child:
 * a child bearer controls only the child. A delegation runtime may be forwarded
 * only when its core-bound run id is the parent being activated.
 *
 * @param args - Resolution dependencies and child authority.
 * @param args.authority - Exact branded authority of the terminal child.
 * @param args.manager - Durable run-state manager.
 * @param args.loadSteps - Parser boundary for validated ancestor states.
 * @param args.ancestorAuthorities - Exact authorities retained for composing ancestors.
 * @param args.expectedTargetStatus - Immediate edge status expected around completion recording.
 * @returns The immediate parent activation, no-link result, or typed refusal.
 */
export async function resolveInlineAncestorProgression(args: {
  readonly authority: RunProgressionAuthority;
  readonly manager: RunbookStateManager;
  readonly loadSteps: RunProgressionDeps['loadSteps'];
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly expectedTargetStatus?: 'running' | 'done';
}): Promise<InlineAncestorProgressionResolution> {
  const child = await args.manager.load(args.authority.runId);
  if (child?.parentLinkage?.kind !== 'inline') return { kind: 'none' };

  let descendant = child;
  const seen = new Set<RunId>([child.id]);
  const ancestors: RunbookState[] = [];
  for (;;) {
    const linkage = descendant.parentLinkage;
    if (linkage?.kind !== 'inline') break;
    // The bound is independent of the repeat check below: `seen` saturates in a
    // true cycle, so a size-derived cap would be parasitic on it. An acyclic
    // chain longer than the bound is refused here rather than walked, loaded,
    // and parsed.
    if (ancestors.length >= MAX_INLINE_ANCESTOR_DEPTH) {
      return {
        kind: 'refused',
        runId: descendant.id,
        reason: 'inline_parent_depth',
        message: `Parent linkage chain from ${descendant.id} exceeded the maximum propagation depth of ${String(MAX_INLINE_ANCESTOR_DEPTH)}`,
      };
    }
    if (seen.has(linkage.parentRunId)) {
      return {
        kind: 'refused',
        runId: linkage.parentRunId,
        reason: 'inline_parent_cycle',
        message: `Parent linkage cycle detected at ${linkage.parentRunId}`,
      };
    }
    const parent = await args.manager.load(linkage.parentRunId);
    if (!parent) {
      return {
        kind: 'refused',
        runId: linkage.parentRunId,
        reason: 'missing_inline_parent',
        message: `Inline parent ${linkage.parentRunId} is unavailable`,
      };
    }
    const linkedSubstep = findSubstepState(
      parent.substepStates ?? [],
      linkage.parentStepId,
      linkage.parentFrameKey,
    );
    const linkedEntry = inferFrameEntryFromState(parent, linkage.parentFrameKey);
    const activeFrameKey = parent.activeFrameKey ?? deriveActiveFrame(parent).frameKey;
    const expectedTargetStatus =
      ancestors.length === 0 ? (args.expectedTargetStatus ?? 'running') : 'running';
    if (
      parent.lifecycle === 'completed' ||
      parent.lifecycle === 'stopped' ||
      parent.step !== linkage.parentStep ||
      parent.substep !== linkage.parentStepId ||
      activeFrameKey !== linkage.parentFrameKey ||
      linkedSubstep?.status !== expectedTargetStatus ||
      linkage.parentEntry !== linkedEntry
    ) {
      return {
        kind: 'refused',
        runId: parent.id,
        reason: 'unrelated_inline_parent',
        message: `Run ${parent.id} does not own inline child ${descendant.id} at the persisted linkage edge (lifecycle ${String(parent.lifecycle)}; cursor ${parent.step}/${String(parent.substep)} frame ${activeFrameKey}; linked target ${linkage.parentStep}/${linkage.parentStepId} frame ${linkage.parentFrameKey} status ${String(linkedSubstep?.status)} entry ${String(linkedEntry)}; expected entry ${String(linkage.parentEntry)})`,
      };
    }
    ancestors.push(parent);
    seen.add(parent.id);
    descendant = parent;
  }

  // Non-empty by construction: the inline-linkage precondition above guarantees
  // the walk ran at least one iteration before it broke.
  const immediateParent = ancestors[0];
  const retained = args.ancestorAuthorities?.find(
    (candidate) => candidate.runId === immediateParent.id,
  );
  return {
    kind: 'activate',
    directive: {
      kind: 'activate',
      authority: retained ?? mintInlineCompositionProgressionAuthority(immediateParent.id),
      runbook: immediateParent.runbook,
      steps: await args.loadSteps(immediateParent),
      entryBoundary: { kind: 'resume' },
    },
  };
}

/**
 * Record one terminal inline child and activate its immediate parent.
 *
 * Core owns the complete flow-back decision: validate the whole ancestry,
 * record the child's authored terminal result, refresh the parent graph after
 * output projection, and hand the exact parent directive to the recursive
 * activation port. The frontend supplies only runtime services and the
 * activation callable.
 *
 * @param args - Inline flow-back dependencies and terminal evidence.
 * @param args.authority - Exact authority for the terminal child.
 * @param args.manager - Durable run-state manager.
 * @param args.actorService - Actor service used by completion recording.
 * @param args.loadSteps - Parser boundary for ancestor graphs.
 * @param args.source - Durable or explicit terminal-result provenance.
 * @param args.sink - Gated observation sink for typed refusal diagnostics.
 * @param args.ancestorAuthorities - Exact authorities retained for ancestors.
 * @param args.activateParent - Recursive public Run Progression activation port.
 * @returns Null for a non-inline child, otherwise the closed propagation result.
 */
export async function flowBackInlineTerminal(args: {
  readonly authority: RunProgressionAuthority;
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly loadSteps: RunProgressionDeps['loadSteps'];
  readonly source: TerminalPropagationSource;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly activateParent: (
    directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  ) => Promise<RunProgressionOutcome>;
}): Promise<TerminalPropagationResult | null> {
  const actor = createActor(inlineTerminalFlowBackActor, {
    input: { execute: () => executeInlineTerminalFlowBack(args) },
  });
  actor.start();
  return await toPromise(actor);
}

/**
 * Propagate one terminal run through its core-owned composition relationship.
 * Inline linkage takes precedence; a non-inline terminal is reported through
 * delegation when applicable. Frontends supply effects but never select the
 * upward path or translate its coordination outcomes.
 */
export async function propagateTerminalRun(args: {
  readonly authority: RunProgressionAuthority;
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly completionService: RunbookCompletionService;
  readonly loadSteps: RunProgressionDeps['loadSteps'];
  readonly source: TerminalPropagationSource;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly activateParent: (
    directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  ) => Promise<RunProgressionOutcome>;
}): Promise<TerminalPropagationResult> {
  const inline = await flowBackInlineTerminal(args);
  if (inline !== null) return inline;
  const terminal = await args.manager.load(args.authority.runId);
  if (terminal === null) return { kind: 'propagated' };
  const reported = await reportDelegatedTerminal(
    { completionService: args.completionService },
    terminal,
    args.source.kind === 'explicit-result' ? args.source.result : undefined,
  );
  if (reported.kind === 'refused') {
    return {
      kind: 'refused',
      runId: args.authority.runId,
      message: `Delegated terminal report for ${args.authority.runId} was blocked`,
      recovery: 'permanent',
    };
  }
  if (reported.kind === 'linkage-cycle') {
    return {
      kind: 'refused',
      runId: args.authority.runId,
      code: reported.trip.code,
      message: reported.trip.message,
      recovery: 'permanent',
    };
  }
  return { kind: 'propagated' };
}

/**
 * Core operation invoked by {@link inlineTerminalFlowBackActor}.
 *
 * @param args - Exact child authority, services, source, and recursive activation port.
 * @param args.authority - Exact terminal-child authority.
 * @param args.manager - Durable state manager.
 * @param args.actorService - Actor service used to record the completion.
 * @param args.loadSteps - Parser boundary for ancestor graphs.
 * @param args.source - Terminal-result provenance.
 * @param args.sink - Gated observation sink.
 * @param args.ancestorAuthorities - Retained exact ancestor authorities.
 * @param args.activateParent - Recursive public progression activation port.
 * @returns Null for a non-inline child, otherwise the actor's propagation result.
 * @throws {Error} When the completion service reports a status this seam does
 *   not classify, which the exhaustive switch makes a compile error first.
 */
async function executeInlineTerminalFlowBack(args: {
  readonly authority: RunProgressionAuthority;
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly loadSteps: RunProgressionDeps['loadSteps'];
  readonly source: TerminalPropagationSource;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly activateParent: (
    directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  ) => Promise<RunProgressionOutcome>;
}): Promise<TerminalPropagationResult | null> {
  const child = await args.manager.load(args.authority.runId);
  if (child?.parentLinkage?.kind !== 'inline') return null;

  // Every refusal this function returns flips the caller's exit code, so each
  // one delivers its diagnostic through the gated sink first — the #853 review
  // F2 property `runMissingRefusal` already holds, restated here so no arm can
  // leave success-shaped output beside a failure exit.
  const refuse = (
    runId: RunId,
    message: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ): Extract<TerminalPropagationResult, { kind: 'refused' }> => {
    args.sink.emit({
      type: 'ERROR_OCCURRED',
      payload: {
        message,
        ...(code === undefined ? {} : { code }),
        ...(details === undefined ? {} : { details }),
      },
    });
    return {
      kind: 'refused',
      runId,
      ...(code === undefined ? {} : { code }),
      message,
      recovery: 'permanent',
    };
  };

  const resolutionArgs = {
    authority: args.authority,
    manager: args.manager,
    loadSteps: args.loadSteps,
    ...(args.ancestorAuthorities === undefined
      ? {}
      : { ancestorAuthorities: args.ancestorAuthorities }),
  };
  const resolved = await resolveInlineAncestorProgression(resolutionArgs);
  if (resolved.kind === 'refused') return refuseAncestorResolution(resolved, refuse);
  if (resolved.kind === 'none') return null;

  // The SAME projection the completion service and the legacy upward walk use.
  // Inferring `pass`/`fail` from the lifecycle instead would report an authored
  // FAIL for a child that never produced one — a stop caused by a denied policy
  // or a command the runner could not execute is `command_infrastructure`, not
  // a runbook result, and passing an explicit result defeats the classification
  // inside `recordChildCompletion` too.
  const projection = projectDelegationTerminalOutcome(
    child,
    args.source.kind === 'explicit-result' ? args.source.result : undefined,
  );
  if (projection.kind === 'not_terminal') return null;
  if (projection.kind === 'command_infrastructure') {
    return refuse(
      child.id,
      `Inline child ${child.id} stopped for command infrastructure reasons (${projection.reason}): ${projection.message}`,
    );
  }

  const completionService = new RunbookCompletionService(args.manager, args.actorService);
  const recorded = await completionService.recordChildCompletion({
    childState: child,
    result: projection.result,
  });
  switch (recorded) {
    case 'recorded':
    case 'duplicate':
      break;
    case 'cancelled':
      // The parent cancelled this substep, so it owes nothing upward and is not
      // wedged. Reporting a refusal here would fail a run that is fine.
      return { kind: 'propagated' };
    case 'blocked':
      return refuse(
        child.id,
        `Inline child ${child.id} terminal result is fail-closed and was not recorded; see the preceding diagnostics`,
      );
    case 'not-applicable':
      return refuse(
        child.id,
        `Inline child ${child.id} has no composing parent to record its terminal result against`,
      );
    default: {
      const exhaustive: never = recorded;
      throw new Error(`Unhandled child completion status: ${String(exhaustive)}`);
    }
  }

  const refreshed = await resolveInlineAncestorProgression({
    ...resolutionArgs,
    expectedTargetStatus: 'done',
  });
  if (refreshed.kind === 'refused') return refuseAncestorResolution(refreshed, refuse);
  if (refreshed.kind === 'none') {
    return refuse(
      child.id,
      `Inline child ${child.id} lost its composing parent after completion was recorded`,
    );
  }
  return {
    kind: 'composition_outcome',
    outcome: await args.activateParent(refreshed.directive),
  };
}

/**
 * Fold an ancestry-resolution refusal into the propagation refusal arm, keeping
 * the established cycle code and its trip details on the two chain-guard arms.
 *
 * @param resolved - The resolver's refusal.
 * @param refuse - Diagnostic-emitting refusal constructor bound to the sink.
 * @returns The propagation refusal naming the run the operator must inspect.
 * @throws {Error} When a refusal reason this seam does not classify reaches the
 *   exhaustive guard, which the compiler refuses first.
 */
function refuseAncestorResolution(
  resolved: Extract<InlineAncestorProgressionResolution, { kind: 'refused' }>,
  refuse: (
    runId: RunId,
    message: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) => Extract<TerminalPropagationResult, { kind: 'refused' }>,
): Extract<TerminalPropagationResult, { kind: 'refused' }> {
  switch (resolved.reason) {
    case 'inline_parent_cycle':
      return refuse(resolved.runId, resolved.message, INLINE_PARENT_CYCLE_CODE, {
        cause: 'repeat',
        runId: resolved.runId,
      });
    case 'inline_parent_depth':
      return refuse(resolved.runId, resolved.message, INLINE_PARENT_CYCLE_CODE, {
        cause: 'depth',
        runId: resolved.runId,
      });
    case 'missing_inline_parent':
    case 'unrelated_inline_parent':
      return refuse(resolved.runId, resolved.message);
    default: {
      const exhaustive: never = resolved.reason;
      throw new Error(`Unhandled inline ancestry refusal: ${String(exhaustive)}`);
    }
  }
}

/** The refusal arms of a fenced mutation, i.e. everything but `committed`. */
type FencedMutationRefusal = Exclude<GuardedMutationResult<never>, { kind: 'committed' }>;

/**
 * Map a fenced-mutation refusal kind to its registered symbolic code.
 *
 * A lookup into the canonical core-owned map rather than a restated switch, so
 * this seam and the CLI's `transactionalRefusalCode` cannot drift. The
 * aggregate arm is absent from {@link FencedMutationRefusal}: single-run
 * fenced turns cannot produce it.
 *
 * @param refusal - The non-committed fenced mutation result.
 * @returns The registered code for the refusal's kind.
 */
function fencedRefusalCode(refusal: FencedMutationRefusal): string {
  return TRANSACTIONAL_REFUSAL_CODE_BY_KIND[refusal.kind];
}

/**
 * Recovery classification for every transactional refusal kind, single-run
 * and aggregate alike.
 *
 * One canonical map rather than a switch per turn, so the command fence and
 * the frontier fence cannot classify the same storage refusal differently
 * (#853 review F3). `recovery_required` and `aggregate_recovery_required` are
 * retryable because the runner drives execution recovery inline before it
 * returns either refusal: the run is unblocked for a LATER activation, and the
 * refusal reports only that THIS mutation did not commit. Keys are exhaustive
 * over the fenced and aggregate refusal kinds by the `satisfies` check.
 */
const TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND = {
  concurrent_modification: 'retryable',
  execution_in_progress: 'retryable',
  recovery_required: 'retryable',
  aggregate_recovery_required: 'retryable',
  claim_superseded: 'provide_authority',
  missing: 'permanent',
} as const satisfies Record<
  FencedMutationRefusal['kind'] | AbandonedAttemptSetOutcome['kind'],
  RunProgressionRecovery
>;

/**
 * Derive the recovery classification for a fenced-mutation refusal kind.
 *
 * @param refusal - The non-committed fenced mutation result.
 * @returns The core recovery classification for that condition.
 */
function fencedRefusalRecovery(refusal: FencedMutationRefusal): RunProgressionRecovery {
  return TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND[refusal.kind];
}

/**
 * Map a session ownership refusal to its registered symbolic code.
 *
 * A lookup into the canonical core-owned map: a refusal kind added to
 * {@link SessionMutationRefusal} fails compilation in the map's `satisfies`
 * check rather than silently absorbing into a default arm here.
 *
 * @param refusal - Ownership refusal returned by the session service.
 * @returns The registered code for the refusal's kind.
 */
function sessionRefusalCode(refusal: SessionMutationRefusal): string {
  return SESSION_REFUSAL_CODE_BY_KIND[refusal.kind];
}

/**
 * Derive recovery from the session refusal itself.
 *
 * A live owner can release its lease, so `execution_in_progress` is retryable.
 * `recovery_required` is detection-only: repeating the session mutation neither
 * performs nor completes recovery, so the same gesture cannot make progress.
 *
 * @param refusal - Ownership refusal returned by the session service.
 * @returns The recovery classification for the refusal.
 * @throws {Error} When an unknown refusal kind reaches the exhaustive guard.
 */
function sessionRefusalRecovery(refusal: SessionMutationRefusal): RunProgressionRecovery {
  switch (refusal.kind) {
    case 'execution_in_progress':
      return 'retryable';
    case 'recovery_required':
      return 'permanent';
    default: {
      const _exhaustive: never = refusal;
      throw new Error(
        `Unhandled session mutation refusal: ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

/** Internal continuation signal for one ported progression turn. */
type TransitionApplication =
  | { readonly status: 'continue'; readonly state: RunbookState }
  | { readonly status: 'done' }
  | { readonly status: 'stopped' };

/**
 * Emit one applied transition's core-derived observation events and classify
 * the continuation.
 *
 * The core port of the CLI driver's transition orchestration: payload derivation
 * was already core's (`deriveTransitionObservation`); only observation delivery moves.
 *
 * @param args - Transition context.
 * @param args.sink - Synchronous observation sink receiving the events.
 * @param args.steps - Parsed steps for the run.
 * @param args.currentStep - The step the transition was evaluated at.
 * @param args.previousState - State before the applied transition.
 * @param args.updatedState - State the transition committed.
 * @param args.snapshot - Raw machine snapshot after the transition.
 * @param args.result - Whether the unit passed or failed.
 * @param args.command - Display command included in the observation, if any.
 * @returns Whether progression continues, completed, or stopped.
 */
function applyTransitionObservation(args: {
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly steps: readonly ResolvedStep[];
  readonly currentStep: ResolvedStep;
  readonly previousState: RunbookState;
  readonly updatedState: RunbookState;
  readonly snapshot: unknown;
  readonly result: 'pass' | 'fail';
  readonly command?: string;
}): TransitionApplication {
  const observation = deriveTransitionObservation({
    steps: args.steps,
    currentStep: args.currentStep,
    previousState: args.previousState,
    updatedState: args.updatedState,
    snapshot: args.snapshot,
    result: args.result,
    ...(args.command !== undefined ? { command: args.command } : {}),
  });
  for (const event of observation.events) {
    args.sink.emit(event);
  }
  if (observation.status === 'done') return { status: 'done' };
  if (observation.status === 'stopped') return { status: 'stopped' };
  return { status: 'continue', state: observation.state };
}

/**
 * Emit the terminal observation for a run whose lifecycle was already terminal
 * when the activation loaded it.
 *
 * Mirrors the former CLI driver's terminal-at-activation projection, including the
 * split between a machine-driven terminal snapshot and a lifecycle-only
 * terminal.
 *
 * @param args - The terminal state, its steps, and the sink.
 * @param args.sink - Synchronous observation sink receiving the events.
 * @param args.steps - Parsed steps for the run.
 * @param args.state - The already-terminal persisted state being reported.
 * @param args.terminal - Which terminal lifecycle the state committed.
 */
function emitTerminalAtActivation(args: {
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly steps: readonly ResolvedStep[];
  readonly state: RunbookState;
  readonly terminal: 'completed' | 'stopped';
}): void {
  const { sink, steps, state, terminal } = args;
  const terminalSnap = asTerminalSnapshotOrDefault(state.snapshot);
  const snapIsTerminal = isRunbookStopped(terminalSnap) || isRunbookComplete(terminalSnap);
  if (snapIsTerminal) {
    const currentStep = findStepOrThrow(steps, state.step, state.id);
    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState: state,
      updatedState: state,
      snapshot: state.snapshot,
      result: terminal === 'completed' ? 'pass' : 'fail',
    });
    for (const event of observation.events) {
      // Only the terminal announcement is re-derivable here; a transition event
      // for a transition that happened in an earlier invocation must not be
      // replayed. This matches the former driver's terminal-at-activation filter.
      if (
        (terminal === 'stopped' &&
          (event.type === 'RUNBOOK_STOPPED' || event.type === 'ERROR_OCCURRED')) ||
        (terminal === 'completed' && event.type === 'RUNBOOK_COMPLETED')
      ) {
        sink.emit(event);
      }
    }
    return;
  }
  if (terminal === 'stopped') {
    const currentStep = findStepOrThrow(steps, state.step, state.id);
    sink.emit(
      deriveTerminalDrainObservationEvent({
        steps,
        currentStep,
        previousState: state,
        updatedState: state,
        snapshot: state.snapshot,
        status: 'stopped',
        result: 'fail',
      }),
    );
    return;
  }
  sink.emit({
    type: 'RUNBOOK_COMPLETED',
    payload: {
      message: extractLastMessage(state.snapshot),
      finalPosition: buildStepPosition(
        state.step,
        countNumberedSteps([...steps]),
        state.substep,
        state.forStack,
      ),
    },
  });
}

/** Outcome of one machine-selected resolved-completion turn. */
type CompletionTurn =
  | { readonly kind: 'continue'; readonly state: RunbookState }
  | {
      readonly kind: 'feedback';
      readonly state: RunbookState;
      readonly feedback: RunProgressionMachineFeedback;
    }
  | {
      readonly kind: 'terminal';
      readonly intent: { readonly kind: 'completed' | 'stopped' };
      readonly source: TerminalPropagationSource;
    }
  | { readonly kind: 'missing' };

/**
 * Execute one resolved-completion turn selected by the compiled machine.
 *
 * There is deliberately no iteration here. The compiled machine selects one
 * `apply_completion` intent, this runtime mechanically invokes the existing CAS
 * operation once, and the activation delivers that commit's observation before
 * asking the machine for another intent.
 *
 * @param args - Drain context.
 * @param args.completionService - Completion service owning the fenced apply.
 * @param args.manager - State manager used for the authoritative contention reload.
 * @param args.sink - Synchronous observation sink receiving each commit's events.
 * @param args.runId - Run whose completions are drained.
 * @param args.steps - Parsed steps for the run.
 * @param args.authority - The activation's verified run-bound authority.
 * @returns The one-turn conclusion.
 */
async function applyMachineSelectedCompletionTurn(args: {
  readonly completionService: RunbookCompletionService;
  readonly manager: RunbookStateManager;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly runId: RunId;
  readonly steps: readonly ResolvedStep[];
  readonly authority: RunProgressionAuthority;
}): Promise<CompletionTurn> {
  const { completionService, manager, sink, runId, steps, authority } = args;
  let applied: Awaited<ReturnType<RunbookCompletionService['applyNextResolvedCompletion']>>;
  try {
    applied = await completionService.applyNextResolvedCompletion({
      runbookId: runId,
      steps,
      ...(authority.delegationRuntime
        ? { issueDelegationCredential: authority.delegationRuntime.issueDelegationCredential }
        : {}),
      terminalRelease: { role: 'addressed' },
    });
  } catch (cause: unknown) {
    if (!isConcurrentStateModificationError(cause)) throw cause;
    // Exhaustion proves only that this apply did not win. Reload the row that
    // DID survive the contention before classifying the turn: the final writer
    // may have removed the run, committed terminal + Run Release, or left a
    // running row on which the machine can close the contention refusal.
    const durable = await manager.load(runId);
    if (!durable) return { kind: 'missing' };
    if (durable.lifecycle === 'completed' || durable.lifecycle === 'stopped') {
      return {
        kind: 'terminal',
        intent: { kind: durable.lifecycle },
        source: terminalPropagationSourceFromState(durable),
      };
    }
    return {
      kind: 'feedback',
      state: durable,
      feedback: { kind: 'completion_not_committed', message: cause.message },
    };
  }
  if (applied.kind === 'mismatch') {
    return {
      kind: 'feedback',
      state: applied.state,
      feedback: {
        kind: 'completion_target_mismatch',
        message: applied.mismatch.message,
      },
    };
  }
  if (applied.kind === 'not_active') {
    throw new Error(
      `Run Progression completion apply for ${runId} returned not_active without a frame override`,
    );
  }
  if (applied.kind === 'missing') {
    return { kind: 'missing' };
  }
  if (applied.kind === 'none') {
    if (applied.state.lifecycle === 'completed' || applied.state.lifecycle === 'stopped') {
      return {
        kind: 'terminal',
        intent: { kind: applied.state.lifecycle },
        source: terminalPropagationSourceFromState(applied.state),
      };
    }
    return { kind: 'continue', state: applied.state };
  }
  const entry = applied.entry;
  const currentStep = findStepOrThrow(steps, entry.stateBefore.step, entry.stateBefore.id);
  const observed = applyTransitionObservation({
    sink,
    steps,
    currentStep,
    previousState: entry.stateBefore,
    updatedState: entry.stateAfter,
    snapshot: entry.snapshot,
    result: entry.completion.result,
  });
  if (entry.progressionIntent !== undefined) {
    return {
      kind: 'terminal',
      intent: entry.progressionIntent,
      source: { kind: 'explicit-result', result: entry.completion.result },
    };
  }
  if (observed.status !== 'continue') {
    throw new Error(
      `Run ${runId} reached ${observed.status} without a terminal Run Progression machine output`,
    );
  }
  return { kind: 'continue', state: observed.state };
}

/**
 * Report a terminal condition: propagate it through the frontend callable and
 * fold the result into the closed outcome.
 *
 * @param args - The terminal run, its status, and the propagation callable.
 * @param args.runId - The run that reached terminal.
 * @param args.terminal - Which terminal lifecycle it committed.
 * @param args.source - Durable or initiating-boundary provenance for the terminal.
 * @param args.propagateTerminal - Frontend propagation callable.
 * @param args.sink - The gated observation sink, handed to the callable.
 * @returns The terminal outcome, or `refused` when propagation failed closed.
 */
async function concludeTerminal(args: {
  readonly runId: RunId;
  readonly terminal: 'completed' | 'stopped';
  readonly source: TerminalPropagationSource;
  readonly propagateTerminal: TerminalPropagation;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
}): Promise<RunProgressionOutcome> {
  const propagated = await args.propagateTerminal({
    runId: args.runId,
    source: args.source,
    sink: args.sink,
  });
  if (propagated.kind === 'refused') {
    return propagationRefusalOutcome(propagated);
  }
  if (propagated.kind === 'composition_outcome') return propagated.outcome;
  if (propagated.kind === 'advanced') {
    return propagated.status === 'stopped'
      ? { kind: 'stopped', runId: propagated.runId }
      : {
          kind: 'waiting',
          runId: propagated.runId,
          reason: 'inline_flow_back_settled',
        };
  }
  return { kind: args.terminal, runId: args.runId };
}

/**
 * Build the `terminal_propagation_refused` outcome from a propagation
 * callable's refusal, honoring the code and boundary-derived recovery the
 * refusing arm carried.
 *
 * @param refused - The callable's refusal arm.
 * @returns The refused outcome.
 */
function propagationRefusalOutcome(
  refused: Extract<TerminalPropagationResult, { kind: 'refused' }>,
): RunProgressionOutcome {
  return {
    kind: 'refused',
    runId: refused.runId,
    reason: 'terminal_propagation_refused',
    ...(refused.code !== undefined ? { code: refused.code } : {}),
    message: refused.message,
    recovery: refused.recovery,
  };
}

/**
 * Release a run this activation observed at terminal, reporting a refusal as a
 * typed outcome rather than a false stop.
 *
 * @param args - Session service, run, sink, and the terminal to report.
 * @param args.sessionService - Session service owning run targeting.
 * @param args.runId - The terminal run to release.
 * @param args.sink - Synchronous observation sink receiving a refusal's error.
 * @returns `null` when the release committed, otherwise the refused outcome.
 */
async function releaseTerminalTarget(args: {
  readonly sessionService: SessionService;
  readonly runId: RunId;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
}): Promise<Extract<RunProgressionOutcome, { kind: 'refused' }> | null> {
  const released: SessionMutationResult<unknown> = await args.sessionService.releaseRuns([
    { runId: args.runId, role: 'addressed' },
  ]);
  if (released.kind === 'committed') return null;
  args.sink.emit({
    type: 'ERROR_OCCURRED',
    payload: { message: released.message, code: sessionRefusalCode(released) },
  });
  return {
    kind: 'refused',
    runId: args.runId,
    reason: 'terminal_release_refused',
    code: sessionRefusalCode(released),
    message: released.message,
    recovery: sessionRefusalRecovery(released),
  };
}

/**
 * Refuse an activation whose run no longer exists, observing the diagnostic
 * before returning.
 *
 * The emit is not optional (#853 review F2): this refusal flips the caller's
 * exit code, and a refusal with no diagnostic in the stream leaves
 * success-shaped output beside a failure exit — a frontend renders
 * observations and maps the outcome, it does not print the outcome itself. The
 * code is the canonical missing-target mapping, so a remap of that code changes
 * this arm with every other storage-refusal seam.
 *
 * @param runId - The run that no longer exists.
 * @param sink - Synchronous observation sink receiving the diagnostic.
 * @returns The refused outcome.
 */
function runMissingRefusal(
  runId: RunId,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): RunProgressionOutcome {
  const message = `Run ${runId} no longer exists`;
  sink.emit({
    type: 'ERROR_OCCURRED',
    payload: { message, code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.missing },
  });
  return {
    kind: 'refused',
    runId,
    reason: 'run_missing',
    code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.missing,
    message,
    recovery: 'permanent',
  };
}

/**
 * Attempt a terminal-at-activation release, then preserve the terminal's owed
 * upward propagation even when that release refuses.
 *
 * The release refused (a held execution lease), but the terminal is durable and
 * the parent advance targets a DIFFERENT run, so propagation is not blocked by
 * the lease. The old collect path's unconditional post-drive propagation ran
 * here; dropping it would strand a waiting parent behind a refusal whose remedy
 * names only the release.
 *
 * A permanent recovery requirement is not hidden behind a retryable
 * propagation refusal. Otherwise the propagation refusal is the more specific
 * composition result and outranks the release refusal: hiding a possibly
 * permanent propagation failure behind retryable release contention would tell
 * an orchestrator to spin on a composition whose real failure never reaches any
 * machine-readable outcome (#853 review F5). Both diagnostics have already been
 * delivered through the gated sink either way — the release's before this
 * ranking, the propagation's from the callable.
 *
 * @param args - Terminal run, session service, gated sink, and propagation port.
 * @param args.sessionService - Service that releases the terminal run's session ownership.
 * @param args.runId - Terminal run to release and propagate.
 * @param args.source - Durable provenance for the terminal being propagated.
 * @param args.sink - Gated observation sink for release diagnostics.
 * @param args.propagateTerminal - Frontend callable for owed upward propagation.
 * @returns The refusal that wins composition, or null when release committed.
 */
async function releaseThenPropagateTerminal(args: {
  readonly sessionService: SessionService;
  readonly runId: RunId;
  readonly source: TerminalPropagationSource;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly propagateTerminal: TerminalPropagation;
}): Promise<RunProgressionOutcome | null> {
  const refusedRelease = await releaseTerminalTarget(args);
  if (refusedRelease === null) return null;

  const propagated = await args.propagateTerminal({
    runId: args.runId,
    source: args.source,
    sink: args.sink,
  });
  if (propagated.kind !== 'refused') return refusedRelease;

  const propagationRefusal = propagationRefusalOutcome(propagated);
  return refusedRelease.recovery === 'permanent' && propagated.recovery !== 'permanent'
    ? refusedRelease
    : propagationRefusal;
}

/**
 * Derive the outcome for a run whose progression was settled outside this
 * frame from its durable state alone.
 *
 * Two propagation postures share this reload, distinguished by
 * `propagateTerminal`:
 *
 * - **Flow-back settled the run** (`propagateTerminal` absent): synchronous
 *   inline flow-back already performed any propagation and release its
 *   terminal owed, so a terminal here is only reported.
 * - **Nothing owned the terminal yet** (`propagateTerminal` present): a
 *   terminal discovered by this reload committed concurrently and has not been
 *   propagated, so it is handed to the callable before being reported. This is
 *   the healing pass the old collect path performed unconditionally after its
 *   activation.
 *
 * @param args - Manager, run, sink, wait reason, and the optional propagation posture.
 * @param args.manager - State manager used to reload the durable state.
 * @param args.runId - The run whose rest state is reported.
 * @param args.sink - Synchronous observation sink receiving a refusal's diagnostic.
 * @param args.runningReason - Wait reason reported when the run is still running.
 * @param args.propagateTerminal - Present when a discovered terminal still owes
 *   its parent the advance; absent when flow-back already owned it.
 * @returns The outcome the durable state supports.
 */
async function outcomeFromDurableState(args: {
  readonly manager: RunbookStateManager;
  readonly runId: RunId;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly runningReason: RunProgressionWaitReason;
  readonly propagateTerminal?: TerminalPropagation;
}): Promise<RunProgressionOutcome> {
  const state = await args.manager.load(args.runId);
  if (!state) return runMissingRefusal(args.runId, args.sink);
  if (state.lifecycle === 'completed' || state.lifecycle === 'stopped') {
    const terminal =
      state.lifecycle === 'completed' ? ('completed' as const) : ('stopped' as const);
    if (args.propagateTerminal) {
      return concludeTerminal({
        runId: args.runId,
        terminal,
        source: terminalPropagationSourceFromState(state),
        propagateTerminal: args.propagateTerminal,
        sink: args.sink,
      });
    }
    return { kind: terminal, runId: args.runId };
  }
  return { kind: 'waiting', runId: args.runId, reason: args.runningReason };
}

/**
 * A synchronous observation-delivery failure: the reporting channel threw
 * while an observation (or other rendering) was being delivered.
 *
 * Raised by the activation's delivery gate, and — since the gate must hold
 * uniformly across the frontend-supplied composition callables (#853 review
 * F1) — also the type a Category-C callable (or the frontend plumbing beneath
 * it) throws to signal that ITS reporting channel failed mid-turn. The
 * activation boundary is the only catcher; there it becomes the closed
 * outcome's `failed` arm (`observation_delivery_failed`). Any other error
 * escaping the activation is a real defect and deliberately propagates.
 */
export class ObservationDeliveryError extends Error {
  /** The run whose observation could not be delivered, when the thrower knew it. */
  readonly runId?: RunId;

  /**
   * Wrap a reporting-channel failure as the typed delivery-failure signal.
   *
   * @param cause - What the reporting channel threw.
   * @param runId - The run whose observation could not be delivered, if known
   *   at the throw site (the activation's gate knows it; adapters may not).
   */
  constructor(
    /** What the reporting channel threw. */
    cause: unknown,
    /** The run whose observation could not be delivered, if known. */
    runId?: RunId,
  ) {
    super(
      runId === undefined
        ? 'Observation delivery failed'
        : `Observation delivery failed for run ${runId}`,
      { cause },
    );
    this.name = 'ObservationDeliveryError';
    if (runId !== undefined) this.runId = runId;
  }
}

/**
 * The observation commit gate (#853): wrap the caller's sink so a delivery
 * failure is one typed condition raised at the emit site.
 *
 * Every emission inside the activation flows through this one wrapper, so the
 * gate holds uniformly: a throwing sink unwinds the current turn before any
 * subsequent effect can begin, and the activation boundary converts the unwind
 * into the `failed` outcome. The preceding durable commit is untouched — the
 * gate sits strictly after commits, so nothing is rolled back and no lifecycle
 * is rewritten.
 *
 * The gate wraps refusal-diagnostic emissions too, and that is ADR 0003's
 * specified semantics, not an oversight: a delivery failure fails only the
 * INVOCATION, and the `failed` outcome's `retryable` classifies the reporting
 * channel — never the condition whose diagnostic was being delivered. A sink
 * that deterministically throws on a permanent refusal's diagnostic therefore
 * yields `failed`/`retryable` on every activation: nothing was committed, so
 * re-activation re-diagnoses the same refusal and re-attempts the same
 * delivery. The caller's remedy is to repair the reporting channel; the
 * underlying refusal is re-reported, not lost, once delivery succeeds.
 *
 * @param sink - The caller's synchronous observation sink.
 * @param runId - The run whose observations are being delivered.
 * @returns A sink whose `emit` raises {@link ObservationDeliveryError}.
 */
function gateObservationDelivery(
  sink: Pick<ExecutionEventEmitter, 'emit'>,
  runId: RunId,
): Pick<ExecutionEventEmitter, 'emit'> {
  return {
    emit(event) {
      try {
        sink.emit(event);
      } catch (cause) {
        // A rethrown gate failure keeps its identity: a callable that emitted
        // through this gated sink surfaces the ORIGINAL typed failure, not a
        // failure wrapped in a failure.
        if (cause instanceof ObservationDeliveryError) throw cause;
        throw new ObservationDeliveryError(cause, runId);
      }
    },
  };
}

/**
 * The completion-turn machine-refusal reason → reported code and recovery map.
 *
 * Type-driven rather than a two-arm conditional: a reason added to the
 * completion arm of the machine's refused intent fails compilation here until
 * it is classified, instead of absorbing into whichever arm the conditional
 * defaulted to. Each entry reports the code the same condition already carries
 * at its completion or storage seam, so a remap there changes this seam with
 * it.
 *
 * `completion_not_committed` is contention on a still-running row, so it is the
 * retryable arm; a target mismatch needs a different explicit action. Every
 * OTHER refusal reason belongs to the frontier/entry turn and is classified by
 * {@link TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND} further down the loop — one
 * canonical classification per condition, never two (#853 review F3).
 */
const MACHINE_REFUSAL_CLASSIFICATION = {
  completion_not_committed: {
    code: TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification,
    recovery: 'retryable',
  },
  completion_target_mismatch: {
    code: COMPLETION_TARGET_MISMATCH_CODE,
    recovery: 'permanent',
  },
} as const satisfies Record<
  CompletionRefusalReason,
  { readonly code: string; readonly recovery: RunProgressionRecovery }
>;

/** The refusal reasons produced by the machine's completion turn. */
type CompletionRefusalReason = 'completion_not_committed' | 'completion_target_mismatch';

/**
 * Project one run state onto the exact content the store persists.
 *
 * The store round-trips run state through JSON, which DROPS every key whose
 * value is `undefined`. A state the activation is still holding in memory —
 * the `nextState` a machine turn just produced — therefore carries keys a
 * reload of the very same row does not, and `isDeepStrictEqual` distinguishes
 * an absent key from a present-but-`undefined` one. Comparing the two shapes
 * directly reports "changed" for a row nobody wrote, so both re-selection
 * seams must compare durable projections rather than raw objects.
 *
 * @param state - Run state from memory or from a durable read.
 * @returns The same state with every `undefined`-valued key removed, recursively.
 */
function durableProjection(state: RunbookState): unknown {
  return dropUndefinedValues(state);
}

/**
 * Recursively drop `undefined`-valued keys, mirroring the store's JSON write.
 *
 * @param value - Any value reachable from a run state.
 * @returns The value with `undefined`-valued object keys removed.
 */
function dropUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefinedValues);
  if (typeof value !== 'object' || value === null) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    projected[key] = dropUndefinedValues(entry);
  }
  return projected;
}

/**
 * Whether a freshly captured row is semantically the row whose progression
 * intent and command input were selected.
 *
 * Every persisted field that can affect cursor selection, completion priority,
 * template expansion, command input, or machine hydration participates. Two
 * differences are deliberately ignored, and both are non-differences once the
 * row reaches disk:
 *
 * - `updatedAt`, which is persistence bookkeeping, so a writer that rewrote an
 *   otherwise identical row does not invalidate the selected effect.
 * - The in-memory/persisted spelling of an absent optional field. Both operands
 *   are compared in their PERSISTENCE shape (the JSON round-trip), because one
 *   side may be a state this activation derived in memory — where an optional
 *   field can be present and `undefined` — and the other a row reloaded from
 *   SQLite, where the same absence is a missing key. `isDeepStrictEqual`
 *   distinguishes those; the storage layer cannot represent the difference, so
 *   treating them as distinct would refuse a row that is byte-identical to the
 *   one selected.
 *
 * Both sides are compared as {@link durableProjection}s, so an in-memory state
 * and a reload of the row it was written to compare equal. Without that, EVERY
 * re-selection seam reported a phantom change on its first pass and re-entered
 * the execution unit — announcing the same `STEP_ENTERED` twice per turn.
 *
 * @param selected - The state whose machine output selected the command.
 * @param captured - The state atomically captured immediately before the effect.
 * @returns Whether the captured row still supports the selected command effect.
 */
function isSameProgressionSelectionState(selected: RunbookState, captured: RunbookState): boolean {
  return isDeepStrictEqual(
    durableProjection({ ...selected, updatedAt: '' }),
    durableProjection({ ...captured, updatedAt: '' }),
  );
}

/**
 * Activate Run Progression for one run under one verified authority.
 *
 * Drives machine-selected fenced turns — resolved-completion application,
 * re-entry frontier projection and consumption, execution-unit entry, command
 * execution, inline child dispatch, and terminal propagation — until the
 * composition awaits external input, hands back a refusal, or reaches a
 * terminal. Loading and restoring state are inert; this call is the explicit
 * activation.
 *
 * Observation delivery is the commit gate: after each durable commit its
 * observations are delivered synchronously through `deps.sink`, and no
 * subsequent effect begins until delivery returns. A throwing sink ends the
 * activation with the `failed` outcome (`observation_delivery_failed`,
 * `retryable`): the committed turn stays durable, no terminal is synthesized,
 * and the next activation resumes from current durable state without replaying
 * delivered or failed observations — there is no outbox and no event log.
 * `retryable` because re-activating with a working reporting channel is the
 * defined remedy; the run itself rests at its last committed boundary.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, steps, sink, and frontend effect callables.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @returns The closed progression outcome.
 * @throws {Error} If a core service throws on invalid persisted state, a
 *   programming invariant, or an unknown defect — deliberately not normalized
 *   into the closed outcome.
 * @throws {InvalidRunbookStateError} If the run's persisted snapshot is
 *   structurally invalid (malformed frontier, unknown cursor, missing render
 *   context). Per the no-migration rule the recovery is explicit user action.
 */
export async function activateRunProgression(
  authority: RunProgressionAuthority,
  deps: RunProgressionDeps,
  entryBoundary: RunProgressionEntryBoundary = { kind: 'resume' },
): Promise<RunProgressionOutcome> {
  try {
    return await driveProgression(authority, deps, entryBoundary);
  } catch (error) {
    if (error instanceof ObservationDeliveryError) {
      // The sink's thrown cause is arbitrary frontend code — the exact
      // cross-realm case the shared helper exists for (CLAUDE.md § helpers).
      const cause = getErrorMessage(error.cause);
      const runId = error.runId ?? authority.runId;
      return {
        kind: 'failed',
        runId,
        reason: 'observation_delivery_failed',
        message: `Observation delivery failed for run ${runId}; the last committed turn is durable — inspect the run and re-activate (${cause})`,
        recovery: 'retryable',
      };
    }
    throw error;
  }
}

/**
 * The activation body: every emission goes through the gated sink constructed
 * here, so {@link activateRunProgression}'s boundary catch is the single point
 * where a delivery failure becomes the closed outcome.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, steps, sink, and frontend effect callables.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @returns The closed progression outcome.
 */
async function driveProgression(
  authority: RunProgressionAuthority,
  deps: RunProgressionDeps,
  entryBoundary: RunProgressionEntryBoundary,
): Promise<RunProgressionOutcome> {
  const { manager, actorService, sessionService, actorMutationRunner } = deps;
  const runId = authority.runId;
  const sink = gateObservationDelivery(deps.sink, runId);

  const state = await manager.load(runId);
  if (!state) return runMissingRefusal(runId, sink);
  let steps = await deps.loadSteps(state);
  if (!(await actorService.assertFreshState(runId, steps))) {
    return runMissingRefusal(runId, sink);
  }
  const prompted = state.prompted;
  const completionService = new RunbookCompletionService(manager, actorService);
  // Both loop-invariant: the parsed steps never change across an activation,
  // and the fenced compute callback below re-runs once per CAS attempt, so the
  // readonly-shedding copy is made once here rather than per attempt.
  let stepsArray = [...steps];
  let currentState: RunbookState = state;
  const conclude = (
    terminal: 'completed' | 'stopped',
    source: TerminalPropagationSource,
  ): Promise<RunProgressionOutcome> =>
    concludeTerminal({
      runId,
      terminal,
      source,
      propagateTerminal: deps.propagateTerminal,
      sink,
    });
  const releaseTerminal = (
    source: TerminalPropagationSource,
  ): Promise<RunProgressionOutcome | null> =>
    releaseThenPropagateTerminal({
      sessionService,
      runId,
      source,
      sink,
      propagateTerminal: deps.propagateTerminal,
    });
  const durableOutcome = (
    runningReason: RunProgressionWaitReason,
    propagation: 'owed' | 'settled' = 'owed',
  ): Promise<RunProgressionOutcome> =>
    outcomeFromDurableState({
      manager,
      runId,
      sink,
      runningReason,
      ...(propagation === 'owed' ? { propagateTerminal: deps.propagateTerminal } : {}),
    });

  if (
    entryBoundary.kind === 'after_observed_transition' &&
    entryBoundary.lifecycle !== 'running' &&
    entryBoundary.lifecycle !== currentState.lifecycle
  ) {
    throw new Error(
      `Run ${runId} entered progression after an observed ${entryBoundary.lifecycle} transition but durable lifecycle is ${String(currentState.lifecycle)}`,
    );
  }

  const terminalIngressAlreadyObserved =
    entryBoundary.kind === 'after_observed_transition' &&
    entryBoundary.lifecycle !== 'running' &&
    entryBoundary.lifecycle === currentState.lifecycle;
  let terminalIngressSource = terminalPropagationSourceFromState(currentState);
  if (
    entryBoundary.kind === 'after_observed_transition' &&
    entryBoundary.lifecycle !== 'running' &&
    entryBoundary.lifecycle === currentState.lifecycle
  ) {
    terminalIngressSource = entryBoundary.source;
  }

  // A run already terminal at activation is reported, released, and
  // propagated — never re-driven. Restoration stays inert; this reporting is
  // the explicit activation's first (and only) turn for such a run.
  if (currentState.lifecycle === 'stopped') {
    if (terminalIngressAlreadyObserved) {
      return conclude('stopped', terminalIngressSource);
    }
    emitTerminalAtActivation({ sink, steps, state: currentState, terminal: 'stopped' });
    const refusedRelease = await releaseTerminal(terminalIngressSource);
    if (refusedRelease) {
      // The release refused (a held execution lease), but the terminal is
      // durable and the parent advance targets a DIFFERENT run, so propagation
      // is not blocked by the lease. The old collect path's unconditional
      // post-drive propagation ran here; dropping it would strand a waiting
      // parent behind a refusal whose remedy names only the release.
      //
      // `releaseTerminal` also preserves the owed upward propagation and ranks
      // coincident refusals without assuming every release refusal is retryable.
      return refusedRelease;
    }
    return conclude('stopped', terminalIngressSource);
  }
  if (currentState.lifecycle === 'completed') {
    if (terminalIngressAlreadyObserved) {
      return conclude('completed', terminalIngressSource);
    }
    // Release BEFORE announcing completion, as progression always has: a refused
    // release leaves the run targeted, and a stream that already announced
    // RUNBOOK_COMPLETED would assert a clean finish the outcome contradicts.
    const refusedRelease = await releaseTerminal(terminalIngressSource);
    if (refusedRelease) {
      return refusedRelease;
    }
    emitTerminalAtActivation({ sink, steps, state: currentState, terminal: 'completed' });
    return conclude('completed', terminalIngressSource);
  }

  // Counts only the write-free frontier re-derives, never the turns that made
  // progress: an ordinary multi-step drive is unbounded by design.
  let reselects = 0;
  let progressionFeedback: RunProgressionMachineFeedback = { kind: 'activation' };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // The compiled machine selects whether completion application is the next
    // fenced turn. The runtime only reads that typed intent and mechanically
    // executes ONE application before returning to the machine.
    const progressionIntent = await actorService.selectRunProgressionIntent(
      currentState,
      steps,
      progressionFeedback,
      authority,
      actorMutationRunner,
    );
    progressionFeedback = { kind: 'activation' };
    if (progressionIntent.kind === 'apply_completion') {
      const completionTurn = await applyMachineSelectedCompletionTurn({
        completionService,
        manager,
        sink,
        runId,
        steps,
        authority,
      });
      if (completionTurn.kind === 'terminal') {
        // Either this selected apply committed terminal + Run Release, or an
        // authoritative reload found that a competing apply already did. In
        // both cases the turn carries durable result provenance and only
        // upward propagation remains; observation belongs solely to the
        // process whose apply committed.
        return conclude(completionTurn.intent.kind, completionTurn.source);
      }
      if (completionTurn.kind === 'missing') {
        return runMissingRefusal(runId, sink);
      }
      currentState = completionTurn.state;
      // Completion application may project child outputs into the parent's
      // variables. Resolve the graph again before selecting or entering the
      // next execution unit so templates observe the state that the machine
      // just committed rather than the activation's ingress variables.
      steps = await deps.loadSteps(currentState);
      stepsArray = [...steps];
      if (completionTurn.kind === 'feedback') {
        progressionFeedback = completionTurn.feedback;
      }
      continue;
    }

    if (progressionIntent.kind === 'waiting') {
      // Waiting is the only machine intent whose turn performs no effect. Use
      // that inert boundary for one authoritative stability read: a completion
      // (or any other progression-relevant state) committed after selection
      // must be selected now, not left queued behind a stale waiting hand-back.
      const durable = await manager.load(runId);
      if (!durable) return runMissingRefusal(runId, sink);
      if (durable.lifecycle === 'completed' || durable.lifecycle === 'stopped') {
        return conclude(durable.lifecycle, terminalPropagationSourceFromState(durable));
      }
      if (!isSameProgressionSelectionState(currentState, durable)) {
        currentState = durable;
        continue;
      }
      return { kind: 'waiting', runId, reason: progressionIntent.reason };
    }

    if (
      progressionIntent.kind === 'refused' &&
      (progressionIntent.reason === 'completion_not_committed' ||
        progressionIntent.reason === 'completion_target_mismatch')
    ) {
      const { code, recovery } = MACHINE_REFUSAL_CLASSIFICATION[progressionIntent.reason];
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message: progressionIntent.message, code },
      });
      return {
        kind: 'refused',
        runId,
        reason: progressionIntent.reason,
        code,
        message: progressionIntent.message,
        recovery,
      };
    }

    // The SAME selection also owns the frontier/entry decision: XState decides,
    // and the runtime executes only the state the restored machine selected.
    const progression = progressionIntent;
    if (progression.kind === 'reselect') {
      // A reselect makes no progress: the machine selected the frontier turn,
      // another writer moved the frontier before the fenced capture, and this
      // re-derives against the row that writer committed. CLAUDE.md
      // § Concurrent write synchronization requires such a loop to be bounded
      // by the store's own exported budget and to report
      // `concurrent_modification` once it is spent, rather than spin — so the
      // budget and the pacing are imported, never mirrored here.
      reselects += 1;
      if (reselects >= DEFAULT_MUTATE_ATTEMPTS) {
        const code = TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification;
        const message = `Run ${runId} could not capture a stable re-entry frontier in ${String(DEFAULT_MUTATE_ATTEMPTS)} attempts; another writer replaced it each time — retry`;
        sink.emit({ type: 'ERROR_OCCURRED', payload: { message, code } });
        return {
          kind: 'refused',
          runId,
          reason: 'frontier_reselect_exhausted',
          code,
          message,
          recovery: 'retryable',
        };
      }
      await delay(mutateBackoffMs(reselects));
      currentState = progression.state;
      continue;
    }
    if (progression.kind === 'refused') {
      if (progression.reason === 'run_missing') {
        return runMissingRefusal(runId, sink);
      }
      if (progression.reason === 'actor_context_required') {
        sink.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message: FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
            code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED,
          },
        });
        return {
          kind: 'refused',
          runId,
          reason: 'actor_context_required',
          code: CLIErrorCodes.ACTOR_CONTEXT_REQUIRED,
          message: FRONTIER_AUTHORITY_REQUIRED_MESSAGE,
          recovery: 'provide_authority',
        };
      }
      if (progression.reason === 'projection_refused') {
        const message = `${FRONTIER_PROJECTION_REFUSED_MESSAGE}: ${progression.message}`;
        sink.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message,
            code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
          },
        });
        return {
          kind: 'refused',
          runId,
          reason: 'projection_refused',
          code: ErrorCodes.DELEGATION_INVARIANT_VIOLATED.code,
          message,
          recovery: 'permanent',
        };
      }
      if (progression.reason === 'consume_failed') {
        sink.emit({
          type: 'ERROR_OCCURRED',
          payload: {
            message: FRONTIER_CONSUME_FAILED_MESSAGE,
            code: ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code,
          },
        });
        return {
          kind: 'refused',
          runId,
          reason: 'consume_failed',
          code: ErrorCodes.DELEGATION_FRONTIER_CONSUME_FAILED.code,
          message: FRONTIER_CONSUME_FAILED_MESSAGE,
          recovery: 'retryable',
        };
      }
      if (
        progression.reason === 'frontier_disclosure_failed' ||
        progression.reason === 'entry_render_failed'
      ) {
        // A malformed persisted run keeps the repository-wide RD-309 recovery
        // on both entry paths; it outranks either refusal because the run
        // cannot be loaded at all and no retry or re-issue addresses that.
        if (progression.cause instanceof InvalidRunbookStateError) {
          throw progression.cause;
        }
        // Otherwise the two entry states differ only in what their turn had
        // already committed, and that is exactly the recovery split: the
        // post-consume failure lost transient bearers no retry can rebuild
        // (permanent, RD-833), while the pre-consume failure consumed nothing
        // and re-renders on the next activation (retryable, RD-504).
        const disclosure = progression.reason === 'frontier_disclosure_failed';
        const error = disclosure
          ? Errors.frontierDisclosureFailed(runId, progression.message)
          : Errors.runProgressionEntryFailed(runId, progression.message);
        sink.emit({
          type: 'ERROR_OCCURRED',
          payload: { message: error.message, code: error.code },
        });
        return {
          kind: 'refused',
          runId,
          reason: progression.reason,
          code: error.code,
          message: error.message,
          recovery: disclosure ? 'permanent' : 'retryable',
        };
      }
      if (progression.reason === 'claim_superseded') {
        const code = TRANSACTIONAL_REFUSAL_CODE_BY_KIND.claim_superseded;
        sink.emit({
          type: 'ERROR_OCCURRED',
          payload: { message: progression.message, code },
        });
        return {
          kind: 'refused',
          runId,
          reason: 'claim_superseded',
          code,
          message: progression.message,
          recovery: TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND.claim_superseded,
        };
      }
      // The frontier consume's own storage refusals keep the classification
      // the command turn gives the identical condition: the runner already
      // recovered the named attempt inline, so the run is unblocked and a
      // re-activation re-projects the still-persisted frontier.
      // Exhaustive: every other reason returned above. Without this, a reason
      // added to `RunProgressionMachineIntent` later would fall through to the
      // single-run `recovery_required` code and message rather than failing to
      // compile.
      if (
        progression.reason !== 'recovery_required' &&
        progression.reason !== 'aggregate_recovery_required' &&
        // Both completion reasons already returned from the completion-refusal
        // arm above; they are re-excluded here only because a compound guard
        // does not narrow the union on its false branch.
        progression.reason !== 'completion_not_committed' &&
        progression.reason !== 'completion_target_mismatch'
      ) {
        const _exhaustive: never = progression.reason;
        throw new Error(
          `Unhandled Run Progression refusal reason: ${String(_exhaustive as string)}`,
        );
      }
      const isAggregate = progression.reason === 'aggregate_recovery_required';
      const code = isAggregate
        ? TRANSACTIONAL_REFUSAL_CODE_BY_KIND.aggregate_recovery_required
        : TRANSACTIONAL_REFUSAL_CODE_BY_KIND.recovery_required;
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message: progression.message, code },
      });
      // `recovery_required` names TWO conditions that share the word, and they
      // do not share a recovery — so the classification reads which one
      // produced the intent rather than the word alone:
      //
      // - A run restored INTO `recoveryRequired` (#854): nothing recovered it,
      //   asking did not start a recovery, and only an explicit GOTO
      //   reconcile/retry leaves that state, so no repeat of THIS gesture can
      //   succeed — `permanent`.
      // - The fence returning the store's identical refusal (#853 review F3):
      //   the mutation runner already drove execution recovery inline before
      //   refusing, so the run is unblocked for a LATER activation and the
      //   refusal reports only that THIS mutation did not commit — retryable,
      //   the same classification the command turn gives the same fence.
      const parkedInRecovery =
        asTerminalSnapshotOrDefault(currentState.snapshot).value === RECOVERY_REQUIRED_STATE_NAME;
      return {
        kind: 'refused',
        runId,
        reason: progression.reason,
        code,
        message: progression.message,
        recovery: parkedInRecovery
          ? 'permanent'
          : isAggregate
            ? TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND.aggregate_recovery_required
            : TRANSACTIONAL_REFUSAL_RECOVERY_BY_KIND.recovery_required,
      };
    }
    if (progression.kind !== 'entered') {
      throw new Error(`Unhandled Run Progression intent: ${progression.kind}`);
    }
    currentState = progression.state;
    const currentStep = findStepOrThrow(steps, currentState.step, currentState.id);
    const entered: ExecutionUnitEntry = progression.entered;
    for (const effect of entered.effects) {
      sink.emit(effect.event);
    }

    // A one-shot intent is consumed by the launch it drives; on the projected
    // path the seam's consume already committed, so acting on an intent here
    // would launch a child the re-entry never armed.
    if (progression.frontier === 'none' && entered.kind === 'inline-launch') {
      const dispatched = await deps.dispatchInlineChild({
        intent: entered.launch,
        prompted,
        steps,
        sink,
      });
      switch (dispatched.kind) {
        case 'composition_outcome':
          return dispatched.outcome;
        case 'waiting':
          return durableOutcome('inline_child_active');
        case 'flow_back_complete':
          // Flow-back already drove this run's progression, including any
          // propagation and release its terminal owed — no propagateTerminal
          // here, or a linked terminal would advance its parent twice.
          return durableOutcome('inline_flow_back_settled', 'settled');
        case 'flow_back_refused':
          return {
            kind: 'refused',
            runId: dispatched.runId,
            reason: 'inline_flow_back_refused',
            ...(dispatched.code !== undefined ? { code: dispatched.code } : {}),
            message:
              dispatched.message ??
              'Inline flow-back concluded fail-closed; see the preceding diagnostics for the refusing run',
            recovery: dispatched.recovery,
          };
        case 'launch_refused':
          return {
            kind: 'refused',
            runId,
            reason: 'inline_launch_refused',
            code: dispatched.code,
            message: dispatched.message,
            recovery: dispatched.recovery,
          };
        case 'child_terminal': {
          const durable = await manager.load(runId);
          if (durable && durable.lifecycle !== 'completed' && durable.lifecycle !== 'stopped') {
            // A terminal child without flow-back leaves the composing run unable
            // to advance, regardless of which terminal the child reached.
            // Reporting `waiting` would hide a permanent wedge. The child stream
            // already announced its terminal; this diagnostic names the missing
            // linkage and prescribes explicit recovery.
            const wedgeMessage = `Inline child of run ${runId} ${dispatched.status} without linked flow-back; inspect the child run, then finish, stop, or prune it before re-running`;
            sink.emit({
              type: 'ERROR_OCCURRED',
              payload: { message: wedgeMessage, code: ErrorCodes.LAUNCH_FAILED.code },
            });
            return {
              kind: 'refused',
              runId,
              reason: 'inline_child_unlinked',
              code: ErrorCodes.LAUNCH_FAILED.code,
              message: wedgeMessage,
              recovery: 'permanent',
            };
          }
          // No flow-back occurred for this arm, so a terminal discovered on the
          // reload still owes its parent the advance — propagation posture on.
          return durableOutcome('inline_child_active');
        }
        default: {
          const _exhaustive: never = dispatched;
          throw new Error(
            `Unhandled inline dispatch result: ${(_exhaustive as { kind: string }).kind}`,
          );
        }
      }
    }

    if (entered.kind !== 'runnable') {
      progressionFeedback = { kind: 'awaiting_input' };
      continue;
    }

    // Turn: one fenced command execution — capture, lease, effect, commit —
    // under this activation's one authority.
    const { code: expandedCommandCode, displayCommand, rdInjected } = entered.command;
    let previousState = currentState;
    const fencedCommand = await actorMutationRunner.run<RunbookState>({
      runId,
      ...(authority.claimKey !== undefined ? { claimKey: authority.claimKey } : {}),
      makeRecoveryActor: (recoveryState) =>
        actorService.createRecoveryActor(recoveryState, stepsArray),
      // The command intent and its expanded input were derived from
      // `currentState`. Capture is the first place that can prove no writer
      // changed that row after selection. A changed row returns before lease
      // acquisition/mark-effect, so activation can ask the compiled machine
      // again without executing or recovering an ambiguous side effect.
      beforeEffect: (capturedState) =>
        isSameProgressionSelectionState(currentState, capturedState)
          ? { kind: 'continue' as const }
          : { kind: 'return' as const, value: capturedState },
      terminalRelease: { role: 'addressed' },
      compute: async (capturedState) => {
        previousState = capturedState;
        const prepared = await actorService.prepareActorMutation(
          runId,
          previousState,
          stepsArray,
          {
            type: 'EXECUTE_COMMAND',
            command: expandedCommandCode,
            displayCommand,
            runbookPath: capturedState.runbookPath,
            rdInjected,
          },
          authority.delegationRuntime
            ? { issueDelegationCredential: authority.delegationRuntime.issueDelegationCredential }
            : {},
        );
        return { ...prepared, previousState };
      },
    });
    if (fencedCommand.kind === 'pre_effect_return') {
      currentState = fencedCommand.value;
      if (currentState.lifecycle === 'completed' || currentState.lifecycle === 'stopped') {
        // A competing addressed transition can commit terminal + Run Release
        // before this command's capture. Addressed release preserves Terminal
        // Evidence, so capture succeeds but the selected command is stale. No
        // effect ran: converge on the durable terminal instead of asking a
        // terminal snapshot for another non-terminal machine intent.
        return durableOutcome('awaiting_input');
      }
      continue;
    }
    if (fencedCommand.kind !== 'committed') {
      // The fence refused: no terminal was committed, the run stays running
      // and targeted. The refusal is observed and returned — never rendered as
      // a stop (#849).
      const code = fencedRefusalCode(fencedCommand);
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message: fencedCommand.message, code },
      });
      return {
        kind: 'refused',
        runId,
        reason: 'command_not_committed',
        code,
        message: fencedCommand.message,
        recovery: fencedRefusalRecovery(fencedCommand),
      };
    }
    const cmdSync = fencedCommand.value;
    const fenceCommittedTerminal =
      cmdSync.state.lifecycle === 'completed' || cmdSync.state.lifecycle === 'stopped';
    const syncEffects = cmdSync.effects;
    for (const effect of syncEffects) {
      sink.emit(effect.event);
    }

    const commandOutput = syncEffects.find(
      (
        effect,
      ): effect is ExecutionObservationEffect & {
        commandOutput: NonNullable<ExecutionObservationEffect['commandOutput']>;
      } => effect.commandOutput !== undefined,
    )?.commandOutput;

    if (commandOutput?.kind !== 'completed') {
      // The command produced no completion (policy denial, capture failure).
      // Emit the same terminal projection the former driver derived, then report the
      // committed lifecycle rather than a blanket stop.
      const observation = deriveTransitionObservation({
        steps,
        currentStep,
        previousState,
        updatedState: cmdSync.state,
        snapshot: cmdSync.snapshot,
        result: 'fail',
      });
      for (const event of observation.events) {
        if (
          event.type === 'ERROR_OCCURRED' ||
          event.type === 'RUNBOOK_STOPPED' ||
          event.type === 'RUNBOOK_COMPLETED'
        ) {
          sink.emit(event);
        }
      }
      if (cmdSync.state.lifecycle === 'stopped') {
        return conclude('stopped', terminalPropagationSourceFromState(cmdSync.state));
      }
      if (cmdSync.state.lifecycle === 'completed') {
        return conclude('completed', terminalPropagationSourceFromState(cmdSync.state));
      }
      // A committed, still-running turn without command output violates the
      // command actor's contract. The fence already committed, so no observed
      // refusal can prove contention caused it; relabeling every deterministic
      // defect as concurrent modification invites an infinite retry loop. Keep
      // programming invariants outside the closed outcome as ADR 0003 requires.
      throw new Error(`Run ${runId} committed a fenced command turn without a command result`);
    }

    const transitionResult = applyTransitionObservation({
      sink,
      steps,
      currentStep,
      previousState,
      updatedState: cmdSync.state,
      snapshot: cmdSync.snapshot,
      result: commandOutput.result,
      command: displayCommand,
    });
    if (transitionResult.status === 'done') {
      return conclude('completed', {
        kind: 'explicit-result',
        result: commandOutput.result,
      });
    }
    if (transitionResult.status === 'stopped') {
      return conclude('stopped', {
        kind: 'explicit-result',
        result: commandOutput.result,
      });
    }
    // The fenced commit released this run on `state.lifecycle`; when only the
    // lifecycle went terminal the observation above classified `continue`, and
    // continuing would drive a run this process already released.
    const lifecycle = cmdSync.state.lifecycle;
    if (fenceCommittedTerminal) {
      const terminalStatus = lifecycle === 'completed' ? 'completed' : 'stopped';
      sink.emit(
        deriveTerminalDrainObservationEvent({
          steps,
          currentStep,
          previousState,
          updatedState: cmdSync.state,
          snapshot: cmdSync.snapshot,
          status: terminalStatus === 'completed' ? 'done' : 'stopped',
          result: commandOutput.result,
        }),
      );
      return conclude(terminalStatus, {
        kind: 'explicit-result',
        result: commandOutput.result,
      });
    }
    currentState = transitionResult.state;
  }
}
