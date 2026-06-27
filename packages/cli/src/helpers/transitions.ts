/**
 * Shared logic for pass/fail transition commands.
 *
 * This module extracts common patterns from pass.ts and fail.ts into
 * reusable functions, with configuration-driven behavior for the
 * semantic differences between pass and fail transitions.
 *
 * @module helpers/transitions
 */

import {
  RunbookStateManager,
  RunbookCompletionService,
  SessionService,
  ExecutionLifecycleService,
  formatTransitionAction,
  parseStepIdFromString,
  resolveCommandTarget,
  resolveTransitionTarget,
  type ActionType,
  type ActorContextSource,
  type ClaimRecord,
  type CommandTargetResolution,
  buildFrameKey,
  deriveExecutionAt,
  deriveActiveFrame,
  activeFrame,
  inactiveFrame,
  completionEntryForFrame,
  type Frame,
  type RunbookActorService,
  type ResolvedStep,
  type RunbookState,
  type RunbookCompletedPayload,
  type RunbookStoppedPayload,
  type StepTransitionedPayload,
  type ErrorOccurredPayload,
  type ClaimId,
  type RunId,
  isRunId,
  type DELEGATION_COLLECTION_PENDING_MESSAGE,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { resolveIndexOption } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import {
  drainResolvedCompletions,
  findStepOrThrow,
  runExecutionLoop,
  type ExecutionTerminalReleaseMode,
} from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  orchestrateTransition,
  type TransitionEventSink,
  type TransitionOrchestrationPolicy,
} from './transition-orchestrator.js';
export type { ActionType } from '@rundown-org/core';

/**
 * Configuration for transition behavior.
 *
 * Captures all semantic differences between pass and fail commands
 * in a declarative structure.
 */
export interface TransitionConfig {
  /** Event type to send to the actor */
  eventType: 'PASS' | 'FAIL';
  /** Command name for error messages */
  commandName: 'pass' | 'fail';
  /**
   * lastResult value to persist (user's command choice).
   * pass='pass', fail='fail'
   */
  lastResult: 'pass' | 'fail';
  /**
   * Compute action result for output.action().
   * pass: derived from actionType (false for RETRY/STOP)
   * fail: always false
   */
  computeActionResult: (actionType: ActionType) => boolean;
  /** Terminal side-effect policy shared with execution loop transitions. */
  policy: TransitionOrchestrationPolicy;
}

/**
 * Canonical PASS transition behavior.
 *
 * @returns TransitionConfig for PASS transitions
 */
export function createPassTransitionConfig(): TransitionConfig {
  return {
    eventType: 'PASS',
    commandName: 'pass',
    lastResult: 'pass',
    computeActionResult: (actionType: ActionType) =>
      actionType !== 'RETRY' && actionType !== 'STOP',
    policy: {
      onStopped: {
        releaseRunbook: true,
      },
      onComplete: {
        releaseRunbook: true,
      },
    },
  };
}

/**
 * Canonical FAIL transition behavior.
 *
 * @returns TransitionConfig for FAIL transitions
 */
export function createFailTransitionConfig(): TransitionConfig {
  return {
    eventType: 'FAIL',
    commandName: 'fail',
    lastResult: 'fail',
    computeActionResult: () => false,
    policy: {
      onStopped: {
        releaseRunbook: true,
      },
      onComplete: {
        releaseRunbook: true,
      },
    },
  };
}

/**
 * Context for executing a transition.
 *
 * Contains all the resolved state needed for transition execution.
 */
export interface TransitionContext {
  /** Output emitter for CLI output */
  output: OutputEmitter;
  /** Runbook state manager */
  manager: RunbookStateManager;
  /** Actor lifecycle service */
  actorService: RunbookActorService;
  /** Session stack orchestration service */
  sessionService: SessionService;
  /** Execution lifecycle service */
  lifecycleService: ExecutionLifecycleService;
  /** Current runbook state */
  state: RunbookState;
  /** Parsed runbook steps */
  steps: ResolvedStep[];
  /** Current working directory */
  cwd: string;
  /** How terminal follow-on execution should release this runbook from session targeting. */
  terminalReleaseMode: ExecutionTerminalReleaseMode;
  /**
   * When true, the decisive parent-advance write is run through
   * {@link SessionService.runGuardedParentAdvance} so the open-delegated-children
   * guard is re-checked atomically under the session lock (closing the
   * check-then-act race against a concurrent `rd claim`). Set only for a bare
   * pass/fail targeting the default parent; false for claim-targeted writes
   * (which advance a child) and for collect.
   */
  guardOpenChildren: boolean;
  /**
   * Resolved claim record when the target was selected via `--claim-id`;
   * undefined for the default-stack target. Carries `claimId` and `tokenHash`
   * needed to build a claim-controller actor context for core policy. Surfaced
   * on the base (collect) path only — see {@link buildTransitionContext}.
   */
  claim?: ClaimRecord;
}

/** Result of resolving the runbook target and building transition execution context. */
export type BuildTransitionContextResult =
  | { readonly kind: 'ready'; readonly ctx: TransitionContext }
  | Extract<CommandTargetResolution, { kind: 'none' | 'stale_claim' | 'terminal_claim' }>
  | {
      readonly kind: 'terminal_claim_confirmed';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly result: 'pass' | 'fail';
    }
  | {
      readonly kind: 'terminal_claim_conflict';
      readonly claimId: ClaimId;
      readonly lifecycle: 'completed' | 'stopped';
      readonly expectedResult: 'pass' | 'fail';
      readonly requestedResult: 'pass' | 'fail';
    }
  | {
      readonly kind: 'open_delegated_children';
      readonly parentRunId: RunId;
      readonly claimIds: readonly ClaimId[];
      readonly childRunIds: readonly RunId[];
    }
  | {
      readonly kind: 'delegation_collection_pending';
      readonly parentRunId: RunId;
      readonly outcomeCompletionKeys: readonly string[];
      readonly message: typeof DELEGATION_COLLECTION_PENDING_MESSAGE;
    }
  | {
      /**
       * Strict-core refusal surfaced from {@link resolveTransitionTarget} when no
       * trusted actor evidence resolves the target. Unreachable from the direct
       * CLI (which always passes `directCliCompatibility`); kept so the result is
       * exhaustive and renders consistently for non-CLI front ends.
       */
      readonly kind: 'actor_context_required';
      readonly targetRunId: RunId;
    };

/**
 * Command-absent build result (collect and other non-pass/fail callers).
 *
 * The base path routes through `resolveCommandTarget`, which never performs the
 * open-children refusal nor the confirm/conflict split, so the result is the
 * narrow base union. Returning this from the command-absent overload keeps
 * collect's exhaustive `default: never` switch valid.
 */
export type BaseBuildTransitionContextResult =
  | { readonly kind: 'ready'; readonly ctx: TransitionContext }
  | Extract<CommandTargetResolution, { kind: 'none' | 'stale_claim' | 'terminal_claim' }>;

/**
 * Build full transition context from resolved state.
 *
 * Loads runbook and parses steps.
 *
 * Pass/fail supply `command` and route through the core `resolveTransitionTarget`
 * (including the open-delegated-children refusal); callers that omit `command`
 * (e.g. collect) route through the base `resolveCommandTarget` and are exempt
 * from that refusal by construction.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - Optional transition command and explicit claim-id target
 * @param options.command - When supplied (`pass`/`fail`), route through the
 *   transition resolver; when absent, route through the base command resolver.
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @param options.step - Explicit `--step` target. When present, the transition
 *   is deliberate and exempt from the bare-only open-delegated-children refusal
 *   (both the resolver pre-check and the decisive-write re-check are skipped).
 * @param options.actorSource - Provenance tag (`--actor-source` /
 *   `RD_ACTOR_SOURCE`) threaded into core's trusted-controller construction for
 *   the default (non-claim) target; absent falls back to the `direct-cli` lane.
 * @returns `{ kind: 'ready', ctx }` when a target is resolved, or a typed
 *   refusal/confirm/conflict outcome otherwise.
 * @throws {Error} if state is missing runbookSrc (corrupted state)
 */
export function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: {
    readonly command: 'pass' | 'fail';
    readonly claimId?: ClaimId;
    readonly step?: string;
    readonly actorSource?: ActorContextSource;
  },
): Promise<BuildTransitionContextResult>;
export function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options?: { readonly claimId?: ClaimId },
): Promise<BaseBuildTransitionContextResult>;
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: {
    readonly command?: 'pass' | 'fail';
    readonly claimId?: ClaimId;
    readonly step?: string;
    readonly actorSource?: ActorContextSource;
  } = {},
): Promise<BuildTransitionContextResult> {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);

  let resolvedKind: 'claim' | 'default';
  let state: RunbookState;
  // Resolved claim record, surfaced on the base (collect) path only so the
  // collect command can build a claim-controller actor context. The pass/fail
  // path leaves this undefined (out of scope until Plan 5/6).
  let claim: ClaimRecord | undefined;

  if (options.command !== undefined) {
    // Pass/fail path: core-owned targeting. The open-children refusal applies to
    // bare transitions only; a `--step` target is deliberate and exempt.
    const active = await resolveTransitionTarget(sessionService, {
      command: options.command,
      claimId: options.claimId,
      targeted: options.step !== undefined,
      // Supply the source-tagged trusted-controller context only for the
      // default (non-claim) target; core resolves the active run id and the
      // bare advance is the only path that evaluates actor context. When an
      // explicit source is absent, fall back to the direct-cli compatibility
      // lane so behavior is byte-identical to before.
      ...(options.actorSource && options.claimId === undefined
        ? { actorContextSource: options.actorSource }
        : { directCliCompatibility: true }),
    });
    switch (active.kind) {
      case 'claim':
      case 'default':
        resolvedKind = active.kind;
        state = active.state;
        break;
      case 'none':
        return { kind: 'none' };
      case 'stale_claim':
        return { kind: 'stale_claim', claimId: active.claimId, message: active.message };
      case 'terminal_claim_confirmed':
        return {
          kind: 'terminal_claim_confirmed',
          claimId: active.claimId,
          lifecycle: active.lifecycle,
          result: active.result,
        };
      case 'terminal_claim_conflict':
        return {
          kind: 'terminal_claim_conflict',
          claimId: active.claimId,
          lifecycle: active.lifecycle,
          expectedResult: active.expectedResult,
          requestedResult: active.requestedResult,
        };
      case 'open_delegated_children':
        return {
          kind: 'open_delegated_children',
          parentRunId: active.parentRunId,
          claimIds: active.claims.map((claim) => claim.claimId),
          childRunIds: active.claims.map((claim) => claim.childRunId),
        };
      case 'delegation_collection_pending':
        return {
          kind: 'delegation_collection_pending',
          parentRunId: active.parentRunId,
          outcomeCompletionKeys: active.outcomeCompletionKeys,
          message: active.message,
        };
      case 'actor_context_required':
        return { kind: 'actor_context_required', targetRunId: active.targetRunId };
      default: {
        const _exhaustive: never = active;
        return _exhaustive;
      }
    }
  } else {
    // Base path (collect and any non-pass/fail caller): no open-children refusal.
    const active = await resolveCommandTarget(sessionService, { claimId: options.claimId });
    switch (active.kind) {
      case 'claim':
        resolvedKind = active.kind;
        state = active.state;
        claim = active.claim;
        break;
      case 'default':
        resolvedKind = active.kind;
        state = active.state;
        break;
      case 'none':
      case 'stale_claim':
      case 'terminal_claim':
        return active;
      default: {
        const _exhaustive: never = active;
        return _exhaustive;
      }
    }
  }

  const terminalReleaseMode: ExecutionTerminalReleaseMode =
    resolvedKind === 'claim' ? 'release-runbook' : 'stack-pop';
  // Guard only a bare pass/fail (command supplied, no explicit `--step`) that
  // targets the default parent. Targeted `--step` transitions are deliberate
  // (exempt), claim-targeted writes advance a child (exempt), and collect (no
  // command) is exempt by construction.
  const guardOpenChildren =
    options.command !== undefined && resolvedKind === 'default' && options.step === undefined;
  const readonlySteps = getRunbookFromState(state, cwd);
  const steps = [...readonlySteps]; // Convert to mutable array for TransitionContext

  return {
    kind: 'ready',
    ctx: {
      output,
      manager,
      actorService,
      sessionService,
      lifecycleService,
      state,
      steps,
      cwd,
      terminalReleaseMode,
      guardOpenChildren,
      ...(claim ? { claim } : {}),
    },
  };
}

interface RuntimeTarget {
  step: string;
  substep?: string;
  iteration?: number;
  frame: Frame;
  at: string;
}

function toRuntimeTarget(
  step: string,
  substep: string | undefined,
  iteration: number | undefined,
  frame: Frame,
): RuntimeTarget {
  return {
    step,
    substep,
    iteration,
    frame,
    at: deriveExecutionAt(step, substep, iteration),
  };
}

function activeCursorTarget(state: RunbookState): RuntimeTarget {
  const active = deriveActiveFrame(state);
  const frameKey = state.activeFrameKey ?? active.frameKey;
  return toRuntimeTarget(
    active.step,
    state.substep,
    active.iteration,
    activeFrame(frameKey, state.activeEntry ?? 1),
  );
}

function findRunningInlineChildRunId(state: RunbookState): RunId | undefined {
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

async function reactivateRunningInlineChild(
  ctx: TransitionContext,
  parentState: RunbookState,
): Promise<boolean> {
  const childRunId = findRunningInlineChildRunId(parentState);
  if (!childRunId) return false;

  const childState = await ctx.manager.load(childRunId);
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

  const active = await ctx.sessionService.getActive();
  if (active?.id !== childRunId) {
    await ctx.sessionService.pushRunbook(childRunId);
  }
  return true;
}

/**
 * Explicit target for directing a transition at a specific substep and iteration.
 *
 * Used by `pass --step` and `fail --step` to target a specific substep
 * rather than the current cursor position.
 */
export interface ExplicitTarget {
  /** Step ID string (e.g., "1.1") */
  stepId: string;
  /** Optional `--index` value (raw string from CLI) */
  index?: string;
}

/**
 * Emit the `OPEN_DELEGATED_CHILDREN` refusal for a bare pass/fail that would
 * advance a parent with open claimed children.
 *
 * Single-sources the message/code/details shape so the pre-check in
 * {@link buildTransitionContext} (via the resolver) and the atomic re-check
 * inside {@link executeTransition} stay identical. The structured `details`
 * payload (`parentRunId`, `claimIds`, `childRunIds`) is the contract the MCP
 * facade relies on.
 *
 * @param output - Output emitter to write the error to
 * @param command - The bare transition that was refused (`pass`/`fail`)
 * @param parentRunId - Active parent runbook id
 * @param claimIds - Open claim ids blocking the advance
 * @param childRunIds - Child run ids for the open claims
 */
export function emitOpenDelegatedChildrenError(
  output: OutputEmitter,
  command: 'pass' | 'fail',
  parentRunId: RunId,
  claimIds: readonly ClaimId[],
  childRunIds: readonly RunId[],
): void {
  output.error(
    `Cannot run bare rd ${command}: active parent runbook has open delegated child claim(s): ${claimIds.join(', ')}. Use \`rd ${command} --claim-id <claim_id>\` to advance a child, or resolve/collect delegated children before advancing the parent.`,
    'OPEN_DELEGATED_CHILDREN',
    {
      command,
      parentRunId,
      claimIds,
      childRunIds,
    },
  );
}

/**
 * Emit the DELEGATION_COLLECTION_PENDING refusal for a bare pass/fail.
 *
 * @param output - Output emitter to write the error to
 * @param command - Bare command that was refused
 * @param parentRunId - Delegating run that must be collected
 * @param outcomeCompletionKeys - Reported outcome completion keys blocking the command
 * @param message - Core policy guidance
 */
export function emitDelegationCollectionPendingError(
  output: OutputEmitter,
  command: 'pass' | 'fail' | 'delegate',
  parentRunId: RunId,
  outcomeCompletionKeys: readonly string[],
  message: string,
): void {
  // Include the spec's actionable ancestor-vs-controlled guidance (spec lines
  // 584-588): the reader needs to know whether to stop or to collect.
  output.error(
    `Cannot run bare rd ${command}: ${message} If this is your ancestor's run, stop here. If this is a run you control, run rd collect.`,
    'DELEGATION_COLLECTION_PENDING',
    {
      command,
      parentRunId,
      outcomeCompletionKeys,
    },
  );
}

/**
 * Perform a pass/fail transition against the active runbook state.
 *
 * Records or reuses a resolved completion when targeting a substep; otherwise sends the configured
 * transition event to the runbook actor, orchestrates step-level changes, and runs the execution loop
 * as required. Emits CLI output for actions, completions, runbook completion, and stopped conditions.
 *
 * @param ctx - Runtime transition context containing output, services, current state, parsed steps, and cwd
 * @param config - Transition configuration that determines the event type, persisted result, action-result mapping, and terminal policy
 * @param explicitTarget - Optional explicit step/substep target (e.g., "2.1") and optional raw `--index` value to target a specific iteration
 * @returns `'continue'` when execution proceeds or completes normally, `'stopped'` when a terminal stop was reached
 * @throws {Error} if the active step is missing, an explicit target is invalid, or lifecycle/orchestration validations fail
 * @throws {IndexOptionError} if `--index` validation or resolution fails
 */
export async function executeTransition(
  ctx: TransitionContext,
  config: TransitionConfig,
  explicitTarget?: ExplicitTarget,
): Promise<'continue' | 'stopped'> {
  const { output, manager, actorService, state, steps, cwd, lifecycleService } = ctx;
  const stateIsFresh = await actorService.assertFreshState(state.id, steps);
  if (!stateIsFresh) {
    throw new Error('Runbook state is stale or mismatched with current definition');
  }
  const ensured = await lifecycleService.ensureActiveEntry(state.id, undefined, state);
  const activeState = ensured.state;
  const activeStep = findStepOrThrow(steps, activeState.step);
  const isSubstepCompletion = !!(
    activeState.substep &&
    resolvedStepHasSubsteps(activeStep) &&
    activeStep.substeps.length
  );

  // Guard: --step targets a substep, so reject if we're not in substep mode
  if (explicitTarget && !isSubstepCompletion) {
    throw new Error(
      `--step requires the runbook to be at a substep, but step "${activeState.step}" has no active substep`,
    );
  }

  if (isSubstepCompletion) {
    // If explicit target, build RuntimeTarget from parsed step ID + resolved index
    let cursor: RuntimeTarget;
    if (explicitTarget) {
      const parsed = parseStepIdFromString(explicitTarget.stepId);
      if (!parsed) {
        throw new Error(`Invalid step target: ${explicitTarget.stepId}`);
      }
      if (parsed.step !== activeState.step) {
        throw new Error(
          `--step ${explicitTarget.stepId} targets step "${parsed.step}" but the active step is "${activeState.step}"`,
        );
      }
      // Require substep — bare step IDs create unreachable completions
      if (!parsed.substep) {
        throw new Error(
          `--step ${explicitTarget.stepId} must include a substep (e.g., "${parsed.step}.1")`,
        );
      }
      // Validate substep exists in the step definition
      if (parsed.substep && resolvedStepHasSubsteps(activeStep)) {
        const validIds = activeStep.substeps.map((s) => s.id);
        if (!validIds.includes(parsed.substep)) {
          throw new Error(
            `--step ${explicitTarget.stepId}: substep "${parsed.substep}" does not exist in step "${parsed.step}". Valid substeps: ${validIds.join(', ')}`,
          );
        }
      }

      let resolvedIndex = resolveIndexOption(explicitTarget.index, parsed.at);

      // Reject template AT expressions — they cannot be resolved in pass/fail context
      if (typeof parsed.at === 'string') {
        throw new Error(
          `--step ${explicitTarget.stepId} uses template AT expression "${parsed.at}", which cannot be resolved here. Use --index <number> instead.`,
        );
      }

      // Default to active iteration when inside a FOR step without explicit --index
      if (
        resolvedIndex === undefined &&
        (activeStep.kind === 'for' || activeStep.kind === 'prompted-for')
      ) {
        const activeFrame = deriveActiveFrame(activeState);
        resolvedIndex = activeFrame.iteration;
      }

      // Validate iteration bounds against step definition
      if (resolvedIndex !== undefined) {
        if (activeStep.kind !== 'for' && activeStep.kind !== 'prompted-for') {
          throw new Error(
            `--index requires step "${parsed.step}" to be a FOR or PROMPTED-FOR step, but it is "${activeStep.kind}"`,
          );
        }
        // Bounds checks only apply to 'for' steps (prompted-for has no forClause)
        if (activeStep.kind === 'for') {
          const fc = activeStep.forClause;
          if (resolvedIndex < fc.start) {
            throw new Error(
              `--index ${String(resolvedIndex)} is below FOR start ${String(fc.start)} for step "${parsed.step}"`,
            );
          }
          if ('end' in fc && resolvedIndex > fc.end) {
            throw new Error(
              `--index ${String(resolvedIndex)} exceeds FOR end ${String(fc.end)} for step "${parsed.step}"`,
            );
          }
        }
      }

      const targetFrameKey = buildFrameKey(parsed.step, resolvedIndex);
      const active = deriveActiveFrame(activeState);
      const activeFrameKey = activeState.activeFrameKey ?? active.frameKey;
      const activeEntry = activeState.activeEntry ?? 1;
      const frame =
        targetFrameKey === activeFrameKey
          ? activeFrame(targetFrameKey, activeEntry)
          : inactiveFrame(targetFrameKey);

      cursor = toRuntimeTarget(parsed.step, parsed.substep, resolvedIndex, frame);
    } else {
      cursor = activeCursorTarget(activeState);
    }
    const targetSubstep = explicitTarget ? cursor.substep : activeState.substep;
    if (!targetSubstep) {
      throw new Error('Substep completion requires an active or explicit substep target');
    }
    if (!explicitTarget && (await reactivateRunningInlineChild(ctx, activeState))) {
      output.flush();
      return 'continue';
    }
    const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    const recordManualCompletion = (): ReturnType<
      RunbookCompletionService['recordManualCompletion']
    > =>
      completionService.recordManualCompletion({
        runbookId: activeState.id,
        currentState: activeState,
        targetStep: cursor.step,
        targetSubstep,
        targetIteration: cursor.iteration,
        targetFrame: cursor.frame,
        result: config.lastResult,
        agentId: 'manual',
      });
    let recorded: Awaited<ReturnType<RunbookCompletionService['recordManualCompletion']>>;
    if (ctx.guardOpenChildren) {
      // Atomic re-check: close the TOCTOU window between the resolver's
      // open-children check and this decisive substep-completion write.
      const guarded = await ctx.sessionService.runGuardedParentAdvance(
        activeState.id,
        recordManualCompletion,
      );
      if (guarded.kind === 'delegation_collection_pending') {
        emitDelegationCollectionPendingError(
          output,
          config.commandName,
          guarded.parentRunId,
          guarded.outcomeCompletionKeys,
          guarded.message,
        );
        output.flush();
        return 'stopped';
      }
      if (guarded.kind === 'open_delegated_children') {
        emitOpenDelegatedChildrenError(
          output,
          config.commandName,
          activeState.id,
          guarded.claims.map((claim) => claim.claimId),
          guarded.claims.map((claim) => claim.childRunId),
        );
        output.flush();
        return 'stopped';
      }
      recorded = guarded.value;
    } else {
      recorded = await recordManualCompletion();
    }
    if (recorded.status === 'duplicate') {
      output.status(config.commandName, `Completion already recorded for ${cursor.at}`, {
        status: 'already-resolved',
        at: cursor.at,
        frameKey: cursor.frame.frameKey,
        entry: completionEntryForFrame(cursor.frame),
      });
    }

    const emitter = createBridgedEmitter(activeState, output);
    const drained = await drainResolvedCompletions({
      actorService,
      manager,
      sessionService: ctx.sessionService,
      lifecycleService,
      emitter,
      runbookId: activeState.id,
      steps,
      currentState: activeState,
      transitionPolicy: config.policy,
      computeActionResult: config.computeActionResult,
      ...(explicitTarget ? { frameOverride: cursor.frame } : {}),
    });
    if (drained.status === 'done') {
      output.flush();
      return 'continue';
    }
    if (drained.status === 'stopped') {
      output.flush();
      return 'stopped';
    }
    if (drained.status === 'failed') {
      throw new Error(drained.message);
    }
    if (drained.status === 'not_active') {
      output.flush();
      return 'continue';
    }
    if (drained.applied === 0) {
      output.flush();
      return 'continue';
    }

    const loopResult = await runExecutionLoop(
      manager,
      activeState.id,
      steps,
      cwd,
      !!drained.state.prompted,
      emitter,
      { terminalReleaseMode: ctx.terminalReleaseMode, output },
    );
    output.flush();
    if (loopResult === 'stopped') {
      return 'stopped';
    }
    return 'continue';
  }

  // Capture previous state before mutation.
  const previousState = { ...activeState };
  const currentStep = findStepOrThrow(steps, previousState.step);

  const sendAndSync = (): ReturnType<RunbookActorService['sendAndSync']> =>
    actorService.sendAndSync(activeState.id, steps, { type: config.eventType });
  let syncResult: Awaited<ReturnType<RunbookActorService['sendAndSync']>>;
  if (ctx.guardOpenChildren) {
    // Atomic re-check: close the TOCTOU window between the resolver's
    // open-children check and this decisive step-transition write.
    const guarded = await ctx.sessionService.runGuardedParentAdvance(activeState.id, sendAndSync);
    if (guarded.kind === 'delegation_collection_pending') {
      emitDelegationCollectionPendingError(
        output,
        config.commandName,
        guarded.parentRunId,
        guarded.outcomeCompletionKeys,
        guarded.message,
      );
      output.flush();
      return 'stopped';
    }
    if (guarded.kind === 'open_delegated_children') {
      emitOpenDelegatedChildrenError(
        output,
        config.commandName,
        activeState.id,
        guarded.claims.map((claim) => claim.claimId),
        guarded.claims.map((claim) => claim.childRunId),
      );
      output.flush();
      return 'stopped';
    }
    syncResult = guarded.value;
  } else {
    syncResult = await sendAndSync();
  }
  if (!syncResult) {
    throw new Error('Failed to dispatch transition to runbook engine');
  }
  const { state: actorUpdatedState, snapshot: rawSnapshot } = syncResult;

  const ensuredAfterTransition = await lifecycleService.ensureActiveEntry(
    activeState.id,
    previousState,
    actorUpdatedState,
  );
  const updatedState = ensuredAfterTransition.state;

  const commandSink: TransitionEventSink = {
    onErrorOccurred: (payload: ErrorOccurredPayload) => {
      output.error(payload.message, payload.code);
    },
    onStepTransitioned: (payload: StepTransitionedPayload) => {
      output.action({
        action: formatTransitionAction(
          payload.action,
          payload.at,
          payload.retryAttempt,
          payload.retryMax,
          payload.forIndex,
        ),
        from: payload.from,
        at: payload.at,
        result: payload.result,
        ...(payload.forIndex !== undefined
          ? { forIndex: payload.forIndex, forEnd: payload.forEnd }
          : {}),
        ...(payload.command ? { command: payload.command } : {}),
      });
    },
    onRunbookCompleted: (payload: RunbookCompletedPayload) => {
      output.complete(payload.message, payload.finalPosition);
    },
    onRunbookStopped: (payload: RunbookStoppedPayload) => {
      output.stopped(payload.message, payload.position);
    },
  };

  const orchestration = await orchestrateTransition({
    sessionService: ctx.sessionService,
    sink: commandSink,
    runbookId: activeState.id,
    steps,
    currentStep,
    previousState,
    updatedState,
    snapshot: rawSnapshot,
    result: config.lastResult,
    computeActionResult: config.computeActionResult,
    policy: config.policy,
  });

  if (orchestration.status === 'stopped') {
    output.flush();
    return 'stopped';
  }
  if (orchestration.status === 'done') {
    output.flush();
    return 'continue';
  }

  const emitter = createBridgedEmitter(updatedState, output);
  const loopResult = await runExecutionLoop(
    manager,
    activeState.id,
    steps,
    cwd,
    !!updatedState.prompted,
    emitter,
    { terminalReleaseMode: ctx.terminalReleaseMode, output },
  );

  output.flush();
  if (loopResult === 'stopped') {
    return 'stopped';
  }
  return 'continue';
}
