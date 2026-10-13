/**
 * `rundown stop --run <id>`: the human escape hatch for a lost top-level
 * Owner Token (#906, ADR 0005).
 *
 * The only mutation a run id may drive, and only for a human: the command is
 * refused unless a person at an interactive terminal is there to confirm it,
 * and the stop records who confirmed it, when, and their message on the run.
 * Everything this module does is Category A — detecting the terminal, asking,
 * reading the login name and host. Core's `stopByHuman` decides what the id
 * may stop and stops it through the lifecycle seam.
 *
 * @module helpers/escape-hatch
 */

import { hostname, userInfo } from 'node:os';
import {
  CONCURRENT_MODIFICATION_CODE,
  resolveHumanStopTarget,
  stopByHuman,
  type HumanStopAudit,
  type RunId,
} from '@rundown-org/core';
import type { HumanConfirmation } from '../services/human-confirmation.js';
import type { OutputEmitter } from '../services/output-emitter.js';
import { buildLifecycleSeam } from './lifecycle-seam-factory.js';
import { renderTerminalOutcome } from './terminal-command.js';
import { renderRunFinished } from './token-option.js';

/** Code of the refusal of the escape hatch with no human at a terminal. */
export const INTERACTIVE_REQUIRED_CODE = 'INTERACTIVE_REQUIRED';
/** Code of the refusal of the escape hatch the human declined. */
export const NOT_CONFIRMED_CODE = 'NOT_CONFIRMED';

/** Message of the {@link INTERACTIVE_REQUIRED_CODE} refusal. */
export const INTERACTIVE_REQUIRED_MESSAGE =
  'rundown stop --run is the human escape hatch for a lost owner token: it asks for confirmation at an interactive terminal and records who stopped the run. There is no terminal here, so nothing was stopped. An agent must not use it: stop the run with --token <owner_token>, or ask the user to run `rundown stop --run <id>` themselves.';

/**
 * The login name of the user at this terminal.
 *
 * @returns The login name, or the `USER` / `USERNAME` environment variable
 *   where the host cannot report one, or `unknown`.
 */
function loginName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

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
 * Refuse, ask, and — on an explicit yes — stop the named run with its audit.
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
  const { manager, seam } = buildLifecycleSeam(cwd);
  // Core refuses what the hatch may not stop before anyone is asked.
  const target = await resolveHumanStopTarget(manager, input.runId);
  switch (target.kind) {
    case 'target':
      break;
    case 'run_finished':
      renderRunFinished(output, 'stop', target.runId, target.lifecycle);
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
  const user = loginName();
  const host = hostname();
  const confirmed = await input.human.confirm(
    `Stop run ${state.id} (${state.runbook.path}, at step ${state.step}) without its owner token? This is recorded on the run as stopped by ${user} on ${host}.`,
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
  const outcome = await stopByHuman(seam, target, audit);
  switch (outcome.kind) {
    case 'unknown_run':
      output.error(outcome.message, outcome.code, { runId: outcome.runId });
      output.flush();
      return true;
    case 'concurrent_modification':
      output.error(outcome.message, CONCURRENT_MODIFICATION_CODE, { runId: outcome.runId });
      output.flush();
      return true;
    case 'run_finished':
    case 'execution_in_progress':
    case 'execution_interrupted':
    case 'applied': {
      const exitError = await renderTerminalOutcome(
        output,
        'stop',
        manager,
        outcome,
        input.message,
      );
      output.flush();
      return exitError;
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
