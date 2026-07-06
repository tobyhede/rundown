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
  type ActionType,
  type ClaimRecord,
  type CommandTargetResolution,
  type CommandTargetSelector,
  type ExecutionEventEmitter,
  type ExplicitTransitionTarget,
  type RunbookActorService,
  type ResolvedStep,
  type RunbookState,
  type ClaimId,
  type ClaimCapability,
  type RunId,
  type RunCapability,
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
import { resolveIndexOption } from './index-option.js';
import { getRunbookFromState } from './runbook-loader.js';
import { readLifecycleCallerEvidence } from './caller-evidence.js';
import { runExecutionLoop, type ExecutionTerminalReleaseMode } from '../services/execution.js';
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
  | Extract<
      CommandTargetResolution,
      { kind: 'none' | 'stale_claim' | 'terminal_claim' | 'unknown_run' }
    >;

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
 * @param options - Optional explicit claim-id or run-id target
 * @param options.claimId - Claim id to resolve instead of the default stack
 * @param options.claimCapability - Claim capability to resolve instead of the
 *   default stack
 * @param options.runId - Run id (`--run`) to resolve instead of the default
 *   stack; mutually exclusive with `claimId` (enforced upstream)
 * @param options.runCapability - Run capability proof for `options.runId`
 * @returns `{ kind: 'ready', ctx }` when a target is resolved, or a typed refusal
 * @throws {Error} if state is missing runbookSrc (corrupted state)
 */
export async function buildTransitionContext(
  output: OutputEmitter,
  cwd: string,
  options: {
    readonly claimId?: ClaimId;
    readonly claimCapability?: ClaimCapability;
    readonly runId?: RunId;
    readonly runCapability?: RunCapability;
  } = {},
): Promise<BaseBuildTransitionContextResult> {
  const manager = new RunbookStateManager(cwd);
  const actorService = createCliRunbookActorService(manager);
  const sessionService = new SessionService(manager);
  const lifecycleService = new ExecutionLifecycleService(manager);

  let resolvedKind: 'claim' | 'default' | 'run';
  let state: RunbookState;
  // Resolved claim record, surfaced so the collect command can build a
  // claim-controller actor context; undefined for the default-stack target.
  let claim: ClaimRecord | undefined;

  const active = await resolveCommandTarget(sessionService, {
    ...(options.claimCapability !== undefined ? { claimCapability: options.claimCapability } : {}),
    ...(options.claimId !== undefined ? { claimId: options.claimId } : {}),
    ...(options.runCapability !== undefined ? { runCapability: options.runCapability } : {}),
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
  });
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
    case 'run':
      // Explicit `--run` target: behaves like `default` with the named state
      // in hand (Task 3 mechanical arm; flag registration lands in Task 5).
      resolvedKind = active.kind;
      state = active.state;
      break;
    case 'none':
    case 'stale_claim':
    case 'terminal_claim':
    case 'unknown_run':
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
 * @param idleClaimIds - Open claim ids that are currently idle
 */
export function emitOpenDelegatedChildrenError(
  output: OutputEmitter,
  command: 'pass' | 'fail',
  parentRunId: RunId,
  claimIds: readonly ClaimId[],
  childRunIds: readonly RunId[],
  idleClaimIds: readonly ClaimId[] = [],
): void {
  output.error(
    `Cannot run bare rundown ${command}: active parent runbook has open delegated child claim(s): ${claimIds.join(', ')}. Use \`rundown ${command} --claim-capability <claim_capability>\` to advance a child, or resolve/collect delegated children before advancing the parent.`,
    'OPEN_DELEGATED_CHILDREN',
    {
      command,
      parentRunId,
      claimIds,
      idleClaimIds,
      childRunIds,
      ...(idleClaimIds.length > 0
        ? {
            message:
              'One or more delegated claims have expired leases. Use rundown status to inspect and an explicit operator override to recover.',
          }
        : {}),
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
    `Cannot run bare rundown ${command}: ${message} If this is your ancestor's run, stop here. If this is a run you control, run rundown collect.`,
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
  /** Explicit claim-id target (`--claim-id`). Mutually exclusive with `runId`. */
  readonly claimId?: ClaimId;
  /** Explicit claim capability target (`--claim-capability`). Mutually exclusive with `runId`. */
  readonly claimCapability?: ClaimCapability;
  /** Explicit run capability target (`--run-capability`). Mutually exclusive with claim authority. */
  readonly runCapability?: RunCapability;
  /**
   * Explicit run target and named authority (`--run`). Mutually exclusive with
   * `claimId` (enforced upstream by `parseRunOption`).
   */
  readonly runId?: RunId;
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
        outcome.claims
          .filter((claim) => Date.parse(claim.leaseExpiresAt ?? '') <= Date.now())
          .map((claim) => claim.claimId),
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
      return renderActorContextRequiredRefusal(output, config.commandName);
    case 'unknown_run':
      output.error(outcome.message, 'RUN_TARGET_UNAVAILABLE');
      return true;
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
 * The CLI keeps only Category-A work: it parses the raw `--step` / `--index`
 * strings (step-id syntax, numeric `--index` validation, the AT-conflict
 * check), supplies typed caller evidence, renders the seam's typed outcome,
 * and runs the execution loop. The seam resolves the target exactly once and
 * derives the completion cursor from the raw target INSIDE its completion-lock
 * scope against a locked re-read (#500) — target resolution, policy gating,
 * every state-dependent target validation, the inline-child reactivation
 * decision, record/drain, the machine dispatch, and terminal release all live
 * in the seam.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param config - Transition configuration (command name, action-result policy, terminal policy)
 * @param options - Parsed `--claim-id` / `--step` / `--index` options
 * @returns The bound state manager, the applied transition (when one occurred),
 *   and whether the transition itself requests a non-zero exit code
 * @throws {Error} if the seam refuses an explicit `--step` / `--index` target
 *   against the locked re-read (invalid/mismatched step, missing substep,
 *   template AT expression, out-of-bounds or non-FOR iteration)
 * @throws {IndexOptionError} if `--index` syntax validation fails
 */
export async function runSeamTransition(
  output: OutputEmitter,
  cwd: string,
  config: TransitionConfig,
  options: SeamTransitionOptions = {},
): Promise<SeamTransitionResult> {
  const { manager, seam } = buildNonDelegatingLifecycleSeam(cwd);

  let targetSelector: CommandTargetSelector;
  let explicitTarget: ExplicitTransitionTarget | undefined;

  if (options.step !== undefined) {
    // Category-A string parsing only: numeric `--index` validation and the
    // AT-conflict check. All state-dependent validation (step match, substep
    // existence, FOR bounds, active-iteration default, frame construction)
    // happens in core, inside the completion-lock scope, against the locked
    // re-read (#500).
    const parsedAt = parseStepIdFromString(options.step)?.at;
    const iteration = resolveIndexOption(options.index, parsedAt);
    explicitTarget = {
      stepId: options.step,
      ...(iteration !== undefined ? { iteration } : {}),
    };
    // Selector precedence: claim → run → explicit-step. A run selector with an
    // explicit target composes like claim+step does: the selector names the
    // run, `explicitTarget` carries the step/index, and the seam derives
    // `targeted` from the explicit target's presence (run+step keeps the
    // targeted exemption from the collection guards).
    targetSelector = options.claimCapability
      ? { kind: 'claim-capability', claimCapability: options.claimCapability }
      : options.claimId
        ? { kind: 'claim', claimId: options.claimId }
        : options.runCapability !== undefined
          ? { kind: 'run-capability', runCapability: options.runCapability }
          : options.runId !== undefined
            ? { kind: 'run', runId: options.runId }
            : { kind: 'explicit-step', step: options.step };
  } else if (options.claimCapability) {
    targetSelector = { kind: 'claim-capability', claimCapability: options.claimCapability };
  } else if (options.claimId) {
    targetSelector = { kind: 'claim', claimId: options.claimId };
  } else if (options.runCapability !== undefined) {
    targetSelector = { kind: 'run-capability', runCapability: options.runCapability };
  } else if (options.runId !== undefined) {
    targetSelector = { kind: 'run', runId: options.runId };
  } else {
    targetSelector = { kind: 'default' };
  }

  const outcome = await seam.runTransition({
    command: config.commandName,
    callerEvidence: readLifecycleCallerEvidence(
      options.runCapability !== undefined ? { runCapability: options.runCapability } : {},
    ),
    targetSelector,
    terminalPolicy: config.policy,
    computeActionResult: config.computeActionResult,
    ...(explicitTarget ? { explicitTarget } : {}),
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
