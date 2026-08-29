/**
 * CLI adapters for the core Run Progression activation (#851 / ADR 0003).
 *
 * The activation decides WHEN to launch an inline child and WHEN to propagate
 * a driven terminal; these builders supply the Category-A/C callables that
 * perform those effects with the CLI's existing machinery. The launch span
 * returns the core-typed dispatch result itself, so no CLI coordination
 * status crosses the public seam. The propagation builder reports an inline
 * parent's stable `waiting` or `stopped` condition explicitly, and preserves a
 * refusing condition's code and boundary-derived recovery on the core
 * `refused` arm.
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
  flowBackInlineTerminal,
  ObservationDeliveryError,
  SessionService,
  type CommandExecutionStreamOptions,
  type InlineChildDispatch,
  type RunbookActorService,
  type RunbookStateManager,
  type RunProgressionAuthority,
  type RunProgressionDirective,
  type RunProgressionOutcome,
  type TerminalPropagation,
} from '@rundown-org/core';
import { createCliCommandServices, launchInlineChildFromIntent } from '../services/execution.js';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';
import type { OutputEmitter } from '../services/output-emitter.js';
// Static on purpose: collect.ts already loads this module statically on the
// same command path, and delegation-completion's documented cycle with
// execution.ts is broken by its own lazy imports — laziness here would buy
// nothing and cost an async module-registry hop per propagation.
import { propagateDrivenRunTerminal } from './delegation-completion.js';

/** Context captured by {@link buildInlineChildDispatch}. Runtime references only. */
export interface InlineChildDispatchContext {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  readonly cwd: string;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /** The composing run's verified delegation capabilities, named with its run. */
  readonly parentAuthority: RunProgressionAuthority;
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly progressionSinks?: Map<string, ExecutionEventEmitter>;
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
  return async ({ intent, prompted, steps, sink }) =>
    launchInlineChildFromIntent({
      manager: ctx.manager,
      actorService: ctx.actorService,
      sessionService: ctx.sessionService,
      emitter: sink,
      cwd: ctx.cwd,
      steps,
      intent,
      prompted,
      output: gatedOutput,
      driveProgression: (directive, progressionSink) =>
        driveRunProgression(directive, {
          manager: ctx.manager,
          cwd: ctx.cwd,
          output: gatedOutput,
          sink: progressionSink,
          sessionService: ctx.sessionService,
          ancestorAuthorities: [ctx.parentAuthority, ...(ctx.ancestorAuthorities ?? [])],
          ...(ctx.progressionSinks === undefined ? {} : { progressionSinks: ctx.progressionSinks }),
          ...(ctx.commandStreamOptions !== undefined
            ? { commandStreamOptions: ctx.commandStreamOptions }
            : {}),
        }),
      ...(ctx.commandStreamOptions !== undefined
        ? { commandStreamOptions: ctx.commandStreamOptions }
        : {}),
      ...(ctx.parentAuthority.delegationRuntime !== undefined
        ? {
            parentDelegationRuntime: {
              runId: ctx.parentAuthority.runId,
              runtime: ctx.parentAuthority.delegationRuntime,
            },
          }
        : {}),
    });
}

/** Context captured by {@link buildTerminalPropagation}. Runtime references only. */
export interface TerminalPropagationContext {
  readonly manager: RunbookStateManager;
  readonly authority: Extract<RunProgressionDirective, { kind: 'activate' }>['authority'];
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  readonly progressionSinks?: Map<string, ExecutionEventEmitter>;
  readonly cwd: string;
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/** Context for {@link driveRunProgression}. Runtime references only. */
export interface RunProgressionDriveContext {
  /** State manager bound to the project directory. */
  readonly manager: RunbookStateManager;
  /** Project directory the run's steps resolve against. */
  readonly cwd: string;
  /** The command's output emitter, for the composition callables' rendering. */
  readonly output: OutputEmitter;
  /** Caller-owned emitter the activation delivers observations through. */
  readonly sink?: ExecutionEventEmitter;
  /** Session service; constructed over `manager` when the caller has none. */
  readonly sessionService?: SessionService;
  /** Core-branded delegation authority retained by the exact composing parent. */
  readonly ancestorAuthorities?: readonly RunProgressionAuthority[];
  /** One observation emitter per run for the entire recursive composition. */
  readonly progressionSinks?: Map<string, ExecutionEventEmitter>;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/** Build the standard CLI driver shared by every fresh activation entry. */
export function createCliRunProgressionDriver(
  ctx: Omit<RunProgressionDriveContext, 'sink'>,
): (
  directive: Extract<RunProgressionDirective, { kind: 'activate' }>,
  sink: ExecutionEventEmitter,
) => Promise<RunProgressionOutcome> {
  return (directive, sink) => driveRunProgression(directive, { ...ctx, sink });
}

/**
 * Activate core Run Progression for one run with the CLI's standard wiring.
 *
 * The ONE frontend assembly of the activation's dependencies, shared by every
 * migrated entry path (collect follow-on, pass/fail continuation): CLI command
 * callables behind the machine-owned command actor, the inline-dispatch and
 * terminal-propagation adapters, and the composition capabilities derived from
 * the SAME authority value core minted — so the callable wiring cannot
 * disagree with the authority about run, claim, or delegation capabilities.
 *
 * The `failed` arm's diagnostic is rendered here best-effort: it is the one
 * outcome whose message cannot ride the observation stream (the stream is the
 * broken thing), and a second renderer failure must not mask the caller's
 * fail-closed exit decision.
 *
 * @param activation - Core-minted activation directive and run-bound authority.
 * @param ctx - Runtime references for the activation's dependencies.
 * @returns The activation's closed outcome.
 */
export async function driveRunProgression(
  activation: Extract<RunProgressionDirective, { kind: 'activate' }>,
  ctx: RunProgressionDriveContext,
): Promise<RunProgressionOutcome> {
  const commandServices = createCliCommandServices(ctx.commandStreamOptions);
  const actorService = createCliRunbookActorService(ctx.manager, commandServices);
  const sessionService = ctx.sessionService ?? new SessionService(ctx.manager);
  const ancestorAuthorities = ctx.ancestorAuthorities ?? [];
  const progressionSinks = ctx.progressionSinks ?? new Map<string, ExecutionEventEmitter>();
  const existingSink = progressionSinks.get(activation.authority.runId);
  const sink =
    existingSink ??
    ctx.sink ??
    new ExecutionEventEmitter(activation.authority.runId, activation.runbook);
  progressionSinks.set(activation.authority.runId, sink);
  if (existingSink === undefined && ctx.sink === undefined) {
    sink.subscribe((event) => {
      ctx.output.executionEvent(event);
    });
  }
  const outcome = await activateRunProgression(
    activation.authority,
    {
      manager: ctx.manager,
      actorService,
      sessionService,
      actorMutationRunner: createEffectfulActorMutationRunner(ctx.cwd),
      loadSteps: (state) => getRunbookFromState(state, ctx.cwd),
      sink,
      dispatchInlineChild: buildInlineChildDispatch({
        manager: ctx.manager,
        actorService,
        sessionService,
        cwd: ctx.cwd,
        output: ctx.output,
        ...(ctx.commandStreamOptions !== undefined
          ? { commandStreamOptions: ctx.commandStreamOptions }
          : {}),
        // This activation IS the composing parent's progression, so the
        // authority's verified capabilities are exactly what a child's terminal
        // flow-back needs — named with the authority's own run so nothing
        // further up the inline chain can be advanced under it.
        parentAuthority: activation.authority,
        ...(ancestorAuthorities.length === 0 ? {} : { ancestorAuthorities }),
        progressionSinks,
      }),
      propagateTerminal: buildTerminalPropagation({
        manager: ctx.manager,
        authority: activation.authority,
        cwd: ctx.cwd,
        output: ctx.output,
        ...(ctx.commandStreamOptions !== undefined
          ? { commandStreamOptions: ctx.commandStreamOptions }
          : {}),
        ...(ancestorAuthorities.length === 0 ? {} : { ancestorAuthorities }),
        progressionSinks,
      }),
    },
    activation.entryBoundary,
  );
  if (outcome.kind === 'failed') {
    try {
      ctx.output.error(outcome.message, CLIErrorCodes.OBSERVATION_DELIVERY_FAILED);
      // Flushed HERE, not left to the caller's end-of-command flush. `error`
      // only accumulates into the JSON renderer while a command's terminal
      // object is written straight through, so an envelope left in the accumulator lands
      // AFTER the action object every caller defers to keep last
      // (docs/spec/cli-output.md). Flushing an empty accumulator is a no-op, so
      // this costs nothing on the arms that never accumulate.
      ctx.output.flush();
    } catch {
      // The reporting channel is broken; the caller's exit code carries the
      // failure.
    }
  }
  return outcome;
}

/**
 * Whether a closed progression outcome fails the invoking command closed.
 *
 * `refused` and `failed` applied no terminal but did not finish the caller's
 * work; `stopped` reports an actual stopped lifecycle. All three exit
 * non-zero; `waiting` and `completed` exit clean.
 *
 * @param outcome - The activation's closed outcome.
 * @returns True when the command should exit non-zero.
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
 * every terminal outcome. An inline advance returns the composing parent's
 * identity and stable `waiting` or `stopped` condition; only a genuine refusal
 * enters the core `refused` arm, carrying its registered code and
 * boundary-derived recovery so the closed outcome cannot re-label it (#853
 * review F3). Rendering goes through the gated output, so a broken reporting
 * channel surfaces as the typed delivery failure rather than an untyped escape.
 *
 * @param ctx - Runtime references the propagation needs, captured by closure.
 * @returns The propagation callable the core activation invokes.
 */
export function buildTerminalPropagation(ctx: TerminalPropagationContext): TerminalPropagation {
  const gatedOutput = gateProgressionOutput(ctx.output);
  // Built ONCE per builder, alongside `gatedOutput`, not per propagation. Both
  // are runtime references the closure captures rather than work the turn owes:
  // `createCliRunbookActorService` resolves the plugin root, the bundled-runbook
  // path, the helper registry and the policy evaluator on every call, and the
  // propagation callable is invoked on every terminal the activation reaches.
  // The command services are the same ones the driver passes (line ~205);
  // recording a completion does not reach a command turn today, but an actor
  // service that silently drops subprocess stream routing is a trap for the
  // first turn that does.
  const flowBackActorService = createCliRunbookActorService(
    ctx.manager,
    createCliCommandServices(ctx.commandStreamOptions),
  );
  return async ({ runId, source, sink }) => {
    const inlineFlowBack = await flowBackInlineTerminal({
      authority: ctx.authority,
      manager: ctx.manager,
      actorService: flowBackActorService,
      loadSteps: (state) => getRunbookFromState(state, ctx.cwd),
      source,
      sink,
      ...(ctx.ancestorAuthorities === undefined
        ? {}
        : { ancestorAuthorities: ctx.ancestorAuthorities }),
      activateParent: (directive) =>
        driveRunProgression(directive, {
          manager: ctx.manager,
          cwd: ctx.cwd,
          output: gatedOutput,
          ...(ctx.ancestorAuthorities === undefined
            ? {}
            : { ancestorAuthorities: ctx.ancestorAuthorities }),
          ...(ctx.progressionSinks === undefined ? {} : { progressionSinks: ctx.progressionSinks }),
          ...(ctx.commandStreamOptions === undefined
            ? {}
            : { commandStreamOptions: ctx.commandStreamOptions }),
        }),
    });
    if (inlineFlowBack !== null) return inlineFlowBack;
    const propagation = await propagateDrivenRunTerminal(
      ctx.manager,
      runId,
      ctx.cwd,
      gatedOutput,
      source,
      ctx.commandStreamOptions,
    );
    if (propagation.kind !== 'inline-advanced') return { kind: 'propagated' };
    if (propagation.result === 'handled') {
      return { kind: 'advanced', runId: propagation.parentRunId, status: 'waiting' as const };
    }
    if (propagation.result === 'stopped') {
      return { kind: 'advanced', runId: propagation.parentRunId, status: 'stopped' as const };
    }
    if (propagation.refusal !== undefined) {
      return {
        kind: 'refused',
        runId: propagation.refusal.runId,
        code: propagation.refusal.code,
        message: propagation.refusal.message,
        recovery: propagation.refusal.recovery,
      };
    }
    if (propagation.result === 'blocked') {
      // Fail-closed without a typed refusal: a re-entrant flow-back concluded
      // blocked after its own diagnostics streamed. No retry of this
      // propagation can change that conclusion.
      return {
        kind: 'refused',
        runId: propagation.parentRunId,
        message:
          'Advancing the composing inline parent concluded fail-closed; see the preceding diagnostics for the refusing run',
        recovery: 'permanent',
      };
    }
    return { kind: 'propagated' };
  };
}
