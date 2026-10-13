/**
 * XState-owned Run Progression activation (#851 / ADR 0003, one writer per
 * run since #901 / ADR 0005).
 *
 * The one public seam through which a continuation drives a run: a core
 * runtime explicitly activates the run's compiled machine under one verified,
 * run-bound {@link RunProgressionAuthority} and mechanically executes
 * machine-selected turns until the run awaits external input, hands back a
 * refusal, or reaches a terminal. Each turn contains at most one durable
 * commit: one conditional save naming the `state_version` the turn read. A
 * version that moved is refused as `command_not_committed` and never retried
 * — the run has exactly one owner, so a second writer is the defect the
 * refusal exists to make visible. Observations are delivered synchronously
 * through the caller's sink after each commit.
 *
 * The activation returns exactly one closed {@link RunProgressionOutcome}:
 * `waiting`, `completed`, `stopped`, `refused`, or `failed`. `stopped` is
 * reserved for an actual stopped lifecycle; a refusal that committed no
 * terminal returns `refused` and emits no `runbook_stopped` observation.
 *
 * The machine owns two decisions here (Fact 2 of the #901 plan): whether the
 * cursor waits for input or enters its execution unit. Composition rides the
 * same turns: an Inline Child is launched, driven and implicitly Collected
 * within the parent's progression (#903), and a Delegation's entry issues its
 * Claim Tickets (#904) — a Delegation's result reaches the parent only by the
 * owner's explicit Collect. The frontend supplies the command callable
 * through the actor service and the child-runbook preparer.
 *
 * @module runbook/run-progression
 */

import { isDeepStrictEqual } from 'node:util';
import type { ExecutionEventEmitter } from '../events/emitter.js';
import {
  deriveTerminalDrainObservationEvent,
  deriveTransitionObservation,
} from '../events/transition-observation.js';
import type { ExecutionObservationEffect } from '../events/execution-observation.js';
import { Errors } from '../errors/factory.js';
import { getErrorMessage } from '../errors.js';
import { CLIErrorCodes } from '../output/zod-schemas.js';
import {
  MachineEffectOutcomeUnknownError,
  type PreparedActorMutation,
  type RunbookActorService,
} from './actor-service.js';
import type { RunbookEvent, RunProgressionMachineFeedback } from './compiler.js';
import { findStepOrThrow } from './execution-units.js';
import type { ExecutionUnitEntry } from './execution-unit-entry.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import type { OwnedRun } from './run-authority.js';
import {
  classifyExecutionLease,
  commandOutcomeUnknownMessage,
  currentLeaseHolder,
  EXECUTION_INTERRUPTED_CODE,
  executionLeaseRefusal,
  holdInFlightAttempt,
  type ExecutionLease,
} from './execution-lease.js';
import type { ProcessIdentity } from './process-identity.js';
import type { RunId } from './run-id.js';
import {
  mintRunProgressionAuthority,
  type RunProgressionAuthority,
} from './run-progression-authority.js';
import {
  asTerminalSnapshotOrDefault,
  isRunbookComplete,
  isRunbookStopped,
} from './snapshot-utils.js';
import type { RunbookStateManager } from './state.js';
import type { VersionedRunState } from './storage/runbook-store.js';
import {
  childResultEvent,
  inlineDepthOf,
  inlineParentCounting,
  INLINE_CHILD_LAUNCH_FAILED_CODE,
  launchInlineChild,
  MAX_INLINE_CHILD_DEPTH,
} from './inline-progression.js';
import type { ExecutionUnitInlineChild } from './execution-unit-entry.js';
import type { PrepareChildRun } from './child-preparation.js';
import { currentInlineReservation } from './inline-child.js';
import { issueClaimTickets, withEnteredChildren } from './delegation-tickets.js';
import { countNumberedSteps } from './step-utils.js';
import { buildStepPosition } from './targeting.js';
import { extractLastMessage } from './transition-kernel.js';
import type { ResolvedStep, RunbookState } from './types.js';

/**
 * Symbolic code reported when a conditional run-state save is refused because
 * the row's `state_version` moved (ADR 0005). Registered in
 * `CLISymbolicErrorCodeValues`; the throwing form of the same condition is
 * RD-308.
 */
export const CONCURRENT_MODIFICATION_CODE = 'CONCURRENT_MODIFICATION';

/**
 * Machine-readable recovery classification for a non-terminal outcome.
 *
 * - `retryable` — the condition is transient; repeating the same gesture can
 *   succeed (a refused save, a broken reporting channel, a failed render).
 * - `permanent` — no retry of the same gesture can succeed; recovery is a
 *   different explicit action (finish, stop, prune, or restart the run).
 */
export type RunProgressionRecovery = 'retryable' | 'permanent';

/**
 * Why an activation yielded without a terminal.
 *
 * - `awaiting_input` — the cursor rests on a unit that needs an operator
 *   gesture (`rundown pass` / `rundown fail`).
 * - `collected` — a `collect_inline_child` activation committed the implicit
 *   Collect and rests at the parent's resulting position without driving it
 *   further (#903).
 */
export type RunProgressionWaitReason = 'awaiting_input' | 'collected';

/**
 * Why an activation refused without applying a terminal.
 *
 * - `run_missing` — the run no longer exists (a concurrent prune).
 * - `command_not_started` — the execution lease could not be set because
 *   another of the owner's commands moved the row since this activation read
 *   it, and no lease is held now. The command did not run and nothing was
 *   written. (A lease another attempt set in that window refuses as
 *   `execution_in_progress` / `execution_interrupted` instead.)
 * - `command_not_committed` — the command ran, but its attempt no longer held
 *   the execution lease when its finish was saved (another writer moved the
 *   row). The result was not recorded.
 * - `execution_in_progress` — a live attempt already holds the lease; the
 *   command was not started a second time.
 * - `execution_interrupted` — the attempt holding the lease died; Rundown
 *   never repeats its command, and the owner decides explicitly.
 * - `command_outcome_unknown` — this activation's command ran, but its finish
 *   could not be derived (the machine-effect wait timed out, or the actor
 *   reached an error state). The result was not recorded, the lease stays set,
 *   and the step is now Interrupted: Rundown never repeats the command, and
 *   the owner decides explicitly. Code `EXECUTION_INTERRUPTED`.
 * - `entry_render_failed` — rendering the selected unit's entry threw; nothing
 *   was committed and re-activation re-renders.
 * - `inline_child_launch_failed` — the Inline Child an inline substep reserved
 *   could not be launched: its runbook did not prepare, composes in a form
 *   this build does not run, nests deeper than {@link MAX_INLINE_CHILD_DEPTH}, or another
 *   of the owner's commands launched it first. The parent rests on the
 *   substep; the owner decides it with `pass` / `fail --step` (#903).
 * - `claim_tickets_not_issued` — the Claim Tickets for the entry's
 *   Delegations could not be recorded: another of the owner's commands moved
 *   the run since this activation read it. Nothing was written and no ticket
 *   was printed (#904).
 */
export type RunProgressionRefusalReason =
  | 'run_missing'
  | 'command_not_started'
  | 'command_not_committed'
  | 'execution_in_progress'
  | 'execution_interrupted'
  | 'command_outcome_unknown'
  | 'entry_render_failed'
  | 'inline_child_launch_failed'
  | 'claim_tickets_not_issued';

/**
 * Enumerated invocation-layer disruption.
 *
 * The observation commit gate constructs the `observation_delivery_failed`
 * arm whenever the caller's sink throws during synchronous post-commit
 * delivery — a broken renderer ends every activation this way, so frontends
 * must handle it. The run itself is untouched at its last committed boundary.
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
      /** Progression rests awaiting external input. */
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

/** Core services and the observation sink an activation drives. */
export interface RunProgressionDeps {
  /** State manager bound to the project directory. */
  readonly manager: RunbookStateManager;
  /** Actor service compiled for this project's runbooks; carries the command callable. */
  readonly actorService: RunbookActorService;
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
  /**
   * Start-identity source for the execution lease's `(pid, start id)`.
   * Defaults to the process-wide identity; tests inject a deterministic one.
   */
  readonly processIdentity?: ProcessIdentity;
  /**
   * The frontend service that prepares a child runbook (#903, #904). Without
   * it an inline substep refuses `inline_child_launch_failed`.
   */
  readonly prepareChildRun?: PrepareChildRun;
  /**
   * The observation sink for a run other than the activation's own — an
   * Inline Child progression descends into, or a parent it ascends to — so
   * each run's events carry that run's identity. Defaults to `sink`.
   */
  readonly sinkFor?: (state: RunbookState) => Pick<ExecutionEventEmitter, 'emit'>;
}

/**
 * The durable/observation boundary at which an explicit activation enters.
 *
 * `resume` means the activation owns reporting any terminal it discovers.
 * `after_observed_transition` is minted by the core transition seam after its
 * initiating commit and is consumed only after the frontend delivers that
 * commit's observation, so activation never re-announces a terminal the seam
 * already rendered.
 *
 * `collect_inline_child` is minted by core's command-target resolution for a
 * parent whose Current Inline Child is terminal but was never Collected (its
 * command died first). The activation commits that Collect — the one write the
 * crash lost — and rests: it launches nothing, runs no command, and does not
 * ascend, so the owner's command then applies at the parent's resulting
 * position (#903). A parent that no longer owes the Collect is refused
 * `command_not_committed` with nothing written.
 */
export type RunProgressionEntryBoundary =
  | { readonly kind: 'resume' }
  | {
      readonly kind: 'after_observed_transition';
      readonly lifecycle: 'running' | 'completed' | 'stopped';
    }
  | { readonly kind: 'collect_inline_child' };

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
 * Bind a freshly created run to its first progression.
 *
 * Called by the launch pipeline once `rundown run` has created the run and
 * printed its Owner Token: the creator IS the owner, so no further proof is
 * needed to mint the authority. Keeping the constructor in core preserves the
 * authority brand.
 *
 * @param state - Exact initialized run state.
 * @param steps - Parsed graph for the run.
 * @returns An activation directive bound to the run.
 */
export function progressionDirectiveForStartedRun(
  state: RunbookState,
  steps: readonly ResolvedStep[],
): Extract<RunProgressionDirective, { kind: 'activate' }> {
  return {
    kind: 'activate',
    authority: mintRunProgressionAuthority({ runId: state.id }),
    runbook: state.runbook,
    steps,
    entryBoundary: { kind: 'resume' },
  };
}

/**
 * Decide whether a caller-observed terminal run still owes composition a turn.
 *
 * Core, not the frontend, answers this. A terminal Inline Child owes its
 * parent the implicit Collect (#903): the directive activates progression on
 * the child at the observed terminal, and the activation ascends to the
 * parent. Any other terminal run composes with nothing.
 *
 * @param run - Durable terminal run state, with its linkage.
 * @param steps - Parsed graph for the run.
 * @returns `activate` for an inline child, otherwise `none`.
 * @throws {Error} When the supplied state is not terminal.
 */
export function progressionDirectiveForTerminalRun(
  run: Pick<VersionedRunState, 'state' | 'linkage'>,
  steps: readonly ResolvedStep[],
): RunProgressionDirective {
  const { state } = run;
  if (state.lifecycle === undefined || state.lifecycle === 'running') {
    throw new Error(`Run ${state.id} is not terminal`);
  }
  if (run.linkage?.kind !== 'inline' || state.lifecycle === 'abandoned') return { kind: 'none' };
  return {
    kind: 'activate',
    authority: mintRunProgressionAuthority({ runId: state.id }),
    runbook: state.runbook,
    steps,
    entryBoundary: { kind: 'after_observed_transition', lifecycle: state.lifecycle },
  };
}

/** Input to {@link commitRunProgressionEvent}. */
export interface CommitRunProgressionEventInput {
  /** Core-minted authority for the exact run. */
  readonly authority: RunProgressionAuthority;
  /** Durable state manager. */
  readonly manager: RunbookStateManager;
  /** Actor compiler used to derive the transition. */
  readonly actorService: RunbookActorService;
  /** Parsed graph for the run. */
  readonly steps: readonly ResolvedStep[];
  /** The run state the transition derives from, with the version it was read at. */
  readonly run: OwnedRun;
  /** Machine event to apply. */
  readonly event: RunbookEvent;
}

/**
 * Outcome of {@link commitRunProgressionEvent}.
 *
 * - `committed` — the one conditional save landed; `state` is what is now
 *   persisted and `prepared` carries the derivation's snapshot and effects.
 * - `concurrent_modification` — the row's version moved since `run` was read.
 *   Nothing was written. Refused, never retried.
 * - `missing` — the run no longer exists. Nothing was written.
 */
export type RunProgressionCommitResult =
  | {
      readonly kind: 'committed';
      readonly prepared: PreparedActorMutation;
      readonly state: RunbookState;
    }
  | { readonly kind: 'concurrent_modification' }
  | { readonly kind: 'missing' };

/**
 * Derive one machine transition from an exact run state and commit it under
 * the version that state was read at.
 *
 * The single commit shape every Run Progression turn uses: prepare the actor
 * mutation offline, then one conditional save. A version that moved is
 * reported, not retried — under one writer per run the only concurrent
 * writer is the owner's own second command, and a loop here would let it land
 * silently behind the first.
 *
 * @param input - Authority, services, graph, versioned run state and event.
 * @returns The committed state with its derivation, or a typed refusal.
 * @throws {Error} When the authority is bound to a run other than `input.run.state.id`.
 */
export async function commitRunProgressionEvent(
  input: CommitRunProgressionEventInput,
): Promise<RunProgressionCommitResult> {
  const { authority, manager, actorService, steps, run, event } = input;
  if (run.state.id !== authority.runId) {
    throw new Error(
      `Run Progression authority for ${authority.runId} cannot commit run ${run.state.id}`,
    );
  }
  const prepared = await actorService.prepareActorMutation(
    authority.runId,
    run.state,
    steps,
    event,
  );
  const saved = await manager.save(prepared.nextState, run.stateVersion);
  switch (saved.kind) {
    case 'committed':
      return { kind: 'committed', prepared, state: saved.state };
    case 'concurrent_modification':
      return { kind: 'concurrent_modification' };
    case 'missing':
      return { kind: 'missing' };
    default: {
      const _exhaustive: never = saved;
      return _exhaustive;
    }
  }
}

type TransitionApplication =
  | { readonly status: 'continue'; readonly state: RunbookState }
  | { readonly status: 'done' }
  | { readonly status: 'stopped' };

/**
 * Emit one applied transition's core-derived observation events and classify
 * the continuation.
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
 * Keeps the split between a machine-driven terminal snapshot and a
 * lifecycle-only terminal.
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
      // replayed.
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

/**
 * Diagnose and return the `run_missing` refusal.
 *
 * @param runId - The run that no longer exists.
 * @param sink - Gated observation sink the diagnostic is delivered through.
 * @returns The closed refusal.
 */
function runMissingRefusal(
  runId: RunId,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): RunProgressionOutcome {
  const message = `Run ${runId} no longer exists`;
  sink.emit({
    type: 'ERROR_OCCURRED',
    payload: { message, code: CLIErrorCodes.RUN_TARGET_UNAVAILABLE },
  });
  return {
    kind: 'refused',
    runId,
    reason: 'run_missing',
    code: CLIErrorCodes.RUN_TARGET_UNAVAILABLE,
    message,
    recovery: 'permanent',
  };
}

/**
 * A synchronous observation-delivery failure: the reporting channel threw
 * while an observation (or other rendering) was being delivered.
 *
 * Raised by the activation's delivery gate. The activation boundary is the
 * only catcher; there it becomes the closed outcome's `failed` arm
 * (`observation_delivery_failed`). Any other error escaping the activation is
 * a real defect and deliberately propagates.
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
 * channel — never the condition whose diagnostic was being delivered.
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
        // A rethrown gate failure keeps its identity.
        if (cause instanceof ObservationDeliveryError) throw cause;
        throw new ObservationDeliveryError(cause, runId);
      }
    },
  };
}

/**
 * Project one run state onto the exact content the store persists.
 *
 * The store round-trips run state through JSON, which DROPS every key whose
 * value is `undefined`. A state the activation is still holding in memory
 * therefore carries keys a reload of the very same row does not, and
 * `isDeepStrictEqual` distinguishes an absent key from a present-but-`undefined`
 * one. Comparing the two shapes directly reports "changed" for a row nobody
 * wrote, so the re-selection seam compares durable projections rather than
 * raw objects.
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
 * Whether a freshly loaded row is semantically the row whose progression
 * intent was selected.
 *
 * Every persisted field that can affect cursor selection, template expansion,
 * command input, or machine hydration participates. `updatedAt` is
 * persistence bookkeeping and is ignored, and both sides are compared as
 * {@link durableProjection}s so an in-memory state and a reload of the row it
 * was written to compare equal. Without that, the waiting arm reported a
 * phantom change on its first pass and re-entered the execution unit —
 * announcing the same `STEP_ENTERED` twice per turn.
 *
 * @param selected - The state whose machine output selected the turn.
 * @param durable - The state loaded immediately after selection.
 * @returns Whether the durable row still supports the selected turn.
 */
function isSameProgressionSelectionState(selected: RunbookState, durable: RunbookState): boolean {
  return isDeepStrictEqual(
    durableProjection({ ...selected, updatedAt: '' }),
    durableProjection({ ...durable, updatedAt: '' }),
  );
}

/**
 * Diagnose and return the refusal for a lease another attempt holds.
 *
 * @param runId - The run whose lease is held.
 * @param cursor - The run's step cursor as last read (the lease pins it).
 * @param cursor.step - Current top-level step.
 * @param cursor.substep - Current substep, when inside one.
 * @param lease - The held lease.
 * @param deps - Activation dependencies (process identity).
 * @param sink - Gated observation sink for the refusal diagnostic.
 * @returns The closed `execution_in_progress` / `execution_interrupted` refusal.
 */
function heldLeaseRefusal(
  runId: RunId,
  cursor: { readonly step: string; readonly substep?: string },
  lease: ExecutionLease,
  deps: RunProgressionDeps,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): RunProgressionOutcome {
  const condition = classifyExecutionLease(runId, lease, deps.processIdentity);
  const refusal = executionLeaseRefusal(runId, cursor, condition);
  const { code } = refusal;
  sink.emit({ type: 'ERROR_OCCURRED', payload: { message: refusal.message, code } });
  return {
    kind: 'refused',
    runId,
    reason: refusal.kind,
    code,
    message: refusal.message,
    // In Progress clears when the live attempt finishes; Interrupted needs a
    // different, explicit decision from the owner.
    recovery: refusal.kind === 'execution_in_progress' ? 'retryable' : 'permanent',
  };
}

/**
 * Set the execution lease for one command turn, or refuse the turn.
 *
 * @param runId - The run whose command is about to start.
 * @param current - The run as this activation read it.
 * @param deps - Activation dependencies (manager, process identity).
 * @param sink - Gated observation sink for the refusal diagnostic.
 * @returns The run at the version the lease produced, or the closed refusal.
 */
async function acquireTurnLease(
  runId: RunId,
  current: VersionedRunState,
  deps: RunProgressionDeps,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): Promise<
  | {
      readonly kind: 'acquired';
      readonly run: VersionedRunState;
      /** The lease the set produced. */
      readonly lease: ExecutionLease;
    }
  | { readonly kind: 'refused'; readonly outcome: RunProgressionOutcome }
> {
  const leased = await deps.manager.acquireExecutionLease(
    runId,
    current.stateVersion,
    currentLeaseHolder(deps.processIdentity),
  );
  switch (leased.kind) {
    case 'acquired':
      return {
        kind: 'acquired',
        run: { ...current, stateVersion: leased.stateVersion, lease: leased.lease },
        lease: leased.lease,
      };
    case 'missing':
      return { kind: 'refused', outcome: runMissingRefusal(runId, sink) };
    case 'concurrent_modification': {
      // Setting a lease moves the version, so a lease another attempt set
      // after this activation read the run surfaces here, not as `held`. ONE
      // read — never a retry of the set (ADR 0005) — tells the two apart, so
      // a racing activation reports the step In Progress (or Interrupted)
      // rather than a generic modification.
      const reread = await deps.manager.loadWithVersion(runId);
      if (!reread) return { kind: 'refused', outcome: runMissingRefusal(runId, sink) };
      if (reread.lease !== null) {
        return {
          kind: 'refused',
          outcome: heldLeaseRefusal(runId, reread.state, reread.lease, deps, sink),
        };
      }
      const message = `Run ${runId} was modified by another writer before its command started; the command did not run and nothing was written — inspect the run and re-activate`;
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: CONCURRENT_MODIFICATION_CODE },
      });
      return {
        kind: 'refused',
        outcome: {
          kind: 'refused',
          runId,
          reason: 'command_not_started',
          code: CONCURRENT_MODIFICATION_CODE,
          message,
          recovery: 'retryable',
        },
      };
    }
    case 'held':
      return {
        kind: 'refused',
        outcome: heldLeaseRefusal(runId, current.state, leased.lease, deps, sink),
      };
    default: {
      const _exhaustive: never = leased;
      return _exhaustive;
    }
  }
}

/**
 * Deliver a leased turn's entry observations before its command starts.
 *
 * The entry is announced only once the turn holds the lease, and delivery is
 * the commit gate: no command starts until it returns. If delivery fails the
 * command has provably not started, so the lease is released by writing the
 * unchanged run at the lease's version (every state write clears the lease) —
 * a lease left set would read In Progress, then Interrupted, for a command
 * that never ran. The release is one conditional write, never retried: a
 * version that moved means another writer already decided about the run.
 *
 * @param entered - The runnable unit's entry.
 * @param leasedRun - The run at the version the lease produced.
 * @param manager - Durable state manager for the release.
 * @param sink - Gated observation sink.
 * @throws {ObservationDeliveryError} When the sink throws; the lease has been
 *   released (or another writer already moved the run).
 */
async function announceLeasedEntry(
  entered: ExecutionUnitEntry,
  leasedRun: VersionedRunState,
  manager: RunbookStateManager,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): Promise<void> {
  try {
    for (const effect of entered.effects) {
      sink.emit(effect.event);
    }
  } catch (error) {
    await manager.save(leasedRun.state, leasedRun.stateVersion);
    throw error;
  }
}

/**
 * Commit a leased command turn, naming the one way its finish can fail after
 * the command ran.
 *
 * {@link commitRunProgressionEvent} plus exactly one caught condition: a
 * {@link MachineEffectOutcomeUnknownError} from the derivation becomes the
 * `outcome_unknown` arm, because the command may already have run and its
 * finish cannot be recorded. Every other error — persisted-state defects
 * included — propagates.
 *
 * @param input - As for {@link commitRunProgressionEvent}.
 * @returns The commit result, or `outcome_unknown` with the typed error.
 * @throws {Error} Whatever {@link commitRunProgressionEvent} throws other than
 *   {@link MachineEffectOutcomeUnknownError}.
 */
async function commitLeasedCommand(
  input: CommitRunProgressionEventInput,
): Promise<
  | RunProgressionCommitResult
  | { readonly kind: 'outcome_unknown'; readonly error: MachineEffectOutcomeUnknownError }
> {
  try {
    return await commitRunProgressionEvent(input);
  } catch (error) {
    if (error instanceof MachineEffectOutcomeUnknownError) {
      return { kind: 'outcome_unknown', error };
    }
    throw error;
  }
}

/**
 * Activate Run Progression for one run under one verified authority.
 *
 * Drives machine-selected turns — execution-unit entry, command execution and
 * Inline Child composition (#903) — until the run awaits external input, hands
 * back a refusal, or reaches a terminal. An inline substep launches its
 * reserved child (or resumes it) and drives it; when the child reaches a
 * terminal, the parent Collects its Child Result and progression continues in
 * the parent. An activation that starts on an Inline Child ascends the same
 * way. Loading and restoring state are inert; this call is the explicit
 * activation.
 *
 * Observation delivery is the commit gate: after each durable commit its
 * observations are delivered synchronously through `deps.sink`, and no
 * subsequent effect begins until delivery returns. A throwing sink ends the
 * activation with the `failed` outcome (`observation_delivery_failed`,
 * `retryable`): the committed turn stays durable, no terminal is synthesized,
 * and the next activation resumes from current durable state without replaying
 * delivered or failed observations — there is no outbox and no event log.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, graph loader and sink.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @returns The closed progression outcome.
 * @throws {Error} If a core service throws on invalid persisted state, a
 *   programming invariant, or an unknown defect — deliberately not normalized
 *   into the closed outcome.
 * @throws {InvalidRunbookStateError} If the run's persisted snapshot is
 *   structurally invalid (unknown cursor, missing render context). Per the
 *   no-migration rule the recovery is explicit user action.
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
 * The activation body: drive the authority's run, then ascend while the run
 * that came to rest is a terminal Inline Child its parent still counts.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, graph loader and sink.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @returns The closed progression outcome of the run where progression rests.
 * @throws {Error} As {@link driveRun}.
 */
async function driveProgression(
  authority: RunProgressionAuthority,
  deps: RunProgressionDeps,
  entryBoundary: RunProgressionEntryBoundary,
): Promise<RunProgressionOutcome> {
  let outcome = await driveRun(authority, deps, entryBoundary, deps.sink);
  // A Collect-only activation rests where its Collect left the parent; a
  // parent that the Collect finished owes its own parent a Collect, which the
  // owner's next command target resolution commits the same way.
  if (entryBoundary.kind === 'collect_inline_child') return outcome;
  // Ascend: the child reached a terminal, so its parent — the same owner —
  // Collects it and continues. Bounded by the chain's depth; each ascent moves
  // one level up.
  for (let level = 0; level <= MAX_INLINE_CHILD_DEPTH; level++) {
    if (outcome.kind !== 'completed' && outcome.kind !== 'stopped') return outcome;
    const child = await deps.manager.loadWithVersion(outcome.runId);
    const parent = child === null ? undefined : await inlineParentCounting(deps.manager, child);
    if (parent === undefined) return outcome;
    outcome = await driveRun(
      mintRunProgressionAuthority({ runId: parent.state.id }),
      deps,
      { kind: 'resume' },
      sinkForRun(deps, parent.state),
    );
  }
  throw new Error(`Run Progression ascended past ${String(MAX_INLINE_CHILD_DEPTH)} inline levels`);
}

/**
 * The sink a run other than the activation's own reports through.
 *
 * @param deps - Activation dependencies.
 * @param state - The run.
 * @returns That run's sink, or the activation's when the frontend gave none.
 */
function sinkForRun(
  deps: RunProgressionDeps,
  state: RunbookState,
): Pick<ExecutionEventEmitter, 'emit'> {
  return deps.sinkFor?.(state) ?? deps.sink;
}

/**
 * Drive one run: every emission goes through the gated sink constructed
 * here, so {@link activateRunProgression}'s boundary catch is the single point
 * where a delivery failure becomes the closed outcome.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, graph loader and sink.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @param rawSink - This run's observation sink, before gating.
 * @returns The closed progression outcome.
 * @throws {Error} When the entry boundary names a terminal the durable row
 *   does not carry, when an `abandoned` run is activated, or when a committed
 *   command turn carries neither a command result nor a terminal.
 */
async function driveRun(
  authority: RunProgressionAuthority,
  deps: RunProgressionDeps,
  entryBoundary: RunProgressionEntryBoundary,
  rawSink: Pick<ExecutionEventEmitter, 'emit'>,
): Promise<RunProgressionOutcome> {
  const { manager, actorService } = deps;
  const runId = authority.runId;
  const sink = gateObservationDelivery(rawSink, runId);

  const loaded = await manager.loadWithVersion(runId);
  if (!loaded) return runMissingRefusal(runId, sink);
  const steps = await deps.loadSteps(loaded.state);
  if (!(await actorService.assertFreshState(runId, steps))) {
    return runMissingRefusal(runId, sink);
  }
  let current: VersionedRunState = loaded;

  if (
    entryBoundary.kind === 'after_observed_transition' &&
    entryBoundary.lifecycle !== 'running' &&
    entryBoundary.lifecycle !== current.state.lifecycle
  ) {
    throw new Error(
      `Run ${runId} entered progression after an observed ${entryBoundary.lifecycle} transition but durable lifecycle is ${String(current.state.lifecycle)}`,
    );
  }
  const terminalAlreadyObserved =
    entryBoundary.kind === 'after_observed_transition' && entryBoundary.lifecycle !== 'running';

  // A run already terminal at activation is reported, never re-driven.
  // Restoration stays inert; this reporting is the explicit activation's
  // first (and only) turn for such a run.
  const lifecycle = current.state.lifecycle;
  if (lifecycle === 'stopped' || lifecycle === 'completed') {
    if (!terminalAlreadyObserved) {
      emitTerminalAtActivation({ sink, steps, state: current.state, terminal: lifecycle });
    }
    return { kind: lifecycle, runId };
  }
  if (lifecycle === 'abandoned') {
    // Written only by a released child (#905); nothing here drives one.
    throw new Error(`Run ${runId} is abandoned and cannot be driven`);
  }

  const collectOnly = entryBoundary.kind === 'collect_inline_child';
  let feedback: RunProgressionMachineFeedback = { kind: 'activation' };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    // The compiled machine selects the next turn. The runtime only reads that
    // typed intent and mechanically executes ONE turn before asking again.
    const intent = await actorService.selectRunProgressionIntent(
      current.state,
      steps,
      authority,
      feedback,
    );
    feedback = { kind: 'activation' };

    // A Collect-only activation takes no turn but the Collect itself.
    if (
      collectOnly &&
      intent.kind !== 'refused' &&
      (intent.kind !== 'entered' || intent.entered.kind !== 'inline_child')
    ) {
      return collectNotOwedRefusal(runId, sink);
    }

    if (intent.kind === 'waiting') {
      // Waiting is the only machine intent whose turn performs no effect. Use
      // that inert boundary for one authoritative stability read: a write
      // committed after selection must be selected now, not left queued
      // behind a stale waiting hand-back.
      const durable = await manager.loadWithVersion(runId);
      if (!durable) return runMissingRefusal(runId, sink);
      if (durable.state.lifecycle === 'completed' || durable.state.lifecycle === 'stopped') {
        return { kind: durable.state.lifecycle, runId };
      }
      if (!isSameProgressionSelectionState(current.state, durable.state)) {
        current = durable;
        continue;
      }
      return { kind: 'waiting', runId, reason: intent.reason };
    }

    if (intent.kind === 'refused') {
      // A malformed persisted run keeps the repository-wide RD-309 recovery;
      // it outranks the refusal because the run cannot be loaded at all and no
      // retry addresses that.
      if (intent.cause instanceof InvalidRunbookStateError) {
        throw intent.cause;
      }
      // Nothing was committed, so re-activation re-renders (retryable, RD-504).
      const error = Errors.runProgressionEntryFailed(runId, intent.message);
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message: error.message, code: error.code },
      });
      return {
        kind: 'refused',
        runId,
        reason: intent.reason,
        code: error.code,
        message: error.message,
        recovery: 'retryable',
      };
    }

    // Always false TODAY — every other intent returned above — and required
    // anyway: assigning to `never` is what makes an intent added to
    // `RunProgressionMachineIntent` later a compile error rather than a silent
    // fall-through into the entry path.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    if (intent.kind !== 'entered') {
      const _exhaustive: never = intent;
      throw new Error(
        `Unhandled Run Progression intent: ${(_exhaustive as { readonly kind: string }).kind}`,
      );
    }

    const currentStep = findStepOrThrow(steps, current.state.step, runId);
    const entered: ExecutionUnitEntry = intent.entered;

    if (entered.kind === 'inline_child') {
      const composed = await driveInlineChild({
        authority,
        deps,
        parent: current,
        entered,
        steps,
        currentStep,
        sink,
        collectOnly,
      });
      if (composed.kind === 'rest') return composed.outcome;
      current = composed.parent;
      continue;
    }

    if (entered.kind === 'delegation') {
      // A Delegation resolves only by Collect (#904): the turn issues a Claim
      // Ticket to every counted child that has none — one conditional save of
      // their hashes — and announces the entry with the tickets, then waits.
      const issued = await issueClaimTickets({
        deps: { manager, actorService },
        run: current,
        steps,
        delegations: entered.delegations,
      });
      if (issued.kind === 'missing') return runMissingRefusal(runId, sink);
      if (issued.kind === 'concurrent_modification') {
        return claimTicketsNotIssuedRefusal(runId, sink);
      }
      current = issued.run;
      for (const effect of withEnteredChildren(entered.effects, issued.children)) {
        sink.emit(effect.event);
      }
      feedback = { kind: 'awaiting_input' };
      continue;
    }

    if (entered.kind !== 'runnable') {
      for (const effect of entered.effects) {
        sink.emit(effect.event);
      }
      feedback = { kind: 'awaiting_input' };
      continue;
    }

    // Turn: set the execution lease, announce the unit, run one command, and
    // commit its finish at the version the lease produced. The lease is one
    // conditional update and is never retried: a held lease or a moved
    // version refuses the turn before any effect starts — and before the
    // unit's entry is announced, so a refused turn never publishes a start
    // for a step another attempt owns. A finish whose attempt lost the lease
    // is NOT recorded, and the refusal says so rather than retrying over
    // whoever wrote.
    const leased = await acquireTurnLease(runId, current, deps, sink);
    if (leased.kind === 'refused') return leased.outcome;
    // This process runs the attempt until the turn ends, however it ends: a
    // lease still set after that reads Interrupted, never In Progress forever.
    using _inFlight = holdInFlightAttempt(runId, leased.lease);
    current = leased.run;
    await announceLeasedEntry(entered, current, deps.manager, sink);
    const { code: expandedCommandCode, displayCommand, rdInjected } = entered.command;
    const committed = await commitLeasedCommand({
      authority,
      manager,
      actorService,
      steps,
      run: current,
      event: {
        type: 'EXECUTE_COMMAND',
        command: expandedCommandCode,
        displayCommand,
        runbookPath: current.state.runbookPath,
        rdInjected,
      },
    });
    if (committed.kind === 'outcome_unknown') {
      const message = commandOutcomeUnknownMessage(
        runId,
        current.state,
        getErrorMessage(committed.error.cause),
      );
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: EXECUTION_INTERRUPTED_CODE },
      });
      return {
        kind: 'refused',
        runId,
        reason: 'command_outcome_unknown',
        code: EXECUTION_INTERRUPTED_CODE,
        message,
        recovery: 'permanent',
      };
    }
    if (committed.kind === 'missing') return runMissingRefusal(runId, sink);
    if (committed.kind === 'concurrent_modification') {
      const message = `Run ${runId} was modified by another writer while its command ran, so its attempt no longer holds the execution lease; the result was not recorded — inspect the run and re-activate`;
      sink.emit({
        type: 'ERROR_OCCURRED',
        payload: { message, code: CONCURRENT_MODIFICATION_CODE },
      });
      return {
        kind: 'refused',
        runId,
        reason: 'command_not_committed',
        code: CONCURRENT_MODIFICATION_CODE,
        message,
        recovery: 'retryable',
      };
    }
    const { prepared, state: committedState } = committed;
    const previousState = prepared.previousState;
    for (const effect of prepared.effects) {
      sink.emit(effect.event);
    }

    const commandOutput = prepared.effects.find(
      (
        effect,
      ): effect is ExecutionObservationEffect & {
        commandOutput: NonNullable<ExecutionObservationEffect['commandOutput']>;
      } => effect.commandOutput !== undefined,
    )?.commandOutput;

    if (commandOutput?.kind !== 'completed') {
      // The command produced no completion (policy denial, capture failure).
      // Emit the terminal projection, then report the committed lifecycle
      // rather than a blanket stop.
      const observation = deriveTransitionObservation({
        steps,
        currentStep,
        previousState,
        updatedState: committedState,
        snapshot: prepared.snapshot,
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
      if (committedState.lifecycle === 'stopped' || committedState.lifecycle === 'completed') {
        return { kind: committedState.lifecycle, runId };
      }
      // A committed, still-running turn without command output violates the
      // command actor's contract. Keep programming invariants outside the
      // closed outcome as ADR 0003 requires.
      throw new Error(`Run ${runId} committed a command turn without a command result`);
    }

    const transition = applyTransitionObservation({
      sink,
      steps,
      currentStep,
      previousState,
      updatedState: committedState,
      snapshot: prepared.snapshot,
      result: commandOutput.result,
      command: displayCommand,
    });
    if (transition.status === 'done') return { kind: 'completed', runId };
    if (transition.status === 'stopped') return { kind: 'stopped', runId };
    // When only the lifecycle went terminal the observation above classified
    // `continue`; report the terminal the commit actually carries.
    if (committedState.lifecycle === 'completed' || committedState.lifecycle === 'stopped') {
      sink.emit(
        deriveTerminalDrainObservationEvent({
          steps,
          currentStep,
          previousState,
          updatedState: committedState,
          snapshot: prepared.snapshot,
          status: committedState.lifecycle === 'completed' ? 'done' : 'stopped',
          result: commandOutput.result,
        }),
      );
      return { kind: committedState.lifecycle, runId };
    }
    // The next turn commits against the version this one produced.
    const next = await manager.loadWithVersion(runId);
    if (!next) return runMissingRefusal(runId, sink);
    current = next;
  }
}

/** What {@link driveInlineChild} hands back to the parent's loop. */
type InlineChildTurn =
  | {
      /** Progression rests: the child waits or refused, or the parent terminated. */
      readonly kind: 'rest';
      readonly outcome: RunProgressionOutcome;
    }
  | {
      /** The child was Collected and the parent continues from this version. */
      readonly kind: 'collected';
      readonly parent: VersionedRunState;
    };

/**
 * One inline-substep turn of the parent's progression (#903).
 *
 * Launches the reserved Inline Child if its row does not exist yet —
 * announcing the parent's unit entry exactly once, at launch — and drives it
 * while it runs. Once the child is terminal (now, or already, after a crash
 * before Collect), the parent Collects its Child Result with one `CHILD_RESULT`
 * commit at the version the parent was read at, and reports the transition.
 *
 * With `collectOnly` (a `collect_inline_child` activation) the turn launches
 * and drives nothing: it Collects a child that is already terminal and rests
 * at the parent's resulting position, or refuses a parent that no longer owes
 * that Collect.
 *
 * The parent holds no execution lease across this turn: launching and Collect
 * are writes of the owner's own command, each one conditional on a version,
 * and the child's commands take the child row's lease.
 *
 * @param args - The turn.
 * @param args.authority - The parent's authority.
 * @param args.deps - Activation dependencies.
 * @param args.parent - The parent, at the version this turn read.
 * @param args.entered - The parent's `inline_child` unit entry.
 * @param args.steps - The parent's parsed graph.
 * @param args.currentStep - The parent step owning the inline substep.
 * @param args.sink - The parent's gated sink.
 * @param args.collectOnly - Commit only the Collect of an already-terminal child.
 * @returns Whether progression rests, or the parent continues.
 * @throws {Error} When the child row is linked to another parent, or the
 *   Collect commit did not move the parent off the child's entry.
 */
async function driveInlineChild(args: {
  readonly authority: RunProgressionAuthority;
  readonly deps: RunProgressionDeps;
  readonly parent: VersionedRunState;
  readonly entered: ExecutionUnitInlineChild;
  readonly steps: readonly ResolvedStep[];
  readonly currentStep: ResolvedStep;
  readonly sink: Pick<ExecutionEventEmitter, 'emit'>;
  readonly collectOnly: boolean;
}): Promise<InlineChildTurn> {
  const { authority, deps, parent, entered, steps, currentStep, sink, collectOnly } = args;
  const runId = parent.state.id;
  const { reservation } = entered;
  let child = await deps.manager.loadWithVersion(reservation.runId);
  if (collectOnly && (child === null || (child.state.lifecycle ?? 'running') === 'running')) {
    return { kind: 'rest', outcome: collectNotOwedRefusal(runId, sink) };
  }

  if (child === null) {
    // Counted from the root, so a chain grown across commands is bounded too.
    if ((await inlineDepthOf(deps.manager, parent)) >= MAX_INLINE_CHILD_DEPTH) {
      return {
        kind: 'rest',
        outcome: launchRefusal(runId, sink, {
          code: INLINE_CHILD_LAUNCH_FAILED_CODE,
          message: `Run ${runId} cannot launch inline child ${reservation.runbook}: inline children nest deeper than ${String(MAX_INLINE_CHILD_DEPTH)} levels`,
          recovery: 'permanent',
        }),
      };
    }
    for (const effect of entered.effects) {
      sink.emit(effect.event);
    }
    const launched = await launchInlineChild({
      parent,
      reservation,
      deps,
      childSink: (state) => gateObservationDelivery(sinkForRun(deps, state), state.id),
    });
    if (launched.kind === 'refused') {
      return { kind: 'rest', outcome: launchRefusal(runId, sink, launched) };
    }
    child = launched.child;
  }
  if (child.linkage?.kind !== 'inline' || child.linkage.parentRunId !== runId) {
    throw new Error(`Run ${child.state.id} is not an inline child of run ${runId}`);
  }

  if ((child.state.lifecycle ?? 'running') === 'running') {
    const outcome = await driveRun(
      mintRunProgressionAuthority({ runId: child.state.id }),
      deps,
      { kind: 'resume' },
      sinkForRun(deps, child.state),
    );
    if (outcome.kind !== 'completed' && outcome.kind !== 'stopped') {
      return { kind: 'rest', outcome };
    }
    const finished = await deps.manager.loadWithVersion(child.state.id);
    if (finished === null)
      return { kind: 'rest', outcome: runMissingRefusal(child.state.id, sink) };
    child = finished;
  }

  // The implicit Collect: the parent's own commit, reading the child's terminal
  // from the child's row.
  if (parent.lease !== null) {
    return {
      kind: 'rest',
      outcome: heldLeaseRefusal(runId, parent.state, parent.lease, deps, sink),
    };
  }
  const { event, result } = childResultEvent(child.state);
  const committed = await commitRunProgressionEvent({
    authority,
    manager: deps.manager,
    actorService: deps.actorService,
    steps,
    run: parent,
    event,
  });
  if (committed.kind === 'missing')
    return { kind: 'rest', outcome: runMissingRefusal(runId, sink) };
  if (committed.kind === 'concurrent_modification') {
    const message = `Run ${runId} was modified by another writer before inline child ${child.state.id} was collected; nothing was written — re-read the run and re-issue the command`;
    sink.emit({ type: 'ERROR_OCCURRED', payload: { message, code: CONCURRENT_MODIFICATION_CODE } });
    return {
      kind: 'rest',
      outcome: {
        kind: 'refused',
        runId,
        reason: 'command_not_committed',
        code: CONCURRENT_MODIFICATION_CODE,
        message,
        recovery: 'retryable',
      },
    };
  }
  const { prepared, state: committedState } = committed;
  if (
    committedState.lifecycle === 'running' &&
    currentInlineReservation(committedState)?.runId === child.state.id
  ) {
    throw new Error(`Run ${runId} did not leave inline child ${child.state.id} when collecting it`);
  }
  const transition = applyTransitionObservation({
    sink,
    steps,
    currentStep,
    previousState: prepared.previousState,
    updatedState: committedState,
    snapshot: prepared.snapshot,
    result,
  });
  if (transition.status === 'done') return { kind: 'rest', outcome: { kind: 'completed', runId } };
  if (transition.status === 'stopped') return { kind: 'rest', outcome: { kind: 'stopped', runId } };
  if (committedState.lifecycle === 'completed' || committedState.lifecycle === 'stopped') {
    sink.emit(
      deriveTerminalDrainObservationEvent({
        steps,
        currentStep,
        previousState: prepared.previousState,
        updatedState: committedState,
        snapshot: prepared.snapshot,
        status: committedState.lifecycle === 'completed' ? 'done' : 'stopped',
        result,
      }),
    );
    return { kind: 'rest', outcome: { kind: committedState.lifecycle, runId } };
  }
  if (collectOnly)
    return { kind: 'rest', outcome: { kind: 'waiting', runId, reason: 'collected' } };
  const next = await deps.manager.loadWithVersion(runId);
  if (!next) return { kind: 'rest', outcome: runMissingRefusal(runId, sink) };
  return { kind: 'collected', parent: next };
}

/**
 * Refuse a `collect_inline_child` activation whose run no longer owes the
 * Collect it was minted for: its cursor left the inline substep, or its
 * Current Child is not a terminal row. Under one writer per run only another
 * of the owner's commands moves it, so nothing is written and the command is
 * re-issued against the run as it now is.
 *
 * @param runId - The run activated for the Collect.
 * @param sink - The run's gated sink.
 * @returns The closed refusal.
 */
function collectNotOwedRefusal(
  runId: RunId,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): RunProgressionOutcome {
  const message = `Run ${runId} no longer owes the Collect of a terminal inline child: another command moved it since it was read; nothing was written — re-read the run and re-issue the command`;
  sink.emit({ type: 'ERROR_OCCURRED', payload: { message, code: CONCURRENT_MODIFICATION_CODE } });
  return {
    kind: 'refused',
    runId,
    reason: 'command_not_committed',
    code: CONCURRENT_MODIFICATION_CODE,
    message,
    recovery: 'retryable',
  };
}

/**
 * Refuse a turn whose Claim Tickets could not be recorded because the run
 * moved since it was read (#904). The minted tickets were never printed.
 *
 * @param runId - The run whose entry could not issue its tickets.
 * @param sink - The run's gated sink.
 * @returns The closed refusal.
 */
function claimTicketsNotIssuedRefusal(
  runId: RunId,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
): RunProgressionOutcome {
  const message = `Run ${runId} was modified by another writer before its Claim Tickets were recorded; nothing was written and no ticket was issued — re-read the run and re-issue the command`;
  sink.emit({ type: 'ERROR_OCCURRED', payload: { message, code: CONCURRENT_MODIFICATION_CODE } });
  return {
    kind: 'refused',
    runId,
    reason: 'claim_tickets_not_issued',
    code: CONCURRENT_MODIFICATION_CODE,
    message,
    recovery: 'retryable',
  };
}

/**
 * Diagnose and return an Inline Child launch refusal.
 *
 * @param runId - The parent whose inline substep could not launch its child.
 * @param sink - The parent's gated sink.
 * @param refusal - The refusal's code, message and recovery.
 * @param refusal.code - Stable diagnostic code.
 * @param refusal.message - Operator-facing message.
 * @param refusal.recovery - Whether repeating the command can succeed.
 * @returns The closed refusal.
 */
function launchRefusal(
  runId: RunId,
  sink: Pick<ExecutionEventEmitter, 'emit'>,
  refusal: {
    readonly code: string;
    readonly message: string;
    readonly recovery: RunProgressionRecovery;
  },
): RunProgressionOutcome {
  sink.emit({ type: 'ERROR_OCCURRED', payload: { message: refusal.message, code: refusal.code } });
  return {
    kind: 'refused',
    runId,
    reason: 'inline_child_launch_failed',
    code: refusal.code,
    message: refusal.message,
    recovery: refusal.recovery,
  };
}
