/**
 * Core seam for the owner's lifecycle commands on one run (#901, ADR 0005).
 *
 * `rundown pass` / `rundown fail` (transition), `rundown complete` /
 * `rundown stop` (terminal) and `rundown goto` (navigation) enter core here.
 * The seam takes the run the frontend already resolved from its Owner Token
 * ({@link OwnedRun}, carrying the `state_version` the state was read at),
 * drives the compiled machine, and commits with one conditional save. A
 * version that moved is refused as `concurrent_modification` and never
 * retried; a run that already finished is refused as `run_finished`; a
 * `--step` / `--index` that does not confirm the current position is refused
 * as `invalid_step_target`; a run deleted (pruned) between token resolution
 * and the save is refused as `unknown_token`, exactly what re-resolving the
 * token would now answer. A run whose step holds the execution lease (#902)
 * is refused `execution_in_progress` while the attempt lives, and
 * `execution_interrupted` for `pass` / `complete` once it died — `fail`,
 * `goto` and `stop` are the explicit decisions that clear an Interrupted
 * attempt, and their save clears the lease. Nothing is written on any refusal.
 *
 * The seam returns transition-observation events plus a Run Progression
 * directive as data. It does not spawn processes or render.
 *
 * @module runbook/lifecycle-command-service
 */

import type { StepId } from '@rundown-org/parser';
import type { RunbookActorService } from './actor-service.js';
import {
  progressionDirectiveForTerminalRun,
  type RunProgressionDirective,
  type RunProgressionOutcome,
} from './run-progression.js';
import {
  mintRunProgressionAuthority,
  type RunProgressionAuthority,
} from './run-progression-authority.js';
import {
  resolveOwnedRun,
  type FinishedLifecycle,
  type OwnedRun,
  type OwnedRunResolution,
} from './run-authority.js';
import type { OwnerToken } from './run-secrets.js';
import { currentInlineReservation } from './inline-child.js';
import { deriveExecutionAt } from './targeting.js';
import { MAX_INLINE_CHILD_DEPTH } from './inline-progression.js';
import type { RunId } from './run-id.js';
import type { RunbookStateManager } from './state.js';
import {
  resolveTransitionCursor,
  type ExplicitTransitionTarget,
  type InvalidStepTargetRefusal,
} from './transition-cursor.js';
import type { ActionType } from './transition-kernel.js';
import {
  refuseUnderLease,
  type ExecutionInProgressRefusal,
  type ExecutionLeaseRefusal,
  type LeaseDecision,
} from './execution-lease.js';
import type { ProcessIdentity } from './process-identity.js';
import {
  deriveTransitionObservation,
  reconcileFencedTerminalObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';
import type { ResolvedStep, RunbookState } from './types.js';

/** The manual transition commands. */
export type TransitionCommandName = 'pass' | 'fail';

/** The forced terminal commands. */
export type TerminalCommandName = 'complete' | 'stop';

/**
 * Core services the lifecycle command seam drives.
 *
 * Injected as one structural interface so callers hand in already constructed
 * core services and tests pass trivial doubles.
 */
export interface RunbookLifecycleCommandServiceDependencies {
  /** State manager whose conditional save commits every mutation. */
  readonly manager: RunbookStateManager;
  /** Actor service used to derive each machine transition. */
  readonly actorService: RunbookActorService;
  /**
   * Derive the parsed steps for the owned run from its in-memory state.
   *
   * Step derivation is parsing plus an environment-bound helper-registry and
   * render context (Category A), not runbook file IO — so this callable
   * carries only that environment context, letting the seam own step
   * derivation without taking `steps` as an input.
   */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
  /**
   * Start-identity source for classifying a held execution lease. Defaults to
   * the process-wide identity; tests inject a deterministic one.
   */
  readonly processIdentity?: ProcessIdentity;
}

/**
 * Refusal: the token's run already finished.
 *
 * What the CLI renders as RD-303 / RD-304 — a late command on a finished run
 * is told how it finished rather than being applied.
 */
export interface RunFinishedRefusal {
  readonly kind: 'run_finished';
  /** The finished run. */
  readonly runId: RunId;
  /** How it finished. */
  readonly lifecycle: FinishedLifecycle;
}

/**
 * Refusal: the row's `state_version` moved between the owner's read and this
 * save. Nothing was written and the persisted state is intact. Under one
 * writer per run this means two of the owner's own commands raced; the
 * operator re-reads the run and re-issues the command. Never retried here.
 */
export interface ConcurrentModificationRefusal {
  readonly kind: 'concurrent_modification';
  /** The run whose save was refused. */
  readonly runId: RunId;
  /** Operator-facing message. Carries no secret. */
  readonly message: string;
}

/**
 * Refusal: the run the Owner Token resolved to was deleted before the save.
 *
 * Another process pruned the run (`rundown prune --token`, `prune
 * --inactive`) between the frontend's token resolution and this command's
 * conditional save. Nothing was written. The arm is the very value
 * `resolveOwnedRun` now returns for the same token, so a frontend renders
 * it the way it renders an unresolvable token — re-issuing the command cannot
 * succeed, which is what separates it from `concurrent_modification`.
 */
export type UnknownTokenRefusal = Extract<OwnedRunResolution, { readonly kind: 'unknown_token' }>;

/** Input to {@link RunbookLifecycleCommandService.runTransition}. */
export interface LifecycleTransitionInput {
  /**
   * The manual transition being attempted. This is also the result the command
   * persists: `pass` drives PASS, `fail` drives FAIL.
   */
  readonly command: TransitionCommandName;
  /** The run resolved from the caller's Owner Token, with the version it was read at. */
  readonly run: OwnedRun;
  /**
   * Raw `--step` / `--index` target, or `undefined` when the caller supplied
   * no `--step`. Required as a key so a frontend cannot omit the contract by
   * accident; `--step` itself is required by {@link resolveTransitionCursor},
   * which composes the refusal naming the current position so the frontend
   * does not have to.
   */
  readonly target: ExplicitTransitionTarget | undefined;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
}

/** Result of applying a pass/fail transition through the seam. */
export type LifecycleTransitionOutcome =
  | InvalidStepTargetRefusal
  | RunFinishedRefusal
  | ExecutionLeaseRefusal
  | ExecutionPendingRefusal
  | ConcurrentModificationRefusal
  | UnknownTokenRefusal
  | {
      readonly kind: 'applied';
      /** Run the transition was applied to. */
      readonly runId: RunId;
      /** Coarse transition status used by the frontend for exit-code/flow decisions. */
      readonly status: 'continue' | 'done' | 'stopped';
      /** Transition observation events for the frontend to render. */
      readonly events: readonly TransitionObservationEvent[];
      /** How the frontend activates Run Progression next. */
      readonly progression: Extract<RunProgressionDirective, { readonly kind: 'activate' }>;
      /** Updated state when the run is still active (`status === 'continue'`). */
      readonly updatedState?: RunbookState;
    };

/** Input to {@link RunbookLifecycleCommandService.runTerminal}. */
export interface LifecycleTerminalInput {
  /** The terminal command being run. Drives FORCE_COMPLETE vs FORCE_STOP, never a literal. */
  readonly command: TerminalCommandName;
  /** The run resolved from the caller's Owner Token, with the version it was read at. */
  readonly run: OwnedRun;
  /** Optional terminal message forwarded to the machine (`FORCE_*.message`). */
  readonly message?: string;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
}

/** Result of a complete/stop command through the seam. */
export type LifecycleTerminalOutcome =
  | RunFinishedRefusal
  | ExecutionLeaseRefusal
  | ConcurrentModificationRefusal
  | UnknownTokenRefusal
  | {
      readonly kind: 'applied';
      /** The run forced terminal. */
      readonly runId: RunId;
      /** The lifecycle the commit carries. */
      readonly lifecycle: 'completed' | 'stopped';
      /** Terminal observation events for the frontend to render. */
      readonly events: readonly TransitionObservationEvent[];
      /**
       * Whether composition owes a further turn: `activate` when the run is an
       * Inline Child, so its parent Collects it (#903); otherwise `none`.
       */
      readonly progression: RunProgressionDirective;
    };

/** Input to {@link RunbookLifecycleCommandService.resolveRunNavigation}. */
export interface LifecycleNavigationInput {
  /** The run resolved from the caller's Owner Token, with the version it was read at. */
  readonly run: OwnedRun;
}

const lifecycleNavigationCapabilityBrand: unique symbol = Symbol('lifecycleNavigationCapability');

/**
 * Opaque core-verified run, authority and graph for one GOTO mutation.
 *
 * Binds the authority to the exact parsed graph and the exact versioned state
 * it was verified against, so a frontend cannot pair any of them with
 * unrelated inputs.
 */
export interface LifecycleNavigationCapability {
  readonly authority: RunProgressionAuthority;
  readonly steps: readonly ResolvedStep[];
  readonly run: OwnedRun;
  readonly [lifecycleNavigationCapabilityBrand]: true;
}

/** Outcome of {@link RunbookLifecycleCommandService.resolveRunNavigation}. */
export type LifecycleNavigationOutcome =
  | RunFinishedRefusal
  | ExecutionInProgressRefusal
  | {
      /** Navigation is allowed against the owned run. */
      readonly kind: 'allowed';
      /** Run the navigation targets. */
      readonly runId: RunId;
      /** Running state of the target run. */
      readonly state: RunbookState;
      /** One opaque capability for the GOTO and its continuation. */
      readonly navigation: LifecycleNavigationCapability;
    };

/** Input to an already-authorized GOTO mutation. */
export interface LifecycleNavigationMutationInput {
  readonly navigation: LifecycleNavigationCapability;
  readonly target: StepId;
}

/** Result of applying an already-authorized GOTO. */
export type LifecycleNavigationMutationOutcome =
  | ConcurrentModificationRefusal
  | UnknownTokenRefusal
  | {
      readonly kind: 'applied';
      readonly runId: RunId;
      readonly previousState: RunbookState;
      readonly updatedState: RunbookState;
      readonly snapshot: unknown;
      /** Opaque core-minted continuation consumed verbatim by the frontend. */
      readonly progression: Extract<RunProgressionDirective, { readonly kind: 'activate' }>;
    };

/**
 * Activate Run Progression for a run whose Current Inline Child is terminal
 * but not yet Collected. Supplied by the frontend with its standard activation
 * wiring, which consumes the directive verbatim; core decides when to call it
 * and mints the directive with the `collect_inline_child` entry boundary, so
 * the activation commits only the Collect and runs nothing further.
 */
export type SettleInlineChild = (
  directive: Extract<RunProgressionDirective, { readonly kind: 'activate' }>,
) => Promise<RunProgressionOutcome>;

/**
 * Outcome of {@link RunbookLifecycleCommandService.resolveCommandTarget}.
 *
 * Every arm of {@link OwnedRunResolution}, where the `running` arm's run is the
 * command's target — the deepest running Inline Child below the token's run —
 * plus `settle_refused` when Collecting a terminal Inline Child first did not
 * reach a resting run.
 */
export type CommandTargetResolution =
  | Exclude<OwnedRunResolution, { readonly kind: 'running' }>
  | {
      readonly kind: 'running';
      /** The command's target: the deepest running run on the inline chain. */
      readonly run: OwnedRun;
      /** The run the Owner Token is bound to: the chain's root. */
      readonly root: RunbookState;
    }
  | {
      /** The implicit Collect of a terminal Inline Child was refused or failed. */
      readonly kind: 'settle_refused';
      readonly outcome: Extract<RunProgressionOutcome, { readonly kind: 'refused' | 'failed' }>;
    };

/** Symbolic code for {@link ExecutionPendingRefusal}. */
export const EXECUTION_PENDING_CODE = 'EXECUTION_PENDING';

/**
 * Refusal: `pass` named a step whose command Run Progression owes but has not
 * run — the command that entered the step ended before its progression did
 * (a crash after its commit, or a recovery Collect of an Inline Child, #903).
 * Passing it would record a command that never ran, so nothing is written;
 * `goto` re-enters the step and runs the command, and `fail` / `stop` decide
 * it explicitly.
 */
export interface ExecutionPendingRefusal {
  readonly kind: 'execution_pending';
  /** The symbolic refusal code. */
  readonly code: typeof EXECUTION_PENDING_CODE;
  /** The run whose step's command has not run. */
  readonly runId: RunId;
  /** The step (`step` or `step.substep`) whose command is owed. */
  readonly step: string;
  /** Operator-facing message. */
  readonly message: string;
}

/**
 * Map a transition command to its machine event. Exhaustive with a `never`
 * fallthrough so a future member cannot silently collapse to FAIL (No silent
 * mapping).
 *
 * @param command - The transition command being run.
 * @returns The corresponding machine event type.
 * @throws {Error} When an unhandled transition command is supplied.
 */
function transitionEvent(command: TransitionCommandName): 'PASS' | 'FAIL' {
  switch (command) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unsupported transition command: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Map a terminal command to its machine FORCE event. Exhaustive with a
 * `never` fallthrough so a future terminal command cannot silently collapse to
 * `FORCE_STOP` (No silent mapping).
 *
 * @param command - The terminal command being run (`complete` / `stop`).
 * @returns The corresponding machine force event type.
 * @throws {Error} When an unhandled terminal command is supplied.
 */
function terminalForceEvent(command: TerminalCommandName): 'FORCE_COMPLETE' | 'FORCE_STOP' {
  switch (command) {
    case 'complete':
      return 'FORCE_COMPLETE';
    case 'stop':
      return 'FORCE_STOP';
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unsupported terminal command: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Refuse a run that is no longer running, or return `undefined` to proceed.
 *
 * @param run - The owned run.
 * @returns The `run_finished` refusal, or `undefined` while the run is running.
 */
function finishedRefusal(run: OwnedRun): RunFinishedRefusal | undefined {
  const lifecycle = run.state.lifecycle ?? 'running';
  if (lifecycle === 'running') return undefined;
  return { kind: 'run_finished', runId: run.state.id, lifecycle };
}

/**
 * Name the Inline Child in a `--step` refusal against it (#903).
 *
 * While an inline child runs, the root's Owner Token targets the child, so
 * `--step` names a step of the child. A refusal that only spoke of "the
 * current step" would read as if it described the run the agent started.
 *
 * @param refusal - The cursor's refusal.
 * @param run - The command's target.
 * @returns The refusal, naming the child and its parent when the target is one.
 */
function inlineTargetRefusal(
  refusal: InvalidStepTargetRefusal,
  run: OwnedRun,
): InvalidStepTargetRefusal {
  if (run.linkage?.kind !== 'inline') return refusal;
  return {
    kind: 'invalid_step_target',
    message: `${refusal.message}. The Owner Token is driving inline child ${run.state.id} (${run.state.runbook.path}) of run ${run.linkage.parentRunId} at ${run.linkage.parentStep}; while it runs, --step names a step of the child`,
  };
}

/**
 * The `concurrent_modification` refusal for one run.
 *
 * @param runId - The run whose save was refused.
 * @returns The refusal.
 */
function concurrentModification(runId: RunId): ConcurrentModificationRefusal {
  return {
    kind: 'concurrent_modification',
    runId,
    message: `Run ${runId} was modified by another writer since it was read; nothing was written. Re-read the run and re-issue the command.`,
  };
}

/**
 * Core seam for the owner's lifecycle command mutations.
 *
 * Every method takes the run the frontend resolved from its Owner Token and
 * returns typed outcomes: the frontend renders them and, on `applied`,
 * activates Run Progression per the returned directive. There is no target
 * resolution, no caller evidence and no policy here — ownership was proven
 * before the run reached this seam, and the Owner Token is the only
 * authority.
 */
export class RunbookLifecycleCommandService {
  readonly #deps: RunbookLifecycleCommandServiceDependencies;

  /**
   * Construct a lifecycle command service bound to a set of core dependencies.
   *
   * @param deps - Core services the seam drives.
   */
  constructor(deps: RunbookLifecycleCommandServiceDependencies) {
    this.#deps = deps;
  }

  /**
   * Resolve an Owner Token to the run a mutating command targets (#903).
   *
   * The token resolves to the root run it owns. From there the target is the
   * deepest running Inline Child, reached by following each run's Current
   * Child — so `--step` then names a step of that child, and a step that
   * belongs to a parent while its inline child runs is not the current
   * position. Before anything else, a Current Inline Child that is terminal but
   * not yet Collected (its parent's command died before the implicit Collect)
   * is Collected through `settle`, scoped to that one Collect: it commits the
   * `CHILD_RESULT` the crash lost and nothing else — no command runs and no
   * child launches before the owner's own command — and the descent starts
   * again from the root. A Collect that finishes the parent leaves it owing
   * its own parent a Collect, committed on the next pass.
   *
   * @param token - The presented Owner Token.
   * @param settle - Activates Run Progression on the run owing a Collect.
   * @returns The target with its root, the root's own refusal, or the settle's.
   * @throws {Error} When settling does not converge within the chain's depth —
   *   each settle Collects one child, so this is a defect, not a race.
   */
  async resolveCommandTarget(
    token: OwnerToken,
    settle: SettleInlineChild,
  ): Promise<CommandTargetResolution> {
    let refused: Extract<CommandTargetResolution, { kind: 'settle_refused' }> | undefined;
    for (let pass = 0; pass <= MAX_INLINE_CHILD_DEPTH; pass++) {
      const resolution = await resolveOwnedRun(this.#deps.manager, token);
      if (resolution.kind !== 'running') return resolution;
      const descent = await this.#descend(resolution.run);
      // A settle refusal whose run no longer owes the Collect (the run moved
      // under it) still leaves a target to act on; only a Collect that is
      // still owed after a refusal refuses the command.
      if (descent.kind === 'target') {
        return { kind: 'running', run: descent.run, root: resolution.run.state };
      }
      if (refused !== undefined) return refused;
      const steps = await this.#deps.loadSteps(descent.run.state);
      const outcome = await settle({
        kind: 'activate',
        authority: mintRunProgressionAuthority({ runId: descent.run.state.id }),
        runbook: descent.run.state.runbook,
        steps,
        entryBoundary: { kind: 'collect_inline_child' },
      });
      if (outcome.kind === 'refused' || outcome.kind === 'failed') {
        refused = { kind: 'settle_refused', outcome };
      }
    }
    throw new Error(
      `Collecting inline children did not settle within ${String(MAX_INLINE_CHILD_DEPTH)} passes`,
    );
  }

  /**
   * Follow Current Inline Children down from `run`.
   *
   * @param run - The run to start from.
   * @returns The deepest running run, or the run whose Current Child is
   *   terminal and owes a Collect.
   * @throws {Error} When the chain is deeper than any run can drive.
   */
  async #descend(
    run: OwnedRun,
  ): Promise<{ readonly kind: 'target' | 'settle'; readonly run: OwnedRun }> {
    let current = run;
    for (let level = 0; level <= MAX_INLINE_CHILD_DEPTH; level++) {
      const reservation = currentInlineReservation(current.state);
      if (reservation === undefined) return { kind: 'target', run: current };
      const child = await this.#deps.manager.loadWithVersion(reservation.runId);
      // Reserved but not launched: the parent itself is the target.
      if (child === null) return { kind: 'target', run: current };
      if ((child.state.lifecycle ?? 'running') !== 'running') {
        return { kind: 'settle', run: current };
      }
      current = child;
    }
    throw new Error(
      `Inline chain below run ${run.state.id} is deeper than ${String(MAX_INLINE_CHILD_DEPTH)}`,
    );
  }

  /**
   * Apply a pass/fail transition to the owned run.
   *
   * In order: refuse a finished run; confirm `--step` / `--index` against the
   * current position (nothing written on refusal); derive the machine
   * transition for `PASS` / `FAIL`; commit it with one conditional save
   * naming the version the run was read at; derive the observation and the
   * progression directive.
   *
   * @param input - Command, owned run, raw `--step` target and display policy.
   * @returns A typed refusal or the applied transition with its observation
   *   events and progression directive.
   * @throws {Error} When the committed state's cursor names a step the runbook
   *   does not define, or on an actor derivation failure.
   */
  async runTransition(input: LifecycleTransitionInput): Promise<LifecycleTransitionOutcome> {
    const finished = finishedRefusal(input.run);
    if (finished) return finished;
    const leased = this.#leaseRefusal(input.run, input.command);
    if (leased) return leased;
    const { state: previousState, stateVersion } = input.run;
    const steps = await this.#deps.loadSteps(previousState);

    const cursor = resolveTransitionCursor(steps, previousState, input.target);
    if (cursor.kind === 'invalid_step_target') return inlineTargetRefusal(cursor, input.run);
    if (input.command === 'pass') {
      const pending = await this.#pendingCommandRefusal(input.run, steps);
      if (pending) return pending;
    }

    const prepared = await this.#deps.actorService.prepareActorMutation(
      previousState.id,
      previousState,
      steps,
      { type: transitionEvent(input.command) },
    );
    const saved = await this.#deps.manager.save(prepared.nextState, stateVersion);
    if (saved.kind !== 'committed') return this.#refuseSave(saved.kind, previousState.id);
    const updatedState = saved.state;
    const currentStep = this.#findStep(steps, previousState.step);

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: prepared.snapshot,
      result: input.command,
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });
    // Report on `updatedState.lifecycle`, the same signal the commit carries,
    // so an `applied` outcome can never claim execution continues on a run
    // this save already finished.
    const reconciled = reconcileFencedTerminalObservation({
      observation,
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: prepared.snapshot,
      result: input.command,
    });

    const authority = mintRunProgressionAuthority({ runId: previousState.id });
    if (reconciled.status !== 'continue') {
      return {
        kind: 'applied',
        runId: previousState.id,
        status: reconciled.status,
        events: reconciled.events,
        progression: {
          kind: 'activate',
          authority,
          runbook: previousState.runbook,
          steps,
          entryBoundary: {
            kind: 'after_observed_transition',
            lifecycle: reconciled.status === 'done' ? 'completed' : 'stopped',
          },
        },
      };
    }
    return {
      kind: 'applied',
      runId: previousState.id,
      status: 'continue',
      events: reconciled.events,
      progression: {
        kind: 'activate',
        authority,
        runbook: previousState.runbook,
        steps,
        entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
      },
      updatedState,
    };
  }

  /**
   * Force the owned run terminal for a complete/stop command.
   *
   * @param input - Command, owned run, optional message and display policy.
   * @returns A typed refusal or the applied terminal with its observation
   *   events. The progression directive is core's answer to whether
   *   composition owes a further turn: an Inline Child's parent Collects it.
   * @throws {Error} When the machine did not reach a terminal lifecycle for a
   *   FORCE event — a programming invariant, not an operator condition.
   */
  async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    const finished = finishedRefusal(input.run);
    if (finished) return finished;
    const leased = this.#leaseRefusal(input.run, input.command);
    if (leased) return leased;
    const { state: previousState, stateVersion } = input.run;
    const steps = await this.#deps.loadSteps(previousState);
    const currentStep = this.#findStep(steps, previousState.step);

    const prepared = await this.#deps.actorService.prepareActorMutation(
      previousState.id,
      previousState,
      steps,
      {
        type: terminalForceEvent(input.command),
        ...(input.message !== undefined ? { message: input.message } : {}),
      },
    );
    const saved = await this.#deps.manager.save(prepared.nextState, stateVersion);
    if (saved.kind !== 'committed') return this.#refuseSave(saved.kind, previousState.id);
    const updatedState = saved.state;
    const lifecycle = updatedState.lifecycle;
    if (lifecycle !== 'completed' && lifecycle !== 'stopped') {
      throw new Error(
        `Run ${previousState.id} did not reach a terminal lifecycle after force-${input.command} (lifecycle: ${String(lifecycle)})`,
      );
    }

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: prepared.snapshot,
      result: input.command === 'complete' ? 'pass' : 'fail',
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });
    return {
      kind: 'applied',
      runId: previousState.id,
      lifecycle,
      events: observation.events,
      progression: progressionDirectiveForTerminalRun(
        { state: updatedState, linkage: input.run.linkage },
        steps,
      ),
    };
  }

  /**
   * Authorize a GOTO against the owned run.
   *
   * @param input - The owned run.
   * @returns A `run_finished` refusal, or `allowed` with the opaque navigation
   *   capability binding authority, graph and versioned state together.
   */
  async resolveRunNavigation(input: LifecycleNavigationInput): Promise<LifecycleNavigationOutcome> {
    const finished = finishedRefusal(input.run);
    if (finished) return finished;
    const leased = this.#leaseRefusal(input.run, 'goto');
    // `goto` clears an Interrupted attempt, so only In Progress can refuse it.
    if (leased?.kind === 'execution_in_progress') return leased;
    const { state } = input.run;
    const steps = await this.#deps.loadSteps(state);
    return {
      kind: 'allowed',
      runId: state.id,
      state,
      navigation: {
        authority: mintRunProgressionAuthority({ runId: state.id }),
        steps,
        run: input.run,
        [lifecycleNavigationCapabilityBrand]: true,
      },
    };
  }

  /**
   * Apply an authorized GOTO with one conditional save.
   *
   * @param input - Core-verified navigation capability and validated target.
   * @returns Applied transition data, or the `concurrent_modification` /
   *   `unknown_token` refusal.
   */
  async runNavigationMutation(
    input: LifecycleNavigationMutationInput,
  ): Promise<LifecycleNavigationMutationOutcome> {
    const { authority, steps, run } = input.navigation;
    const previousState = run.state;
    const prepared = await this.#deps.actorService.prepareActorMutation(
      previousState.id,
      previousState,
      steps,
      { type: 'GOTO', target: input.target },
    );
    const saved = await this.#deps.manager.save(prepared.nextState, run.stateVersion);
    if (saved.kind !== 'committed') return this.#refuseSave(saved.kind, previousState.id);
    return {
      kind: 'applied',
      runId: authority.runId,
      previousState,
      updatedState: saved.state,
      snapshot: prepared.snapshot,
      progression: {
        kind: 'activate',
        authority,
        runbook: saved.state.runbook,
        steps,
        entryBoundary: { kind: 'after_observed_transition', lifecycle: 'running' },
      },
    };
  }

  // The refusal for each save that did not commit. A missing row is another
  // process pruning the run after the frontend resolved its token: a refusal,
  // not a crash, and the token no longer resolves.
  #refuseSave(
    kind: 'concurrent_modification' | 'missing',
    runId: RunId,
  ): ConcurrentModificationRefusal | UnknownTokenRefusal {
    switch (kind) {
      case 'missing':
        return { kind: 'unknown_token' };
      case 'concurrent_modification':
        return concurrentModification(runId);
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unsupported save refusal: ${String(_exhaustive)}`);
      }
    }
  }

  // Apply the execution-lease rule to the owner's decision about the run.
  #leaseRefusal(run: OwnedRun, decision: LeaseDecision): ExecutionLeaseRefusal | undefined {
    return refuseUnderLease(
      run.state.id,
      run.state,
      run.lease,
      decision,
      this.#deps.processIdentity,
    );
  }

  /**
   * Refuse a `pass` on a step whose command Run Progression still owes.
   *
   * The compiled machine decides: with no lease held, a cursor the machine
   * would enter as a `runnable` unit is a command that has not run (a command
   * that ran either moved the cursor with its result or left the lease set).
   * Selection performs no persistence.
   *
   * @param run - The owned run.
   * @param steps - The run's parsed graph.
   * @returns The refusal, or `undefined` when no command is owed.
   */
  async #pendingCommandRefusal(
    run: OwnedRun,
    steps: readonly ResolvedStep[],
  ): Promise<ExecutionPendingRefusal | undefined> {
    if (run.lease !== null) return undefined;
    const { state } = run;
    const intent = await this.#deps.actorService.selectRunProgressionIntent(
      state,
      steps,
      mintRunProgressionAuthority({ runId: state.id }),
    );
    if (intent.kind !== 'entered' || intent.entered.kind !== 'runnable') return undefined;
    const step = deriveExecutionAt(state.step, state.substep);
    return {
      kind: 'execution_pending',
      code: EXECUTION_PENDING_CODE,
      runId: state.id,
      step,
      message: `Step ${step} of run ${state.id} has a command that has not run: the command that entered the step ended before running it. Rundown does not pass a command that never ran, and nothing was written. Run it with \`rundown goto ${step} --token <owner_token>\`, or decide explicitly with \`rundown fail --step ${step} --token <owner_token>\` or \`rundown stop --token <owner_token>\`.`,
    };
  }

  // Find a step by name, throwing on a corrupted state/steps mismatch.
  #findStep(steps: readonly ResolvedStep[], stepName: string): ResolvedStep {
    const step = steps.find((candidate) => candidate.name === stepName);
    if (!step) {
      throw new Error(`Step "${stepName}" not found in runbook definition`);
    }
    return step;
  }
}
