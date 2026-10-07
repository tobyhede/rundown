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
 * as `invalid_step_target`. Nothing is written on any refusal.
 *
 * The seam returns transition-observation events plus a Run Progression
 * directive as data. It does not spawn processes or render.
 *
 * @module runbook/lifecycle-command-service
 */

import type { StepId } from '@rundown-org/parser';
import type { RunbookActorService } from './actor-service.js';
import type { RunProgressionDirective } from './run-progression.js';
import {
  mintRunProgressionAuthority,
  type RunProgressionAuthority,
} from './run-progression-authority.js';
import type { FinishedLifecycle, OwnedRun } from './run-authority.js';
import type { RunId } from './run-id.js';
import type { RunbookStateManager } from './state.js';
import {
  resolveTransitionCursor,
  type ExplicitTransitionTarget,
  type InvalidStepTargetRefusal,
} from './transition-cursor.js';
import type { ActionType } from './transition-kernel.js';
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
  | ConcurrentModificationRefusal
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
  | ConcurrentModificationRefusal
  | {
      readonly kind: 'applied';
      /** The run forced terminal. */
      readonly runId: RunId;
      /** The lifecycle the commit carries. */
      readonly lifecycle: 'completed' | 'stopped';
      /** Terminal observation events for the frontend to render. */
      readonly events: readonly TransitionObservationEvent[];
      /** Whether composition owes a further turn (always `none` until #903). */
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
    const { state: previousState, stateVersion } = input.run;
    const steps = await this.#deps.loadSteps(previousState);

    const cursor = resolveTransitionCursor(steps, previousState, input.target);
    if (cursor.kind === 'invalid_step_target') return cursor;

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
   *   composition owes a further turn (`none` until #903).
   * @throws {Error} When the machine did not reach a terminal lifecycle for a
   *   FORCE event — a programming invariant, not an operator condition.
   */
  async runTerminal(input: LifecycleTerminalInput): Promise<LifecycleTerminalOutcome> {
    const finished = finishedRefusal(input.run);
    if (finished) return finished;
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
      progression: { kind: 'none' },
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
   * @returns Applied transition data or the `concurrent_modification` refusal.
   * @throws {Error} When the run vanished between authorization and the save.
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

  // One refusal shape for every save that did not commit. A missing run here
  // is an invariant: the owned run was read moments ago and nothing in this
  // process deletes it, so a vanished row is thrown rather than rendered.
  #refuseSave(
    kind: 'concurrent_modification' | 'missing',
    runId: RunId,
  ): ConcurrentModificationRefusal {
    if (kind === 'missing') {
      throw new Error(`Run ${runId} vanished before its lifecycle command could be saved`);
    }
    return concurrentModification(runId);
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
