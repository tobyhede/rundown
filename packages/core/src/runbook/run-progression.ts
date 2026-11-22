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
 * cursor waits for input or enters its execution unit. Composition — inline
 * children (#903) and delegation (#904) — returns on this model later; the
 * frontend supplies only the command callable through the actor service.
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
import type { PreparedActorMutation, RunbookActorService } from './actor-service.js';
import type { RunbookEvent, RunProgressionMachineFeedback } from './compiler.js';
import { findStepOrThrow } from './execution-units.js';
import type { ExecutionUnitEntry } from './execution-unit-entry.js';
import { InvalidRunbookStateError } from './persisted-state-guards.js';
import type { OwnedRun } from './run-authority.js';
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
 * `awaiting_input` — the cursor rests on a unit that needs an operator
 * gesture (`rundown pass` / `rundown fail`).
 */
export type RunProgressionWaitReason = 'awaiting_input';

/**
 * Why an activation refused without applying a terminal.
 *
 * - `run_missing` — the run no longer exists (a concurrent prune).
 * - `command_not_committed` — the command ran, but the save of its result was
 *   refused because another writer moved the row. Nothing was written.
 * - `entry_render_failed` — rendering the selected unit's entry threw; nothing
 *   was committed and re-activation re-renders.
 */
export type RunProgressionRefusalReason =
  | 'run_missing'
  | 'command_not_committed'
  | 'entry_render_failed';

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
}

/**
 * The durable/observation boundary at which an explicit activation enters.
 *
 * `resume` means the activation owns reporting any terminal it discovers.
 * `after_observed_transition` is minted by the core transition seam after its
 * initiating commit and is consumed only after the frontend delivers that
 * commit's observation, so activation never re-announces a terminal the seam
 * already rendered.
 */
export type RunProgressionEntryBoundary =
  | { readonly kind: 'resume' }
  | {
      readonly kind: 'after_observed_transition';
      readonly lifecycle: 'running' | 'completed' | 'stopped';
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
 * Core, not the frontend, answers this. Under #901 a terminal run composes
 * with nothing — inline flow-back returns with #903 — so the answer is always
 * `none`. The function stays because the question is core's: a frontend that
 * decided "nothing to continue" for itself would have to be rewritten when
 * composition returns.
 *
 * @param state - Durable terminal run state.
 * @returns `none`.
 * @throws {Error} When the supplied state is not terminal.
 */
export function progressionDirectiveForTerminalRun(state: RunbookState): RunProgressionDirective {
  if (state.lifecycle === undefined || state.lifecycle === 'running') {
    throw new Error(`Run ${state.id} is not terminal`);
  }
  return { kind: 'none' };
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
 * Activate Run Progression for one run under one verified authority.
 *
 * Drives machine-selected turns — execution-unit entry and command execution
 * — until the run awaits external input, hands back a refusal, or reaches a
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
 * The activation body: every emission goes through the gated sink constructed
 * here, so {@link activateRunProgression}'s boundary catch is the single point
 * where a delivery failure becomes the closed outcome.
 *
 * @param authority - The verified, run-bound authority for every mutating turn.
 * @param deps - Services, graph loader and sink.
 * @param entryBoundary - Observation state of the transition that entered progression.
 * @returns The closed progression outcome.
 * @throws {Error} When the entry boundary names a terminal the durable row
 *   does not carry, when an `abandoned` run is activated, or when a committed
 *   command turn carries neither a command result nor a terminal.
 */
async function driveProgression(
  authority: RunProgressionAuthority,
  deps: RunProgressionDeps,
  entryBoundary: RunProgressionEntryBoundary,
): Promise<RunProgressionOutcome> {
  const { manager, actorService } = deps;
  const runId = authority.runId;
  const sink = gateObservationDelivery(deps.sink, runId);

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
    // Written only by a released child (#904); nothing in T1 drives one.
    throw new Error(`Run ${runId} is abandoned and cannot be driven`);
  }

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
    for (const effect of entered.effects) {
      sink.emit(effect.event);
    }

    if (entered.kind !== 'runnable') {
      feedback = { kind: 'awaiting_input' };
      continue;
    }

    // Turn: one command execution, committed under the version this
    // activation read. The command runs first and the save is conditional:
    // a version that moved means the result is NOT recorded, and the refusal
    // says so rather than retrying over whoever wrote.
    const { code: expandedCommandCode, displayCommand, rdInjected } = entered.command;
    const committed = await commitRunProgressionEvent({
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
    if (committed.kind === 'missing') return runMissingRefusal(runId, sink);
    if (committed.kind === 'concurrent_modification') {
      const message = `Run ${runId} was modified by another writer while its command ran; the result was not recorded — inspect the run and re-activate`;
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
