/**
 * `rundown stop --run <id>`: the human escape hatch for a lost top-level
 * Owner Token (#906, ADR 0005).
 *
 * The only mutation a run id may drive, and only for a human: the command is
 * refused unless a person at an interactive terminal is there to confirm it,
 * and the stop records who confirmed it, when, and their message on the run.
 * Everything this module does is Category A — detecting the terminal, asking,
 * reading the login name and host. Core decides what the id may stop
 * (`resolveHumanStopTarget`) and stops the run with the running Inline
 * Children it composes, in one write (`stopByHuman`).
 *
 * @module helpers/escape-hatch
 */

import {
  CONCURRENT_MODIFICATION_CODE,
  resolveHumanStopTarget,
  stopByHuman,
  type HumanStopAudit,
  type RunId,
} from '@rundown-org/core';
import { humanAtTerminal, type HumanConfirmation } from '../services/human-confirmation.js';
import { buildMetadata } from '../services/execution.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { buildLifecycleDeps } from './lifecycle-seam-factory.js';
import { ForceTerminalEventBridge } from './terminal-command.js';
import { renderExecutionLeaseRefusal, renderRunFinished } from './token-option.js';

/** Code of the refusal of the escape hatch with no human at a terminal. */
export const INTERACTIVE_REQUIRED_CODE = 'INTERACTIVE_REQUIRED';
/** Code of the refusal of the escape hatch the human declined. */
export const NOT_CONFIRMED_CODE = 'NOT_CONFIRMED';

/** Message of the {@link INTERACTIVE_REQUIRED_CODE} refusal. */
export const INTERACTIVE_REQUIRED_MESSAGE =
  'rundown stop --run is the human escape hatch for a lost owner token: it asks for confirmation at an interactive terminal and records who stopped the run. There is no terminal here, so nothing was stopped. An agent must not use it: stop the run with --token <owner_token>, or ask the user to run `rundown stop --run <id>` themselves.';

/** Input to {@link runEscapeHatchStop}. */
export interface EscapeHatchStopInput {
  /** The run the human named. */
  readonly runId: RunId;
  /** The stop message, recorded as the human's reason. */
  readonly message?: string;
  /** The human at the terminal. */
  readonly human: HumanConfirmation;
}

/**
 * Refuse, ask, and — on an explicit yes — stop the named run, and the running
 * Inline Children it composes, with its audit.
 *
 * Core resolves the target first — refusing an unknown, finished or child run,
 * and an attempt In Progress anywhere in the run's inline chain — so the human
 * is only asked about a stop that can apply. The stop's conditional write
 * remains the final authority: a run that moves while the human decides is
 * refused, never retried.
 *
 * @param output - Output emitter for CLI output.
 * @param cwd - Current working directory.
 * @param input - The run id, message and human.
 * @returns Whether the command requests a non-zero exit: every refusal does,
 *   and so does the applied stop, as `stop --token` does.
 */
export async function runEscapeHatchStop(
  output: OutputEmitter,
  cwd: string,
  input: EscapeHatchStopInput,
): Promise<boolean> {
  if (!input.human.interactive) {
    output.error(INTERACTIVE_REQUIRED_MESSAGE, INTERACTIVE_REQUIRED_CODE, { runId: input.runId });
    output.flush();
    return true;
  }
  const deps = buildLifecycleDeps(cwd);
  // Core refuses what the hatch may not stop before anyone is asked.
  const target = await resolveHumanStopTarget(deps, input.runId);
  switch (target.kind) {
    case 'target':
      break;
    case 'run_finished':
      renderRunFinished(output, 'stop', target.runId, target.lifecycle);
      output.flush();
      return true;
    case 'execution_in_progress':
    case 'execution_interrupted':
      renderExecutionLeaseRefusal(output, target);
      output.flush();
      return true;
    case 'unknown_run':
    case 'not_top_level':
      output.error(target.message, target.code, { runId: target.runId });
      output.flush();
      return true;
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
  const { state } = target.run;
  const { user, host } = humanAtTerminal();
  const children =
    target.inline.length === 0
      ? ''
      : `, and the ${String(target.inline.length)} inline child run(s) it is running (${target.inline.map((run) => run.state.id).join(', ')}),`;
  const confirmed = await input.human.confirm(
    `Stop run ${state.id} (${state.runbook.path}, at step ${state.step})${children} without its owner token? This is recorded on the run as stopped by ${user} on ${host}.`,
  );
  if (!confirmed) {
    output.error(
      `Stop of run ${state.id} was not confirmed; nothing was stopped.`,
      NOT_CONFIRMED_CODE,
      { runId: state.id },
    );
    output.flush();
    return true;
  }
  const audit: HumanStopAudit = {
    at: new Date().toISOString(),
    user,
    host,
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
  const outcome = await stopByHuman(deps, target, audit);
  switch (outcome.kind) {
    case 'unknown_run':
      output.error(outcome.message, outcome.code, { runId: outcome.runId });
      output.flush();
      return true;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      output.flush();
      return true;
    case 'applied': {
      const root = await deps.manager.load(outcome.root.runId);
      if (root) output.metadata(buildMetadata(root));
      const bridge = new ForceTerminalEventBridge(output);
      for (const run of [outcome.root, ...outcome.inline]) {
        for (const event of run.events) {
          bridge.emit({ id: run.runId, runbook: run.runbook }, event);
        }
      }
      output.stopped(
        input.message ?? 'Runbook stopped',
        undefined,
        outcome.inline.map((run) => run.runId),
      );
      output.flush();
      return true;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
