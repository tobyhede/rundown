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
  CONCURRENT_MODIFICATION_CODE,
  formatTransitionAction,
  parseStepIdFromString,
  type ActionType,
  type ExecutionEventEmitter,
  type ExplicitTransitionTarget,
  type RunbookState,
  type RunbookStateManager,
  type RunId,
  type RunProgressionOutcome,
  type CommandExecutionStreamOptions,
  type LifecycleTransitionOutcome,
  type OwnerToken,
  type TransitionObservationEvent,
} from '@rundown-org/core';
import { buildLifecycleSeam } from './lifecycle-seam-factory.js';
import { resolveCommandTarget } from './command-target.js';
import { IndexOptionError, resolveIndexOption, type IndexOptionErrorCode } from './index-option.js';
import { driveRunProgression, progressionFailedClosed } from './run-progression-adapters.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { createBridgedEmitter } from './execution-emitter.js';
import { transitionSinkFromEmitter, type TransitionEventSink } from './transition-orchestrator.js';
import {
  renderExecutionLeaseRefusal,
  renderOwnedRunRefusal,
  renderRunFinished,
} from './token-option.js';
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
  };
}

/** CLI options forwarded to a pass/fail seam transition. */
export interface SeamTransitionOptions {
  /** The Owner Token naming the run (`--token`), already parsed. */
  readonly token: OwnerToken;
  /** Raw `--step` value; required by core, forwarded as `undefined` when absent. */
  readonly step?: string;
  /** Raw `--index` value (requires `--step`). */
  readonly index?: string;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/**
 * Result of driving a pass/fail transition through the core lifecycle seam.
 *
 * `applied` preserves the semantic lifecycle and closed progression outcome for
 * transport adapters and tests. `exitError` is the independent process-exit
 * request; it never rewrites that semantic status.
 */
export interface SeamTransitionResult {
  /** Present when a transition was applied. */
  readonly applied?: {
    readonly status: 'continue' | 'done' | 'stopped';
    readonly runId: RunId;
    /**
     * The closed Run Progression outcome. The seam always directs activation
     * after an applied transition, so this is present whenever `applied` is.
     */
    readonly progression?: RunProgressionOutcome;
  };
  /** Whether the transition itself requests a non-zero exit (before progression). */
  readonly exitError: boolean;
}

// Dispatch core transition observation events to a sink (the shared event stream
// also used by orchestrateTransition and Run Progression).
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
// object (the agent-facing JSON shape for a top-level `rd pass` / `rd fail`).
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

/**
 * Render a refused seam outcome to the CLI error envelopes and report whether
 * the refusal requests a non-zero exit code.
 *
 * Three refusals survive under one writer per run: a `--step` / `--index`
 * target outside the contract (`INVALID_STEP`, nothing written), a token
 * whose run already finished (RD-303 / RD-304), and a conditional save that
 * found the row moved (`CONCURRENT_MODIFICATION`, nothing written, never
 * retried).
 *
 * @param output - Output emitter for CLI output.
 * @param config - Transition configuration naming the command.
 * @param outcome - A non-`applied` seam outcome.
 * @returns `true`: every refusal requests a non-zero exit.
 */
export function renderRefusal(
  output: OutputEmitter,
  config: TransitionConfig,
  outcome: Exclude<LifecycleTransitionOutcome, { kind: 'applied' }>,
): boolean {
  switch (outcome.kind) {
    case 'invalid_step_target':
      // Refused by core before anything was written (#763): the run is
      // untouched and the message names the current position.
      output.error(outcome.message, 'INVALID_STEP');
      return true;
    case 'run_finished':
      renderRunFinished(output, config.commandName, outcome.runId, outcome.lifecycle);
      return true;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      return true;
    case 'execution_in_progress':
    case 'execution_interrupted':
      return renderExecutionLeaseRefusal(output, outcome);
    case 'execution_pending':
      // Core refused to pass a step whose command never ran; nothing written.
      output.error(outcome.message, outcome.code, { runId: outcome.runId, step: outcome.step });
      return true;
    case 'unknown_token':
      // The run was pruned between token resolution and the save: the token no
      // longer resolves, exactly as if it had been unknown from the start.
      return renderOwnedRunRefusal(output, config.commandName, outcome);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Render an applied transition: the observation events from the initiating
 * transition, then core Run Progression per the seam directive.
 *
 * A transition at a substep streams its events through the run's event
 * emitter (a mid substep emits a plain `step_transitioned`, the last one an
 * aggregated transition); a top-level transition renders as the single
 * buffered action object agents read back. A transition on an Inline Child
 * (#903) streams too, so its events carry the child's run id rather than
 * reading as the outcome of the run the agent started. The choice keys off
 * the cursor the command resolved — rendering, not a lifecycle decision.
 *
 * @param output - Output emitter for CLI output.
 * @param cwd - Current working directory.
 * @param manager - State manager used to reload the mutated run.
 * @param previous - The run state the transition was applied to.
 * @param outcome - The seam's `applied` outcome.
 * @param commandStreamOptions - Runtime-only routing for command subprocess streams.
 * @param inlineChild - Whether the transition's run is an Inline Child.
 * @returns The semantic status, run id, progression outcome and exit request.
 */
export async function renderApplied(
  output: OutputEmitter,
  cwd: string,
  manager: RunbookStateManager,
  previous: RunbookState,
  outcome: Extract<LifecycleTransitionOutcome, { kind: 'applied' }>,
  commandStreamOptions?: CommandExecutionStreamOptions,
  inlineChild = false,
): Promise<{
  readonly status: 'continue' | 'done' | 'stopped';
  readonly runId: RunId;
  readonly progression?: RunProgressionOutcome;
  readonly exitError: boolean;
}> {
  let emitter: ExecutionEventEmitter | undefined;
  let liveState: RunbookState | null = outcome.updatedState ?? null;
  const loadLive = async (): Promise<RunbookState | null> => {
    liveState ??= await manager.load(outcome.runId);
    return liveState;
  };

  if (outcome.events.length > 0) {
    if (previous.substep !== undefined || inlineChild) {
      const state = (await loadLive()) ?? previous;
      emitter = createBridgedEmitter(state, output);
      renderTransitionEvents(outcome.events, transitionSinkFromEmitter(emitter));
    } else {
      renderTransitionEvents(outcome.events, buildActionSink(output));
    }
  }

  const state = await loadLive();
  if (state) {
    emitter ??= createBridgedEmitter(state, output);
  }
  const progression = await driveRunProgression(outcome.progression, {
    manager,
    cwd,
    output,
    ...(emitter !== undefined ? { sink: emitter } : {}),
    ...(commandStreamOptions !== undefined ? { commandStreamOptions } : {}),
  });

  return {
    status: outcome.status,
    runId: outcome.runId,
    progression,
    // Semantic lifecycle and process exit are different axes. A refusal or
    // invocation failure closes this command non-zero without inventing a
    // stopped run.
    exitError: progressionFailedClosed(progression),
  };
}

/** Parsed `--step` / `--index` target, or the typed refusal of malformed input. */
type ParsedTransitionTarget =
  | { readonly kind: 'parsed'; readonly target: ExplicitTransitionTarget | undefined }
  | { readonly kind: 'invalid'; readonly message: string; readonly code: IndexOptionErrorCode };

// Category-A string parsing only: numeric `--index` validation and the
// AT-conflict check. Every state-dependent check (step match, substep match,
// FOR iteration) happens in core before anything is written.
function parseTransitionTarget(
  step: string | undefined,
  index: string | undefined,
): ParsedTransitionTarget {
  if (step === undefined) return { kind: 'parsed', target: undefined };
  let iteration: number | undefined;
  try {
    iteration = resolveIndexOption(index, parseStepIdFromString(step)?.at);
  } catch (error) {
    // The same typed refusal `goto` renders for the same input
    // (validateGotoTarget), rather than an RD-999 from the error wrapper.
    if (error instanceof IndexOptionError) {
      return { kind: 'invalid', message: error.message, code: error.code };
    }
    throw error;
  }
  return {
    kind: 'parsed',
    target: { stepId: step, ...(iteration !== undefined ? { iteration } : {}) },
  };
}

/**
 * Drive a pass/fail transition through the core lifecycle command seam.
 *
 * The CLI keeps only Category-A work: it parses the raw `--step` / `--index`
 * strings (numeric `--index` validation and the AT-conflict check), resolves
 * the Owner Token through core, renders the seam's typed outcome, and
 * activates Run Progression. Every state-dependent decision — which run the
 * token targets (the deepest running Inline Child, #903), whether `--step`
 * names that run's current position, the machine dispatch, the conditional
 * save — lives in core.
 *
 * Malformed `--index` input (`INVALID_SYNTAX`, or `CONFLICTING_INDEX` when it
 * disagrees with the AT in `--step`) is refused before the token is resolved,
 * so nothing is read or written.
 *
 * @param output - Output emitter for CLI output
 * @param cwd - Current working directory
 * @param config - Transition configuration (command name, action-result policy)
 * @param options - Parsed `--token` / `--step` / `--index` options
 * @returns The applied transition (when one occurred) and whether the
 *   transition itself requests a non-zero exit code
 */
export async function runSeamTransition(
  output: OutputEmitter,
  cwd: string,
  config: TransitionConfig,
  options: SeamTransitionOptions,
): Promise<SeamTransitionResult> {
  const parsed = parseTransitionTarget(options.step, options.index);
  if (parsed.kind === 'invalid') {
    output.error(parsed.message, parsed.code);
    output.flush();
    return { exitError: true };
  }

  const { manager, seam } = buildLifecycleSeam(cwd);

  const resolution = await resolveCommandTarget(
    {
      seam,
      manager,
      cwd,
      output,
      ...(options.commandStreamOptions !== undefined
        ? { commandStreamOptions: options.commandStreamOptions }
        : {}),
    },
    options.token,
  );
  if (resolution.kind !== 'running') {
    const exitError = renderOwnedRunRefusal(output, config.commandName, resolution);
    output.flush();
    return { exitError };
  }

  const outcome = await seam.runTransition({
    command: config.commandName,
    run: resolution.run,
    target: parsed.target,
    computeActionResult: config.computeActionResult,
  });

  if (outcome.kind !== 'applied') {
    const exitError = renderRefusal(output, config, outcome);
    output.flush();
    return { exitError };
  }

  const rendered = await renderApplied(
    output,
    cwd,
    manager,
    resolution.run.state,
    outcome,
    options.commandStreamOptions,
    resolution.run.linkage !== null,
  );
  output.flush();
  const { exitError, ...applied } = rendered;
  return { applied, exitError };
}
