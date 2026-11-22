// packages/cli/src/helpers/terminal-command.ts
//
// Shared front end for the terminal (`complete` / `stop`) commands. Routes both
// through the core `RunbookLifecycleCommandService.runTerminal` seam and renders
// its typed outcome. The seam owns the FORCE dispatch and the conditional save;
// this module keeps only Category-A work: resolve the Owner Token through
// core, stream observation events, and set the exit code.

import {
  CONCURRENT_MODIFICATION_CODE,
  type LifecycleTerminalOutcome,
  type OwnerToken,
  type RunbookEventInput,
  type RunbookEventV1,
  type RunbookRef,
  type RunbookStateManager,
  type RunId,
  type TerminalCommandName,
} from '@rundown-org/core';
import { buildLifecycleSeam } from './lifecycle-seam-factory.js';
import { resolveCommandTarget } from './command-target.js';
import { driveRunProgression, progressionFailedClosed } from './run-progression-adapters.js';
import { buildMetadata } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import {
  renderExecutionLeaseRefusal,
  renderOwnedRunRefusal,
  renderRunFinished,
} from './token-option.js';

/**
 * Command-local bridge that streams force-terminal observation events.
 *
 * Preserves one monotonic `seq` across the command while stamping each event
 * with the runbook id and runbook ref of the state that produced it. Exactly
 * one bridge must be created per terminal command — creating one per state
 * would restart `seq`.
 */
export class ForceTerminalEventBridge {
  private seq = 0;

  /**
   * Construct a bridge bound to a single output emitter.
   *
   * @param output - Output emitter that renders each streamed execution event.
   */
  constructor(private readonly output: OutputEmitter) {}

  /**
   * Stamp and stream a single observation event.
   *
   * @param attribution - Id and runbook ref of the run that produced the event.
   * @param attribution.id - Run id of the producing run (stamped as `runbookId`).
   * @param attribution.runbook - Runbook ref of the producing run.
   * @param event - Pre-correlated `{ type, payload }` observation event.
   */
  emit(
    attribution: { readonly id: RunId; readonly runbook: RunbookRef },
    event: RunbookEventInput,
  ): void {
    this.seq += 1;
    const envelope: RunbookEventV1 = {
      v: '1',
      ts: new Date().toISOString(),
      seq: this.seq,
      runbookId: attribution.id,
      runbook: attribution.runbook,
      ...event,
    };
    this.output.executionEvent(envelope);
  }
}

/** CLI options forwarded to a terminal seam command. */
export interface SeamTerminalOptions {
  /** The Owner Token naming the run (`--token`), already parsed. */
  readonly token: OwnerToken;
  /** Optional terminal message forwarded to the machine. */
  readonly message?: string;
}

/**
 * Render a terminal seam outcome to the CLI envelopes and report whether the
 * outcome requests a non-zero exit code.
 *
 * Switches exhaustively over {@link LifecycleTerminalOutcome}. The applied
 * variant loads the run for metadata, streams the seam's observation events
 * through a single {@link ForceTerminalEventBridge}, then renders the
 * complete/stopped envelope. A bare `rd stop` is the operator aborting their
 * own run — a failure terminal that exits non-zero (No silent mapping).
 *
 * @param output - Output emitter for CLI output.
 * @param command - The terminal command being rendered (`complete` / `stop`).
 * @param manager - State manager used to reload the run for rendering.
 * @param outcome - Typed terminal outcome returned by the seam.
 * @param message - Optional operator-supplied terminal message for the applied
 *   complete/stopped summary; falls back to the default summary when absent.
 * @param inlineChild - Whether the command's target is an Inline Child (#903).
 *   Its terminal streams under the child's run id and its action object names
 *   the child, but a stopped child does not by itself request a non-zero exit:
 *   the parent Collects it and progression decides where the run rests.
 * @returns `true` when the outcome requests a non-zero exit code.
 */
export async function renderTerminalOutcome(
  output: OutputEmitter,
  command: TerminalCommandName,
  manager: RunbookStateManager,
  outcome: LifecycleTerminalOutcome,
  message?: string,
  inlineChild = false,
): Promise<boolean> {
  switch (outcome.kind) {
    case 'run_finished':
      renderRunFinished(output, command, outcome.runId, outcome.lifecycle);
      return true;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      return true;
    case 'execution_in_progress':
    case 'execution_interrupted':
      return renderExecutionLeaseRefusal(output, outcome);
    case 'unknown_token':
      // Pruned between token resolution and the save; see renderRefusal.
      return renderOwnedRunRefusal(output, command, outcome);
    case 'applied': {
      const state = await manager.load(outcome.runId);
      if (state) output.metadata(buildMetadata(state));
      if (outcome.events.length > 0 && state) {
        const bridge = new ForceTerminalEventBridge(output);
        for (const event of outcome.events) {
          bridge.emit({ id: state.id, runbook: state.runbook }, event);
        }
      }
      // The action object names the run the command acted on, an Inline Child
      // included, and stays the last JSON line: the renderer accumulates it
      // and the caller flushes after any progression it drives.
      if (outcome.lifecycle === 'stopped') {
        output.stopped(message ?? 'Runbook stopped');
        // An Inline Child's stop is Collected by its parent as FAIL; the
        // command exits by where that progression rests, not by this terminal.
        return !inlineChild;
      }
      output.complete(message ?? 'Runbook completed successfully');
      return false;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Drive a complete/stop terminal command through the core lifecycle seam.
 *
 * Resolves the Owner Token through core to its target (the deepest running
 * Inline Child, #903), calls `runTerminal` on it, and renders the outcome.
 * When the target is an Inline Child, core's directive activates progression
 * so its parent Collects the result and continues.
 *
 * @param output - Output emitter for CLI output.
 * @param cwd - Current working directory.
 * @param command - The terminal command to run (`complete` / `stop`).
 * @param options - Parsed `--token` and optional message.
 * @returns The bound state manager and whether the command requests a non-zero exit.
 */
export async function runSeamTerminal(
  output: OutputEmitter,
  cwd: string,
  command: TerminalCommandName,
  options: SeamTerminalOptions,
): Promise<{ readonly manager: RunbookStateManager; readonly exitError: boolean }> {
  const { manager, seam } = buildLifecycleSeam(cwd);

  const resolution = await resolveCommandTarget(
    { seam, manager, cwd, output },
    options.token,
    command,
  );
  if (resolution.kind !== 'running') {
    const exitError = renderOwnedRunRefusal(output, command, resolution);
    output.flush();
    return { manager, exitError };
  }

  const outcome = await seam.runTerminal({
    command,
    run: resolution.run,
    ...(options.message !== undefined ? { message: options.message } : {}),
    computeActionResult:
      command === 'complete'
        ? (actionType) => actionType !== 'RETRY' && actionType !== 'STOP'
        : () => false,
  });

  const inlineChild = resolution.run.linkage !== null;
  const exitError = await renderTerminalOutcome(
    output,
    command,
    manager,
    outcome,
    options.message,
    inlineChild,
  );
  // A forced terminal on an Inline Child owes its parent the implicit Collect
  // (#903): core's directive activates progression, which ascends, and the
  // command exits by where progression rests.
  if (outcome.kind === 'applied' && outcome.progression.kind === 'activate') {
    const progression = await driveRunProgression(outcome.progression, { manager, cwd, output });
    output.flush();
    return { manager, exitError: exitError || progressionFailedClosed(progression) };
  }
  output.flush();
  return { manager, exitError };
}
