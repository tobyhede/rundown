/**
 * CLI adapters for the core Run Progression activation (#851 / ADR 0003).
 *
 * The activation decides WHEN to launch an inline child and WHEN to propagate
 * a driven terminal; these builders supply the Category-A/C callables that
 * perform those effects with the CLI's existing machinery. The launch span
 * returns the core-typed dispatch result itself, so no CLI coordination
 * status crosses the public seam; the propagation builder folds only the
 * inline failure-exit rule into the core `refused` arm, preserving the
 * refusing condition's code and boundary-derived recovery.
 *
 * The observation commit gate (#853) holds across these turns too: every
 * parent-stream emission goes through the GATED sink core supplies at
 * invocation, and the `OutputEmitter` the inner machinery renders through is
 * wrapped so a broken reporting channel surfaces as core's typed
 * {@link ObservationDeliveryError} — the activation boundary converts it into
 * the closed `failed` outcome instead of letting it escape untyped.
 *
 * @module helpers/run-progression-adapters
 */

import {
  activateRunProgression,
  CLIErrorCodes,
  createEffectfulActorMutationRunner,
  ExecutionEventEmitter,
  ObservationDeliveryError,
  SessionService,
  type CommandExecutionStreamOptions,
  type InlineChildDispatch,
  type RunbookActorService,
  type RunbookStateManager,
  type ResolvedStep,
  type RunProgressionDirective,
  type RunProgressionOutcome,
  type TerminalPropagation,
} from '@rundown-org/core';
import { createCliCommandServices, launchInlineChildFromIntent } from '../services/execution.js';
import { createCliRunbookActorService } from './actor-service-factory.js';
import type { OutputEmitter } from '../services/output-emitter.js';
// Static on purpose: collect.ts already loads this module statically on the
// same command path, and delegation-completion's documented cycle with
// execution.ts is broken by its own lazy imports — laziness here would buy
// nothing and cost an async module-registry hop per propagation.
import {
  propagateDrivenRunTerminal,
  type RunScopedDelegationRuntime,
} from './delegation-completion.js';

/** Context captured by {@link buildInlineChildDispatch}. Runtime references only. */
export interface InlineChildDispatchContext {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  readonly cwd: string;
  readonly steps: readonly ResolvedStep[];
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /** The composing run's verified delegation capabilities, named with its run. */
  readonly parentDelegationRuntime?: RunScopedDelegationRuntime;
}

/**
 * Wrap an {@link OutputEmitter} so a throw from any of its methods surfaces as
 * core's typed {@link ObservationDeliveryError}.
 *
 * The launch span and the propagation walk render through the OutputEmitter —
 * child-run streaming, warnings, refusal envelopes — and a broken renderer
 * there is the same broken reporting channel the activation's own gated sink
 * guards (#853 review F1). The proxy binds every method to the real instance
 * (so private state stays reachable) and converts the throw at the boundary;
 * an {@link ObservationDeliveryError} already thrown beneath (the gated sink's
 * own conversion) passes through unwrapped.
 *
 * @param output - The command's real output emitter.
 * @returns A delegating proxy with the delivery-failure conversion applied.
 */
function gateProgressionOutput(output: OutputEmitter): OutputEmitter {
  return new Proxy(output, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        try {
          return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        } catch (cause) {
          if (cause instanceof ObservationDeliveryError) throw cause;
          throw new ObservationDeliveryError(cause);
        }
      };
    },
  });
}

/**
 * Build the inline child dispatch callable over the CLI launch span.
 *
 * A thin closure: the span itself now returns the core-typed
 * `InlineChildDispatchResult`, classifying each refusal with its registered
 * code and a boundary-derived recovery at the site that diagnosed it, so
 * nothing is folded (or lost) here. Parent-stream diagnostics go through the
 * GATED sink core supplies at invocation — never a raw emitter captured by
 * closure — and the deeper rendering channel is gated by
 * {@link gateProgressionOutput}.
 *
 * @param ctx - Runtime references the span needs, captured by closure.
 * @returns The dispatch callable the core activation invokes.
 */
export function buildInlineChildDispatch(ctx: InlineChildDispatchContext): InlineChildDispatch {
  const gatedOutput = gateProgressionOutput(ctx.output);
  return async ({ intent, prompted, sink }) =>
    launchInlineChildFromIntent({
      manager: ctx.manager,
      actorService: ctx.actorService,
      sessionService: ctx.sessionService,
      emitter: sink,
      cwd: ctx.cwd,
      steps: ctx.steps,
      intent,
      prompted,
      output: gatedOutput,
      ...(ctx.commandStreamOptions !== undefined
        ? { commandStreamOptions: ctx.commandStreamOptions }
        : {}),
      ...(ctx.parentDelegationRuntime !== undefined
        ? { parentDelegationRuntime: ctx.parentDelegationRuntime }
        : {}),
    });
}

/** Context captured by {@link buildTerminalPropagation}. Runtime references only. */
export interface TerminalPropagationContext {
  readonly manager: RunbookStateManager;
  readonly cwd: string;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/** Runtime-only dependencies shared by every directive-driven continuation. */
export interface RunProgressionDriveContext {
  readonly manager: RunbookStateManager;
  readonly cwd: string;
  readonly output: OutputEmitter;
  readonly sink?: ExecutionEventEmitter;
  readonly sessionService?: SessionService;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/**
 * Activate one core-minted directive without reconstructing its authority.
 *
 * @param activation - Core-minted activation, including its exact graph and authority.
 * @param ctx - Runtime-only CLI dependencies used to drive the activation.
 * @returns The closed outcome selected by Run Progression.
 */
export async function driveRunProgression(
  activation: Extract<RunProgressionDirective, { kind: 'activate' }>,
  ctx: RunProgressionDriveContext,
): Promise<RunProgressionOutcome> {
  const commandServices = createCliCommandServices(ctx.commandStreamOptions);
  const actorService = createCliRunbookActorService(ctx.manager, commandServices);
  const sessionService = ctx.sessionService ?? new SessionService(ctx.manager);
  const sink =
    ctx.sink ?? new ExecutionEventEmitter(activation.authority.runId, activation.runbook);
  if (ctx.sink === undefined) {
    sink.subscribe((event) => {
      ctx.output.executionEvent(event);
    });
  }
  const outcome = await activateRunProgression(activation.authority, {
    manager: ctx.manager,
    actorService,
    sessionService,
    actorMutationRunner: createEffectfulActorMutationRunner(ctx.cwd),
    steps: activation.steps,
    sink,
    dispatchInlineChild: buildInlineChildDispatch({
      manager: ctx.manager,
      actorService,
      sessionService,
      cwd: ctx.cwd,
      steps: activation.steps,
      output: ctx.output,
      ...(ctx.commandStreamOptions === undefined
        ? {}
        : { commandStreamOptions: ctx.commandStreamOptions }),
      ...(activation.authority.delegationRuntime === undefined
        ? {}
        : {
            parentDelegationRuntime: {
              runId: activation.authority.runId,
              runtime: activation.authority.delegationRuntime,
            },
          }),
    }),
    propagateTerminal: buildTerminalPropagation({
      manager: ctx.manager,
      cwd: ctx.cwd,
      output: ctx.output,
      ...(ctx.commandStreamOptions === undefined
        ? {}
        : { commandStreamOptions: ctx.commandStreamOptions }),
    }),
  });
  if (outcome.kind === 'failed') {
    try {
      ctx.output.error(outcome.message, CLIErrorCodes.OBSERVATION_DELIVERY_FAILED);
    } catch {
      // The reporting channel is broken; the caller's fail-closed result remains authoritative.
    }
  }
  return outcome;
}

/**
 * Whether a closed progression outcome fails the invoking command closed.
 *
 * @param outcome - Closed result returned by Run Progression.
 * @returns True when the invoking CLI command must use a failure exit code.
 */
export function progressionFailedClosed(outcome: RunProgressionOutcome): boolean {
  return outcome.kind === 'refused' || outcome.kind === 'failed' || outcome.kind === 'stopped';
}

/**
 * Build the driven-terminal propagation callable over the CLI's single
 * post-drive trigger.
 *
 * `propagateDrivenRunTerminal` reloads the driven run and internally skips a
 * missing, non-terminal, or unlinked one, so the activation may invoke this on
 * every terminal outcome. The inline-only failure-exit rule this command
 * family uses is folded here into the core `refused` arm — carrying the
 * refusing condition's registered code and boundary-derived recovery when a
 * typed refusal is what failed closed, so the closed outcome cannot re-label
 * it (#853 review F3). Rendering goes through the gated output, so a broken
 * reporting channel surfaces as the typed delivery failure rather than an
 * untyped escape.
 *
 * @param ctx - Runtime references the propagation needs, captured by closure.
 * @returns The propagation callable the core activation invokes.
 */
export function buildTerminalPropagation(ctx: TerminalPropagationContext): TerminalPropagation {
  const gatedOutput = gateProgressionOutput(ctx.output);
  return async ({ runId }) => {
    const propagation = await propagateDrivenRunTerminal(
      ctx.manager,
      runId,
      ctx.cwd,
      gatedOutput,
      { kind: 'loop-inferred' },
      ctx.commandStreamOptions,
    );
    if (propagation.kind !== 'inline-advanced') return { kind: 'propagated' };
    if (propagation.refusal !== undefined) {
      return {
        kind: 'refused',
        code: propagation.refusal.code,
        message: propagation.refusal.message,
        recovery: propagation.refusal.recovery,
      };
    }
    if (propagation.result === 'stopped' || propagation.result === 'blocked') {
      // Fail-closed without a typed refusal: the parent advance reached a STOP
      // terminal or a re-entrant flow-back concluded fail-closed. Diagnostics
      // already streamed; no retry of this propagation can change it.
      return {
        kind: 'refused',
        message:
          'Advancing the composing inline parent concluded fail-closed; see the preceding diagnostics for the refusing run',
        recovery: 'permanent',
      };
    }
    return { kind: 'propagated' };
  };
}
