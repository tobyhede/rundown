/**
 * CLI adapters for the core Run Progression activation (#851 / ADR 0003).
 *
 * The activation decides WHEN to launch an inline child and WHEN to propagate
 * a driven terminal; these builders supply the Category-A/C callables that
 * perform those effects with the CLI's existing machinery. The launch span
 * returns the core-typed dispatch result itself, so no CLI coordination
 * status crosses the public seam; the propagation builder folds only the
 * inline failure-exit rule into the core `refused` arm.
 *
 * @module helpers/run-progression-adapters
 */

import type {
  CommandExecutionStreamOptions,
  ExecutionEventEmitter,
  InlineChildDispatch,
  RunbookActorService,
  RunbookStateManager,
  ResolvedStep,
  SessionService,
  TerminalPropagation,
} from '@rundown-org/core';
import { launchInlineChildFromIntent } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
// Static on purpose: collect.ts already loads this module statically on the
// same command path, and delegation-completion's documented cycle with
// execution.ts is broken by its own lazy imports — laziness here would buy
// nothing and cost an async module-registry hop per propagation.
import {
  inlineAdvanceRequiresFailureExit,
  propagateDrivenRunTerminal,
  type RunScopedDelegationRuntime,
} from './delegation-completion.js';

/** Context captured by {@link buildInlineChildDispatch}. Runtime references only. */
export interface InlineChildDispatchContext {
  readonly manager: RunbookStateManager;
  readonly actorService: RunbookActorService;
  readonly sessionService: SessionService;
  readonly emitter: ExecutionEventEmitter;
  readonly cwd: string;
  readonly steps: readonly ResolvedStep[];
  readonly output: OutputEmitter;
  readonly commandStreamOptions?: CommandExecutionStreamOptions;
  /** The composing run's verified delegation capabilities, named with its run. */
  readonly parentDelegationRuntime?: RunScopedDelegationRuntime;
}

/**
 * Build the inline child dispatch callable over the CLI launch span.
 *
 * A thin closure: the span itself now returns the core-typed
 * `InlineChildDispatchResult`, classifying each refusal with its registered
 * code and a boundary-derived recovery at the site that diagnosed it, so
 * nothing is folded (or lost) here.
 *
 * @param ctx - Runtime references the span needs, captured by closure.
 * @returns The dispatch callable the core activation invokes.
 */
export function buildInlineChildDispatch(ctx: InlineChildDispatchContext): InlineChildDispatch {
  return async ({ intent, prompted }) =>
    launchInlineChildFromIntent({
      manager: ctx.manager,
      actorService: ctx.actorService,
      sessionService: ctx.sessionService,
      emitter: ctx.emitter,
      cwd: ctx.cwd,
      steps: ctx.steps,
      intent,
      prompted,
      output: ctx.output,
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

/**
 * Build the driven-terminal propagation callable over the CLI's single
 * post-drive trigger.
 *
 * `propagateDrivenRunTerminal` reloads the driven run and internally skips a
 * missing, non-terminal, or unlinked one, so the activation may invoke this on
 * every terminal outcome. The inline-only failure-exit rule this command
 * family uses is folded here into the core `refused` arm.
 *
 * @param ctx - Runtime references the propagation needs, captured by closure.
 * @returns The propagation callable the core activation invokes.
 */
export function buildTerminalPropagation(ctx: TerminalPropagationContext): TerminalPropagation {
  return async ({ runId }) => {
    const propagation = await propagateDrivenRunTerminal(
      ctx.manager,
      runId,
      ctx.cwd,
      ctx.output,
      { kind: 'loop-inferred' },
      ctx.commandStreamOptions,
    );
    if (inlineAdvanceRequiresFailureExit(propagation)) {
      return {
        kind: 'refused',
        message:
          'Advancing the composing inline parent concluded fail-closed; see the preceding diagnostics for the refusing run',
      };
    }
    return { kind: 'propagated' };
  };
}
