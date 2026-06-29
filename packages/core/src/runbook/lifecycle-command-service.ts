import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import {
  UNKNOWN_ACTOR_CONTEXT,
  actorContextFromEvidence,
  type ActorContext,
  type CallerEvidence,
} from './actor-context.js';
import type { RunbookActorService } from './actor-service.js';
import type { ClaimId, ClaimRecord } from './claim-id.js';
import type { CommandTargetSelector, DelegationPolicyOutcome } from './command-policy.js';
import { resolveCommandIntent } from './command-policy.js';
import {
  resolveTransitionTarget,
  type TransitionCommandName,
  type TransitionTargetResolution,
} from './command-target-resolver.js';
import type { DELEGATION_COLLECTION_PENDING_MESSAGE } from './delegation-lifecycle-read-model.js';
import type { ExecutionLifecycleService } from './execution-lifecycle-service.js';
import { isRunId, type RunId } from './run-id.js';
import type { SessionService } from './session-service.js';
import type { RunbookCompletionService } from './completion-service.js';
import type { ActionType } from './transition-kernel.js';
import {
  deriveTransitionObservation,
  type TransitionObservationEvent,
} from '../events/transition-observation.js';
import type { Frame } from './targeting.js';
import {
  activeFrame,
  completionEntryForFrame,
  deriveActiveFrame,
  deriveExecutionAt,
} from './targeting.js';
import type { ResolvedStep, RunbookState } from './types.js';

/**
 * Core services the lifecycle command seam drives.
 *
 * Mirrors {@link RunbookCollectionServiceDependencies}: the seam takes its
 * collaborators through one structural interface so callers inject already
 * constructed core services and tests pass trivial doubles. The seam adds
 * `sessionService` because the decisive parent-advance write is guarded by
 * {@link SessionService.runGuardedParentAdvance} and terminal release flows
 * through {@link SessionService.releaseRunbook}.
 */
export interface RunbookLifecycleCommandServiceDependencies {
  /** Session service used for target resolution, the TOCTOU guard, and terminal release. */
  readonly sessionService: SessionService;
  /** Actor service used to dispatch top-level PASS/FAIL through the state machine. */
  readonly actorService: RunbookActorService;
  /** Lifecycle service used to ensure the active frame entry before/after a transition. */
  readonly lifecycleService: ExecutionLifecycleService;
  /** Completion service used to record and drain resolved substep completions. */
  readonly completionService: RunbookCompletionService;
  /**
   * Load a run's persisted state by id, or `undefined` when it does not exist.
   *
   * Narrow read capability used by the bare-substep inline-child reactivation
   * decision (it must inspect the running inline child's lifecycle and parent
   * linkage). Deliberately narrower than the whole {@link RunbookStateManager} so
   * test doubles stay trivial.
   */
  readonly loadRun: (runId: RunId) => Promise<RunbookState | undefined>;
  /**
   * Derive the parsed steps for a resolved run from its in-memory state.
   *
   * The seam resolves the target run exactly once and then derives its steps from
   * the resolved state's `runbookSrc`. Step derivation is parsing plus an
   * environment-bound helper-registry + render context (Category A), not runbook
   * file IO — so this callable carries only that environment context, letting the
   * seam own the single resolution without taking `steps` as an input the
   * frontend would have to resolve first. The callable receives the resolved
   * state (bare/`--step` → active run; `--claim-id` → the claimed child run).
   */
  readonly loadSteps: (
    state: RunbookState,
  ) => readonly ResolvedStep[] | Promise<readonly ResolvedStep[]>;
}

/**
 * Terminal side-effect policy applied when a transition reaches a terminal state.
 *
 * The seam owns terminal release because it is runbook lifecycle logic, not CLI
 * rendering: when a run completes or stops, its session targeting is released
 * (claims retained as terminal tombstones so `--claim-id` can confirm/conflict).
 */
export interface LifecycleTerminalReleasePolicy {
  /** Release the runbook from session targeting when it completes. */
  readonly onComplete: { readonly releaseRunbook: boolean };
  /** Release the runbook from session targeting when it stops. */
  readonly onStopped: { readonly releaseRunbook: boolean };
}

/**
 * Pre-resolved explicit substep cursor for `--step` / `--index` transitions.
 *
 * The frontend parses and validates the raw `--step` / `--index` CLI input
 * (Category A input handling) and hands the seam a resolved cursor. A bare
 * transition supplies no cursor and the seam derives the active cursor itself.
 */
export interface ManualCompletionCursor {
  /** Target step id. */
  readonly step: string;
  /** Target substep id. */
  readonly substep: string;
  /** Target FOR iteration, when applicable. */
  readonly iteration?: number;
  /** Resolved targeting frame for the completion. */
  readonly frame: Frame;
  /** Qualified position string (e.g. `1.2.1`) used in idempotent status output. */
  readonly at: string;
}

/** How a follow-on terminal release should treat this run during execution-loop continuation. */
export type LifecycleTerminalReleaseMode = 'release-runbook' | 'stack-pop';

/**
 * Directive telling the frontend whether to run the execution loop after the
 * seam applied a transition. The loop spawns command-step subprocesses, which is
 * inherently a CLI side effect (Category A); the seam decides whether it should
 * run and the frontend runs it.
 */
export type LifecycleLoopDirective =
  | { readonly kind: 'none' }
  | { readonly kind: 'run'; readonly prompted: boolean };

/** Input to {@link RunbookLifecycleCommandService.runTransition}. */
export interface LifecycleTransitionInput {
  /**
   * The manual transition being attempted. This is also the result the command
   * persists: `pass` drives PASS, `fail` drives FAIL. The two are the same fact,
   * so the seam derives the persisted result from `command` rather than taking a
   * second field that could silently disagree with it.
   */
  readonly command: TransitionCommandName;
  /** Typed caller evidence mapped to an actor context by core. */
  readonly callerEvidence: CallerEvidence;
  /** Discriminated target selector (default / claim / explicit-step). */
  readonly targetSelector: CommandTargetSelector;
  /** Terminal side-effect policy shared with execution-loop transitions. */
  readonly terminalPolicy: LifecycleTerminalReleasePolicy;
  /** Optional display-result policy for the transition observation projection. */
  readonly computeActionResult?: (actionType: ActionType) => boolean;
  /**
   * Pre-resolved explicit substep cursor. Present for `--step` / `--index`
   * targets; absent for a bare transition (the seam derives the active cursor).
   */
  readonly manualTarget?: ManualCompletionCursor;
}

/**
 * Result of applying a pass/fail transition through the seam.
 *
 * The refusal variants reuse the {@link TransitionTargetResolution} shapes so the
 * `DELEGATION_COLLECTION_PENDING_MESSAGE` literal type and the distinct terminal
 * claim confirm/conflict payloads are preserved by construction. The `applied`
 * variant carries the transition observation events for the frontend to render,
 * the coarse halted/terminal status, and a loop-continuation directive.
 */
export type LifecycleTransitionOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'stale_claim'; readonly claimId: ClaimId; readonly message: string }
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly result: TransitionCommandName;
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedResult: TransitionCommandName;
      readonly requestedResult: TransitionCommandName;
    }
  | {
      readonly kind: 'open_delegated_children';
      readonly parentRunId: RunId;
      readonly claims: readonly ClaimRecord[];
    }
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | { readonly kind: 'actor_context_required'; readonly targetRunId: RunId }
  | {
      readonly kind: 'applied';
      /** Run the transition was applied to. */
      readonly runId: RunId;
      /**
       * Which of the two mutation paths produced this outcome. The frontend uses
       * it to pick the matching renderer: a top-level `run-transition` renders a
       * single buffered action; a `manual-completion` (substep) drain renders
       * streamed execution events. (Documented domain distinction — see the Task 3
       * contract's two mutation paths — not a render-only flag.)
       */
      readonly mutation: 'run-transition' | 'manual-completion';
      /** How a follow-on execution loop should release this run terminally. */
      readonly terminalReleaseMode: LifecycleTerminalReleaseMode;
      /** Coarse transition status used by the frontend for exit-code/flow decisions. */
      readonly status: 'continue' | 'done' | 'stopped';
      /** Transition observation events for the frontend to render. */
      readonly events: readonly TransitionObservationEvent[];
      /** Whether/how the frontend should run the execution loop next. */
      readonly loop: LifecycleLoopDirective;
      /** Updated state when the run is still active (`status === 'continue'`). */
      readonly updatedState?: RunbookState;
      /**
       * Idempotent re-record marker. Present when a substep completion was already
       * recorded; the frontend renders an `already-resolved` status.
       */
      readonly duplicate?: {
        readonly at: string;
        readonly frameKey: Frame['frameKey'];
        readonly entry: number;
      };
    };

/** Internal runtime target derived from the active cursor or an explicit cursor. */
interface ResolvedCursor {
  readonly step: string;
  readonly substep: string | undefined;
  readonly iteration: number | undefined;
  readonly frame: Frame;
  readonly at: string;
}

function activeCursor(state: RunbookState): ResolvedCursor {
  const active = deriveActiveFrame(state);
  const frameKey = state.activeFrameKey ?? active.frameKey;
  return {
    step: active.step,
    substep: state.substep,
    iteration: active.iteration,
    frame: activeFrame(frameKey, state.activeEntry ?? 1),
    at: deriveExecutionAt(active.step, state.substep, active.iteration),
  };
}

/**
 * Core seam for direct lifecycle command mutations (pass / fail) and the
 * transitional delegation-issuance policy precheck.
 *
 * This is the single place cross-run pass/fail mutations enter core: it maps
 * typed caller evidence to an actor context, resolves the target and runs target
 * policy (refusals), and drives the state machine for both mutation paths —
 * manual substep completion (record + drain) and top-level run transition (send
 * PASS/FAIL) — preserving the {@link SessionService.runGuardedParentAdvance}
 * TOCTOU guard and terminal release behaviour. It returns transition observation
 * events plus a loop-continuation directive as data; the frontend renders the
 * events and runs the execution loop (process spawning stays a CLI concern).
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
   * Run delegation-issuance policy for a bare `delegate` without issuing.
   *
   * Transitional precheck: maps caller evidence to an actor context and asks the
   * core command policy whether a bare delegation issuance is allowed against the
   * target run. It performs no inference, no `createDelegation`, and no
   * persistence — it only returns the typed policy outcome for the frontend to
   * gate on.
   *
   * @param input - Target run and caller evidence.
   * @param input.targetState - Resolved active run that would issue the delegation.
   * @param input.callerEvidence - Typed caller evidence mapped to an actor context.
   * @returns The core command-policy outcome for a bare delegation issuance.
   */
  precheckDelegationIssuance(input: {
    readonly targetState: RunbookState;
    readonly callerEvidence: CallerEvidence;
  }): DelegationPolicyOutcome {
    const actorContext = actorContextFromEvidence(input.callerEvidence, input.targetState.id);
    return resolveCommandIntent({
      actorContext,
      intent: { kind: 'delegation-issuance', command: 'delegate', targeted: false },
      targetSelector: { kind: 'default' },
      targetState: input.targetState,
    });
  }

  /**
   * Resolve the target, run target policy, and drive the state machine for a
   * pass/fail transition.
   *
   * @param input - Command, caller evidence, target selector, and terminal policy.
   *   Steps are derived in-seam via the injected `loadSteps` dependency, not taken
   *   as an input.
   * @returns A typed refusal or an `applied` outcome carrying observation events
   *   and a loop-continuation directive.
   * @throws {Error} When state is stale/mismatched, the machine dispatch fails,
   *   or a persisted completion does not match the active cursor.
   */
  async runTransition(input: LifecycleTransitionInput): Promise<LifecycleTransitionOutcome> {
    const { sessionService } = this.#deps;
    const targeted = input.targetSelector.kind === 'explicit-step';
    const claimId =
      input.targetSelector.kind === 'claim' ? input.targetSelector.claimId : undefined;

    const actorContext = await this.#resolveActorContext(input.callerEvidence, claimId);

    const resolution = await resolveTransitionTarget(sessionService, {
      command: input.command,
      ...(claimId ? { claimId } : {}),
      targeted,
      actorContext,
    });

    const refusal = this.#asRefusal(resolution);
    if (refusal) return refusal;
    // Narrow to the two states carrying a resolved run.
    if (resolution.kind !== 'claim' && resolution.kind !== 'default') {
      // Exhaustiveness guard: every non-ready variant is handled by #asRefusal.
      const _unreachable: never = resolution as never;
      return _unreachable;
    }

    // A ready explicit-step transition must carry its resolved cursor. Without
    // it, #drive() would silently fall back to the active cursor / top-level
    // path and mutate the wrong unit. Refusals already returned above, so this
    // only fires on a ready resolution missing its target — fail fast rather
    // than silently mapping to the active cursor.
    if (targeted && input.manualTarget === undefined) {
      throw new Error('Explicit-step transition requires a resolved manual target cursor');
    }

    const terminalReleaseMode: LifecycleTerminalReleaseMode =
      resolution.kind === 'claim' ? 'release-runbook' : 'stack-pop';
    const guardOpenChildren = resolution.kind === 'default' && !targeted;

    // Single resolution: derive the resolved run's steps in-seam from its
    // in-memory state, rather than taking `steps` as an input that would force the
    // frontend to resolve the target first (a redundant run-state read).
    const steps = await this.#deps.loadSteps(resolution.state);

    return this.#drive(input, steps, resolution.state, terminalReleaseMode, guardOpenChildren);
  }

  // Map caller evidence to an actor context anchored on the resolved run.
  // `direct_cli` evidence anchors on the active default run; `claim` evidence
  // anchors on its own controlled run; everything else maps to the unknown
  // context. Returns the unknown context when no anchor run exists (a direct-CLI
  // caller with no active run is refused downstream as `none`).
  async #resolveActorContext(
    evidence: CallerEvidence,
    claimId: ClaimId | undefined,
  ): Promise<ActorContext> {
    if (evidence.kind === 'claim') {
      return actorContextFromEvidence(evidence, evidence.controlledRunId);
    }
    if (claimId !== undefined) {
      // Claim-targeted writes resolve through the resolver's claim path, which
      // does not consult the actor context for the bare-advance gate.
      return UNKNOWN_ACTOR_CONTEXT;
    }
    const active = await this.#deps.sessionService.getActive();
    if (!active) return UNKNOWN_ACTOR_CONTEXT;
    return actorContextFromEvidence(evidence, active.id);
  }

  // Map a non-ready resolution to its refusal outcome, or `undefined` when ready.
  #asRefusal(resolution: TransitionTargetResolution): LifecycleTransitionOutcome | undefined {
    switch (resolution.kind) {
      case 'claim':
      case 'default':
        return undefined;
      case 'none':
        return { kind: 'none' };
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: resolution.claimId, message: resolution.message };
      case 'terminal_claim_confirmed':
        return {
          kind: 'terminal_claim_confirmed',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          result: resolution.result,
        };
      case 'terminal_claim_conflict':
        return {
          kind: 'terminal_claim_conflict',
          claimId: resolution.claimId,
          lifecycle: resolution.lifecycle,
          expectedResult: resolution.expectedResult,
          requestedResult: resolution.requestedResult,
        };
      case 'open_delegated_children':
        return {
          kind: 'open_delegated_children',
          parentRunId: resolution.parentRunId,
          claims: resolution.claims,
        };
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: resolution.parentRunId,
          outcomeCompletionKeys: resolution.outcomeCompletionKeys,
          message: resolution.message,
        };
      case 'actor_context_required':
        return { kind: 'actor_context_required', targetRunId: resolution.targetRunId };
      default: {
        const _exhaustive: never = resolution;
        return _exhaustive;
      }
    }
  }

  // Drive the machine for the resolved target, dispatching on substep vs top-level.
  async #drive(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    state: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, lifecycleService } = this.#deps;
    const fresh = await actorService.assertFreshState(state.id, steps);
    if (!fresh) {
      throw new Error('Runbook state is stale or mismatched with current definition');
    }
    const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
    const activeState = ensured.state;
    const activeStep = this.#findStep(steps, activeState.step);
    // A `manualTarget` is always an explicit substep cursor (`--step` / `--index`),
    // so it must route through the substep completion path even when the live
    // cursor is parked on a top-level step (`activeState.substep` unset) — the
    // top-level path ignores `manualTarget` entirely.
    const isSubstepCompletion =
      input.manualTarget !== undefined ||
      Boolean(
        activeState.substep && resolvedStepHasSubsteps(activeStep) && activeStep.substeps.length,
      );

    if (isSubstepCompletion) {
      return this.#driveSubstep(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
    }
    return this.#driveTopLevel(input, steps, activeState, terminalReleaseMode, guardOpenChildren);
  }

  // Manual substep completion path: record (guarded) then drain resolved completions.
  async #driveSubstep(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { completionService, sessionService } = this.#deps;
    const explicit = input.manualTarget;
    const cursor: ResolvedCursor = explicit
      ? {
          step: explicit.step,
          substep: explicit.substep,
          iteration: explicit.iteration,
          frame: explicit.frame,
          at: explicit.at,
        }
      : activeCursor(activeState);
    const targetSubstep = cursor.substep;
    if (!targetSubstep) {
      throw new Error('Substep completion requires an active or explicit substep target');
    }

    // Bare (non-explicit) transition at a substep whose inline child is still
    // running: this is "advance the thing the operator is looking at" — resume
    // the child rather than record a completion against the parent. The decision
    // (is the child still open?) is runbook logic and belongs in core; the effect
    // is `SessionService.pushRunbook`. The explicit `--step` path never
    // reactivates — it is a deliberate completion against a named substep.
    if (!explicit && (await this.#reactivateRunningInlineChild(activeState))) {
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: 'continue',
        events: [],
        loop: { kind: 'none' },
      };
    }

    const recordManualCompletion = (): ReturnType<
      RunbookCompletionService['recordManualCompletion']
    > =>
      completionService.recordManualCompletion({
        runbookId: activeState.id,
        currentState: activeState,
        targetStep: cursor.step,
        targetSubstep,
        ...(cursor.iteration !== undefined ? { targetIteration: cursor.iteration } : {}),
        targetFrame: cursor.frame,
        result: input.command,
        agentId: 'manual',
      });

    let recordResult: Awaited<ReturnType<RunbookCompletionService['recordManualCompletion']>>;
    if (guardOpenChildren) {
      const guarded = await sessionService.runGuardedParentAdvance(
        activeState.id,
        recordManualCompletion,
      );
      const guardRefusal = this.#guardRefusal(guarded, activeState.id);
      if (guardRefusal) return guardRefusal;
      // Narrowed: only the advanced variant remains.
      recordResult = (guarded as { readonly kind: 'advanced'; readonly value: typeof recordResult })
        .value;
    } else {
      recordResult = await recordManualCompletion();
    }

    const duplicate =
      recordResult.status === 'duplicate'
        ? {
            at: cursor.at,
            frameKey: cursor.frame.frameKey,
            entry: completionEntryForFrame(cursor.frame),
          }
        : undefined;

    const drainEvents: TransitionObservationEvent[] = [];
    let drainState: RunbookState = activeState;
    let observedState: RunbookState = activeState;
    let applied = 0;
    let terminalStatus: 'done' | 'stopped' | undefined;

    drainLoop: for (;;) {
      const drained = await completionService.drainResolvedCompletions({
        runbookId: activeState.id,
        steps,
        currentState: drainState,
        maxApplied: 1,
        ...(explicit ? { frameOverride: explicit.frame } : {}),
      });

      if (drained.status === 'failed') {
        throw new Error(drained.message);
      }
      if (drained.status === 'not_active') {
        break;
      }

      for (const appliedCompletion of drained.applied) {
        const currentStep = this.#findStep(steps, appliedCompletion.stateBefore.step);
        const observation = deriveTransitionObservation({
          steps,
          currentStep,
          previousState: appliedCompletion.stateBefore,
          updatedState: appliedCompletion.stateAfter,
          snapshot: appliedCompletion.snapshot,
          result: appliedCompletion.completion.result,
          ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
        });
        drainEvents.push(...observation.events);
        applied += 1;
        if (observation.status === 'done' || observation.status === 'stopped') {
          await this.#applyTerminalSideEffects(input, observation.status, activeState.id);
          terminalStatus = observation.status;
          break drainLoop;
        }
        observedState = observation.state;
        drainState = observation.state;
      }

      if (drained.status === 'done' || drained.status === 'stopped') {
        // A drain can report terminal even when the last applied completion's
        // observation did not (the two terminal derivations consume the same
        // snapshot but are independent). Apply terminal release here too so this
        // exit can never skip the seam-owned terminal side effect.
        await this.#applyTerminalSideEffects(input, drained.status, activeState.id);
        terminalStatus = drained.status;
        break;
      }
      if (drained.applied.length === 0) {
        break;
      }
    }

    if (terminalStatus) {
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'manual-completion',
        terminalReleaseMode,
        status: terminalStatus,
        events: drainEvents,
        loop: { kind: 'none' },
        ...(duplicate ? { duplicate } : {}),
      };
    }

    const loop: LifecycleLoopDirective =
      applied > 0 ? { kind: 'run', prompted: Boolean(observedState.prompted) } : { kind: 'none' };
    return {
      kind: 'applied',
      runId: activeState.id,
      mutation: 'manual-completion',
      terminalReleaseMode,
      status: 'continue',
      events: drainEvents,
      loop,
      ...(applied > 0 ? { updatedState: observedState } : {}),
      ...(duplicate ? { duplicate } : {}),
    };
  }

  // Top-level run transition path: send PASS/FAIL (guarded), observe, release.
  async #driveTopLevel(
    input: LifecycleTransitionInput,
    steps: readonly ResolvedStep[],
    activeState: RunbookState,
    terminalReleaseMode: LifecycleTerminalReleaseMode,
    guardOpenChildren: boolean,
  ): Promise<LifecycleTransitionOutcome> {
    const { actorService, lifecycleService, sessionService } = this.#deps;
    const previousState: RunbookState = { ...activeState };
    const currentStep = this.#findStep(steps, previousState.step);
    // Exhaustive map from command to engine event. A `never` fallthrough makes a
    // future `TransitionCommandName` member a compile error here rather than a
    // silent collapse to FAIL (see CLAUDE.md § No silent mapping).
    const eventType = ((): 'PASS' | 'FAIL' => {
      switch (input.command) {
        case 'pass':
          return 'PASS';
        case 'fail':
          return 'FAIL';
        default: {
          const _exhaustive: never = input.command;
          throw new Error(`Unsupported transition command: ${String(_exhaustive)}`);
        }
      }
    })();

    const sendAndSync = (): ReturnType<RunbookActorService['sendAndSync']> =>
      actorService.sendAndSync(activeState.id, steps, { type: eventType });

    let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
    if (guardOpenChildren) {
      const guarded = await sessionService.runGuardedParentAdvance(activeState.id, sendAndSync);
      const guardRefusal = this.#guardRefusal(guarded, activeState.id);
      if (guardRefusal) return guardRefusal;
      syncResult = (guarded as { readonly kind: 'advanced'; readonly value: typeof syncResult })
        .value;
    } else {
      syncResult = await sendAndSync();
    }
    if (!syncResult) {
      throw new Error('Failed to dispatch transition to runbook engine');
    }

    const ensuredAfter = await lifecycleService.ensureActiveEntry(
      activeState.id,
      previousState,
      syncResult.state,
    );
    const updatedState = ensuredAfter.state;

    const observation = deriveTransitionObservation({
      steps,
      currentStep,
      previousState,
      updatedState,
      snapshot: syncResult.snapshot,
      result: input.command,
      ...(input.computeActionResult ? { computeActionResult: input.computeActionResult } : {}),
    });

    if (observation.status === 'done' || observation.status === 'stopped') {
      await this.#applyTerminalSideEffects(input, observation.status, activeState.id);
      return {
        kind: 'applied',
        runId: activeState.id,
        mutation: 'run-transition',
        terminalReleaseMode,
        status: observation.status,
        events: observation.events,
        loop: { kind: 'none' },
      };
    }

    return {
      kind: 'applied',
      runId: activeState.id,
      mutation: 'run-transition',
      terminalReleaseMode,
      status: 'continue',
      events: observation.events,
      loop: { kind: 'run', prompted: Boolean(updatedState.prompted) },
      updatedState,
    };
  }

  // Apply terminal release per policy when a transition reaches a terminal state.
  async #applyTerminalSideEffects(
    input: LifecycleTransitionInput,
    status: 'done' | 'stopped',
    runId: RunId,
  ): Promise<void> {
    const releaseRunbook =
      status === 'done'
        ? input.terminalPolicy.onComplete.releaseRunbook
        : input.terminalPolicy.onStopped.releaseRunbook;
    if (releaseRunbook) {
      await this.#deps.sessionService.releaseRunbook(runId, { retainClaimsAsTerminal: true });
    }
  }

  // Map a guarded-advance refusal to its outcome, or `undefined` when it advanced.
  #guardRefusal(
    guarded:
      | { readonly kind: 'advanced'; readonly value: unknown }
      | { readonly kind: 'open_delegated_children'; readonly claims: ClaimRecord[] }
      | {
          readonly kind: 'delegation_collection_pending';
          readonly parentRunId: RunId;
          readonly outcomeCompletionKeys: readonly string[];
          readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
        },
    parentRunId: RunId,
  ): LifecycleTransitionOutcome | undefined {
    if (guarded.kind === 'open_delegated_children') {
      return {
        kind: 'open_delegated_children',
        parentRunId,
        claims: guarded.claims,
      };
    }
    if (guarded.kind === 'delegation_collection_pending') {
      return {
        kind: 'delegation_collection_pending',
        parentRunId: guarded.parentRunId,
        outcomeCompletionKeys: guarded.outcomeCompletionKeys,
        message: guarded.message,
      };
    }
    return undefined;
  }

  // Derive the run id of the running inline child launched at the active substep,
  // or `undefined` when the active substep has no running inline child.
  #findRunningInlineChildRunId(state: RunbookState): RunId | undefined {
    if (!state.substep) return undefined;
    const active = deriveActiveFrame(state);
    const frameKey = state.activeFrameKey ?? active.frameKey;
    const substepState = state.substepStates?.find(
      (entry) => entry.id === state.substep && entry.frameKey === frameKey,
    );
    if (substepState?.status !== 'running') return undefined;
    const childRunId = substepState.inline?.childRunId;
    return isRunId(childRunId) ? childRunId : undefined;
  }

  // Resume the active substep's running inline child when its linkage matches the
  // parent cursor, pushing it onto the session if it is not already active.
  // Returns true when the child was reactivated (caller must skip recording).
  async #reactivateRunningInlineChild(parentState: RunbookState): Promise<boolean> {
    const childRunId = this.#findRunningInlineChildRunId(parentState);
    if (!childRunId) return false;

    const childState = await this.#deps.loadRun(childRunId);
    if (childState?.lifecycle !== 'running') return false;
    const linkage = childState.parentLinkage;
    const parentFrame = deriveActiveFrame(parentState);
    const parentFrameKey = parentState.activeFrameKey ?? parentFrame.frameKey;
    const parentEntry = parentState.activeEntry ?? 1;
    if (
      linkage?.kind !== 'inline' ||
      linkage.parentRunId !== parentState.id ||
      linkage.parentStep !== parentState.step ||
      linkage.parentStepId !== parentState.substep ||
      linkage.parentFrameKey !== parentFrameKey ||
      linkage.parentEntry !== parentEntry
    ) {
      return false;
    }

    const active = await this.#deps.sessionService.getActive();
    if (active?.id !== childRunId) {
      await this.#deps.sessionService.pushRunbook(childRunId);
    }
    return true;
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
