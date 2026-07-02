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
  SessionService,
  ExecutionLifecycleService,
  formatTransitionAction,
  parseStepIdFromString,
  resolveCommandTarget,
  resolveTransitionTarget,
  type ActionType,
  type ClaimRecord,
  type CommandTargetResolution,
  type CommandTargetSelector,
  buildFrameKey,
  deriveExecutionAt,
  deriveActiveFrame,
  activeFrame,
  inactiveFrame,
  type ExecutionEventEmitter,
  type RunbookActorService,
  type ResolvedStep,
  type RunbookState,
  type ClaimId,
  type RunId,
  type ManualCompletionCursor,
  type LifecycleTransitionOutcome,
  type TransitionObservationEvent,
} from '@rundown-org/core';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { buildNonDelegatingLifecycleSeam } from './lifecycle-seam-factory.js';
import {
  renderActorContextRequiredRefusal,
  renderStaleClaimRefusal,
  renderTerminalClaimConfirmed,
  renderTerminalClaimConflict,
} from './refusal-renderers.js';
import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { resolveIndexOption } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import { readLifecycleCallerEvidence } from './caller-evidence.js';
import {
  findStepOrThrow,
  runExecutionLoop,
  type ExecutionTerminalReleaseMode,
} from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import {
  transitionSinkFromEmitter,
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

/**
 * Result of resolving the runbook target and building transition execution
 * context for a base-path (collect) caller.
 *
 * The base path routes through `resolveCommandTarget`, which never performs the
 * open-children refusal nor the confirm/conflict split, so the result is this
 * narrow union. Pass/fail no longer use this — they drive through the core
 * lifecycle seam (see {@link runSeamTransition}).
 */
export type BaseBuildTransitionContextResult =
  | { readonly kind: 'ready'; readonly ctx: TransitionContext }
  | Extract<CommandTargetResolution, { kind: 'none' | 'stale_claim' | 'terminal_claim' }>;

/**
 * Build transition execution context for the active or claimed runbook.
 *
 * Used by collect and other base-path callers. Routes through the base
 * `resolveCommandTarget` (no open-delegated-children refusal — that guard is
 * bare-pass/fail-only and now lives in the core seam). Loads the runbook and
 * parses steps.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param options - Optional explicit claim-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @returns `{ kind: 'ready', ctx }` when a target is resolved, or a typed refusal
 * @throws {Error} if state is missing runbookSrc (corrupted state)
 */
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: { readonly claimId?: ClaimId } = {},
): Promise<BaseBuildTransitionContextResult> {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);

  let resolvedKind: 'claim' | 'default';
  let state: RunbookState;
  // Resolved claim record, surfaced so the collect command can build a
  // claim-controller actor context; undefined for the default-stack target.
  let claim: ClaimRecord | undefined;

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

  const terminalReleaseMode: ExecutionTerminalReleaseMode =
    resolvedKind === 'claim' ? 'release-runbook' : 'stack-pop';
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
      // Base-path callers (collect) are exempt from the bare-pass/fail
      // open-delegated-children guard by construction.
      guardOpenChildren: false,
      ...(claim ? { claim } : {}),
    },
  };
}

/**
 * Resolve the substep completion cursor for an explicit `--step` / `--index`
 * pass/fail transition.
 *
 * Pure Category-A input handling: turns the raw `--step` / `--index` CLI strings
 * into the validated {@link ManualCompletionCursor} the core lifecycle seam
 * consumes. It performs no IO and drives nothing — it only parses, validates,
 * and builds the target frame.
 *
 * Only the explicit-target path remains: the sole caller ({@link
 * runSeamTransition}) always supplies a `--step` target, and the live-cursor
 * derivation it used to fall back to now lives in the core seam's `activeCursor`.
 *
 * The caller is responsible for the routing guard (only call this when the active
 * step is at a substep); this function assumes substep mode and validates the
 * explicit-target details within it.
 *
 * @param steps - Parsed runbook steps for the resolved target run
 * @param activeState - Resolved (active) runbook state being advanced
 * @param explicitTarget - The `--step` / `--index` target to resolve
 * @returns The validated manual completion cursor
 * @throws {Error} on an invalid/mismatched `--step`, a missing or non-existent
 *   substep, a template AT expression, or an out-of-bounds / non-FOR `--index`
 * @throws {IndexOptionError} if `--index` validation or resolution fails
 */
export function resolveManualCompletionCursor(
  steps: readonly ResolvedStep[],
  activeState: RunbookState,
  explicitTarget: ExplicitTarget,
): ManualCompletionCursor {
  const activeStep = findStepOrThrow([...steps], activeState.step);
  // --step targets a substep, so reject if we're not in substep mode.
  if (!activeState.substep || !resolvedStepHasSubsteps(activeStep) || !activeStep.substeps.length) {
    throw new Error(
      `--step requires the runbook to be at a substep, but step "${activeState.step}" has no active substep`,
    );
  }
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
    const activeForFrame = deriveActiveFrame(activeState);
    resolvedIndex = activeForFrame.iteration;
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

  return {
    step: parsed.step,
    substep: parsed.substep,
    ...(resolvedIndex !== undefined ? { iteration: resolvedIndex } : {}),
    frame,
    at: deriveExecutionAt(parsed.step, parsed.substep, resolvedIndex),
  };
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
 * Single-sources the message/code/details shape so every refusal path that
 * surfaces it — the core seam's resolver pre-check and `runGuardedParentAdvance`
 * atomic re-check, rendered by {@link runSeamTransition} — stays identical. The
 * structured `details` payload (`parentRunId`, `claimIds`, `childRunIds`) is the
 * contract the MCP facade relies on.
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
  command: 'pass' | 'fail' | 'delegate' | 'complete' | 'stop',
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

/** CLI options forwarded to a pass/fail seam transition. */
export interface SeamTransitionOptions {
  /** Explicit claim-id target (`--claim-id`). */
  readonly claimId?: ClaimId;
  /** Explicit substep target (`--step`). */
  readonly step?: string;
  /** Raw `--index` value (requires `--step`). */
  readonly index?: string;
}

/**
 * Result of driving a pass/fail transition through the core lifecycle seam.
 *
 * `applied` is present only when a transition actually mutated a run; the caller
 * uses its `runId` to drive the post-transition parent-propagation/exit-code
 * block. `exitError` is the transition's own exit-code request before parent
 * propagation. The `manager` is returned so the caller can reload the mutated run
 * without constructing a second state manager.
 */
export interface SeamTransitionResult {
  /** State manager bound to this command's cwd. */
  readonly manager: RunbookStateManager;
  /** Present when a transition was applied; drives parent propagation. */
  readonly applied?: { readonly status: 'continue' | 'stopped'; readonly runId: RunId };
  /** Whether the transition itself requests a non-zero exit (before propagation). */
  readonly exitError: boolean;
}

// Dispatch core transition observation events to a sink (the shared event loop
// also used by orchestrateTransition and the execution loop).
function renderTransitionEvents(
  events: readonly TransitionObservationEvent[],
  sink: TransitionEventSink,
): void {
  for (const event of events) {
    switch (event.type) {
      case 'ERROR_OCCURRED':
        sink.onErrorOccurred?.(event.payload);
        break;
      case 'STEP_TRANSITIONED':
        sink.onStepTransitioned(event.payload);
        break;
      case 'RUNBOOK_COMPLETED':
        sink.onRunbookCompleted(event.payload);
        break;
      case 'RUNBOOK_STOPPED':
        sink.onRunbookStopped(event.payload);
        break;
      default: {
        const _exhaustive: never = event;
        throw new Error(`unreachable transition observation event: ${String(_exhaustive)}`);
      }
    }
  }
}

// Sink that renders a top-level run transition as a single buffered action
// object (the agent-facing JSON shape for bare `rd pass` / `rd fail`).
function buildActionSink(output: OutputEmitter): TransitionEventSink {
  return {
    onErrorOccurred: (payload) => {
      output.error(payload.message, payload.code);
    },
    onStepTransitioned: (payload) => {
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
    onRunbookCompleted: (payload) => {
      output.complete(payload.message, payload.finalPosition);
    },
    onRunbookStopped: (payload) => {
      output.stopped(payload.message, payload.position);
    },
  };
}

// Render a refused seam outcome to the existing CLI error / idempotent envelopes.
// Returns whether the refusal requests a non-zero exit code.
function renderRefusal(
  output: OutputEmitter,
  config: TransitionConfig,
  outcome: Exclude<LifecycleTransitionOutcome, { kind: 'applied' }>,
): boolean {
  switch (outcome.kind) {
    case 'none':
      output.noActiveRunbook(config.commandName);
      return false;
    case 'stale_claim':
      return renderStaleClaimRefusal(output, outcome.message);
    case 'terminal_claim_confirmed':
      return renderTerminalClaimConfirmed(
        output,
        config.commandName,
        outcome.claimId,
        outcome.lifecycle,
      );
    case 'terminal_claim_conflict':
      return renderTerminalClaimConflict(
        output,
        outcome.claimId,
        outcome.expectedResult,
        outcome.requestedResult,
      );
    case 'open_delegated_children':
      emitOpenDelegatedChildrenError(
        output,
        config.commandName,
        outcome.parentRunId,
        outcome.claims.map((claim) => claim.claimId),
        outcome.claims.map((claim) => claim.childRunId),
      );
      return true;
    case 'delegation_collection_pending':
      emitDelegationCollectionPendingError(
        output,
        config.commandName,
        outcome.parentRunId,
        outcome.outcomeCompletionKeys,
        outcome.message,
      );
      return true;
    case 'actor_context_required':
      return renderActorContextRequiredRefusal(output, config.commandName, outcome.targetRunId);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Render an applied transition: idempotent duplicate status, the observation
// events (a buffered action for a top-level run transition, streamed execution
// events for a substep drain), then the execution loop per the seam directive.
async function renderApplied(
  output: OutputEmitter,
  cwd: string,
  config: TransitionConfig,
  manager: RunbookStateManager,
  outcome: Extract<LifecycleTransitionOutcome, { kind: 'applied' }>,
): Promise<{ readonly status: 'continue' | 'stopped'; readonly runId: RunId }> {
  if (outcome.duplicate) {
    output.status(config.commandName, `Completion already recorded for ${outcome.duplicate.at}`, {
      status: 'already-resolved',
      at: outcome.duplicate.at,
      frameKey: outcome.duplicate.frameKey,
      entry: outcome.duplicate.entry,
    });
  }

  let status: 'continue' | 'stopped' = outcome.status === 'stopped' ? 'stopped' : 'continue';
  let emitter: ExecutionEventEmitter | undefined;
  let liveState: RunbookState | null = outcome.updatedState ?? null;
  const loadLive = async (): Promise<RunbookState | null> => {
    liveState ??= await manager.load(outcome.runId);
    return liveState;
  };

  if (outcome.events.length > 0) {
    if (outcome.mutation === 'manual-completion') {
      const state = await loadLive();
      if (state) {
        emitter = createBridgedEmitter(state, output);
        renderTransitionEvents(outcome.events, transitionSinkFromEmitter(emitter));
      }
    } else {
      renderTransitionEvents(outcome.events, buildActionSink(output));
    }
  }

  if (outcome.loop.kind === 'run') {
    const state = await loadLive();
    if (state) {
      const steps = getRunbookFromState(state, cwd);
      emitter ??= createBridgedEmitter(state, output);
      const loopResult = await runExecutionLoop(
        manager,
        outcome.runId,
        [...steps],
        cwd,
        outcome.loop.prompted,
        emitter,
        { terminalReleaseMode: outcome.terminalReleaseMode, output },
      );
      if (loopResult === 'stopped') status = 'stopped';
    }
  }

  return { status, runId: outcome.runId };
}

/**
 * Drive a pass/fail transition through the core lifecycle command seam.
 *
 * The CLI keeps only Category-A work: it parses `--step` / `--index` into a
 * pre-resolved completion cursor (for the explicit-target path), supplies typed
 * caller evidence, renders the seam's typed outcome, and runs the execution loop.
 * Target resolution, policy gating, the inline-child reactivation decision,
 * record/drain, the machine dispatch, and terminal release all live in the seam.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param config - Transition configuration (command name, action-result policy, terminal policy)
 * @param options - Parsed `--claim-id` / `--step` / `--index` options
 * @returns The bound state manager, the applied transition (when one occurred),
 *   and whether the transition itself requests a non-zero exit code
 * @throws {Error} if an explicit `--step` / `--index` target is invalid
 * @throws {IndexOptionError} if `--index` validation or resolution fails
 */
export async function runSeamTransition(
  output: OutputEmitter,
  cwd: string,
  config: TransitionConfig,
  options: SeamTransitionOptions = {},
): Promise<SeamTransitionResult> {
  const { manager, sessionService, seam } = buildNonDelegatingLifecycleSeam(cwd);

  let targetSelector: CommandTargetSelector;
  let manualTarget: ManualCompletionCursor | undefined;

  if (options.step !== undefined) {
    // Resolve once to derive the explicit-target cursor — Category-A parsing needs
    // the resolved state + steps. A refusal leaves the cursor undefined; the seam
    // call below re-resolves and renders the same typed refusal.
    const resolved = await resolveTransitionTarget(sessionService, {
      command: config.commandName,
      ...(options.claimId ? { claimId: options.claimId } : {}),
      targeted: true,
    });
    if (resolved.kind === 'default' || resolved.kind === 'claim') {
      const steps = getRunbookFromState(resolved.state, cwd);
      manualTarget = resolveManualCompletionCursor(steps, resolved.state, {
        stepId: options.step,
        ...(options.index !== undefined ? { index: options.index } : {}),
      });
    }
    targetSelector = options.claimId
      ? { kind: 'claim', claimId: options.claimId }
      : { kind: 'explicit-step', step: options.step };
  } else if (options.claimId) {
    targetSelector = { kind: 'claim', claimId: options.claimId };
  } else {
    targetSelector = { kind: 'default' };
  }

  const outcome = await seam.runTransition({
    command: config.commandName,
    callerEvidence: readLifecycleCallerEvidence(),
    targetSelector,
    terminalPolicy: config.policy,
    computeActionResult: config.computeActionResult,
    ...(manualTarget ? { manualTarget } : {}),
  });

  if (outcome.kind !== 'applied') {
    const exitError = renderRefusal(output, config, outcome);
    output.flush();
    return { manager, exitError };
  }

  const applied = await renderApplied(output, cwd, config, manager, outcome);
  output.flush();
  return { manager, applied, exitError: applied.status === 'stopped' };
}
