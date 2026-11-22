/**
 * CLI adapter for the core Run Progression activation (#851 / ADR 0003).
 *
 * Core decides every turn of a run's progression; this module supplies the
 * one frontend assembly of the activation's dependencies — the CLI command
 * callables behind the machine-owned command actor, the step loader and the
 * observation sink — and renders the one outcome whose diagnostic cannot
 * ride the observation stream (`failed`: the stream is the broken thing).
 *
 * @module helpers/run-progression-adapters
 */

import {
  activateRunProgression,
  CLIErrorCodes,
  ExecutionEventEmitter,
  type CommandExecutionStreamOptions,
  type RunbookState,
  type RunbookStateManager,
  type RunProgressionDirective,
  type RunProgressionOutcome,
} from '@rundown-org/core';
import { createBridgedEmitter } from './execution-emitter.js';
import { createChildRunPreparer } from './child-run-preparer.js';
import { createCliCommandServices } from '../services/execution.js';
import { createCliRunbookActorService } from './actor-service-factory.js';
import { getRunbookFromState } from './runbook-loader.js';
import type { OutputEmitter } from '../services/output-emitter.js';

/** Context for {@link driveRunProgression}. Runtime references only. */
export interface RunProgressionDriveContext {
  /** State manager bound to the project directory. */
  readonly manager: RunbookStateManager;
  /** Project directory the run's steps resolve against. */
  readonly cwd: string;
  /** The command's output emitter, for the `failed` diagnostic and a default sink. */
  readonly output: OutputEmitter;
  /** Caller-owned emitter the activation delivers observations through. */
  readonly sink?: ExecutionEventEmitter;
  /** Runtime-only routing for command subprocess stdout/stderr. */
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
}

/**
 * Build the standard CLI driver shared by every fresh activation entry.
 *
 * @param ctx - The drive context minus its sink, which the returned callable
 *   receives per activation so each run keeps its own observation emitter.
 * @returns A callable taking one `activate` directive and that run's sink, and
 *   resolving to the activation's Run Progression outcome.
 */
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
 * entry path (run start, pass/fail continuation, goto, the implicit Collect
 * before a command): CLI command callables behind the machine-owned command
 * actor, the step loader, the Inline Child preparer (#903), a bridged emitter
 * per run progression reaches, and the sink the caller supplied for the
 * activation's own run — or a fresh emitter bridged to the command's output.
 *
 * The `failed` arm's diagnostic is rendered here best-effort: it is the one
 * outcome whose message cannot ride the observation stream, and a second
 * renderer failure must not mask the caller's fail-closed exit decision.
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
  let sink = ctx.sink;
  if (sink === undefined) {
    sink = new ExecutionEventEmitter(activation.authority.runId, activation.runbook);
    sink.subscribe((event) => {
      ctx.output.executionEvent(event);
    });
  }
  // One emitter per run for the whole activation, so each Inline Child's (and
  // each parent's) events carry that run's identity and their own sequence.
  const emitters = new Map<string, ExecutionEventEmitter>([[activation.authority.runId, sink]]);
  const sinkFor = (state: RunbookState): ExecutionEventEmitter => {
    let emitter = emitters.get(state.id);
    if (emitter === undefined) {
      emitter = createBridgedEmitter(state, ctx.output);
      emitters.set(state.id, emitter);
    }
    return emitter;
  };
  const outcome = await activateRunProgression(
    activation.authority,
    {
      manager: ctx.manager,
      actorService,
      loadSteps: (state) => getRunbookFromState(state, ctx.cwd),
      sink,
      sinkFor,
      prepareChildRun: createChildRunPreparer(ctx.cwd, ctx.output),
    },
    activation.entryBoundary,
  );
  if (outcome.kind === 'failed') {
    try {
      ctx.output.error(outcome.message, CLIErrorCodes.OBSERVATION_DELIVERY_FAILED);
      // Flushed HERE, not left to the caller's end-of-command flush. `error`
      // only accumulates into the JSON renderer while a command's terminal
      // object is written straight through, so an envelope left in the
      // accumulator lands AFTER the action object every caller defers to keep
      // last (docs/spec/cli-output.md).
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
