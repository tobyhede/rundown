/**
 * The `--token <token>` option every mutating command carries (ADR 0005).
 *
 * One writer per run: a run is named by its Owner Token and by nothing else.
 * This module is the single registrar and parser of that option, so a
 * mutating command cannot register it with different wording, accept a
 * malformed token, or pair it with the read-only `--run` selector.
 *
 * The token itself is Category-A input (a raw CLI string). Everything that
 * depends on state — which run it owns, whether that run is still running —
 * is decided in core by `resolveOwnedRun`; see {@link renderOwnedRunRefusal}
 * for the rendering of its refusing arms.
 *
 * @module helpers/token-option
 */

import { Option, type Command } from 'commander';
import {
  CLIErrorCodes,
  InvalidRunSecretError,
  parseOwnerToken,
  type FinishedLifecycle,
  type OwnedRunResolution,
  type OwnerToken,
  type RunId,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/** Help text shared by every registration of `--token`. */
export const TOKEN_OPTION_DESCRIPTION =
  'Owner token of the run to mutate (owner_token from runbook_started)';

/**
 * Operator remedy named by every `TOKEN_REQUIRED` refusal.
 *
 * @param command - The mutating command that was issued bare.
 * @returns The refusal message.
 */
export function tokenRequiredMessage(command: string): string {
  return `rundown ${command} requires --token <owner_token>; copy owner_token from the runbook_started event printed by rundown run.`;
}

/** Message rendered when a well-formed token matches no run. */
export const UNKNOWN_TOKEN_MESSAGE =
  'No run matches this token. Copy owner_token from the runbook_started event of the run you mean to drive.';

/**
 * Register `--token <token>` on a mutating command.
 *
 * Registered as an ordinary option rather than a Commander `requiredOption`
 * so a bare invocation reaches {@link parseTokenOption}, which renders the
 * documented `TOKEN_REQUIRED` envelope instead of Commander's plain-text
 * usage error. `--run` rides along hidden for the same reason: the documented
 * refusal of `--run` on a mutating command is `INVALID_SYNTAX`.
 *
 * @param command - The Commander command to register the option on.
 * @returns The same command, for chaining.
 */
export function withTokenOption(command: Command): Command {
  return (
    command
      .option('--token <token>', TOKEN_OPTION_DESCRIPTION)
      // Registered hidden so that `--run` on a mutating command is refused
      // with the documented `INVALID_SYNTAX` envelope by `parseTokenOption`
      // rather than by Commander's plain-text "unknown option" error.
      .addOption(new Option('--run <runId>').hideHelp())
  );
}

/**
 * Parse the raw `--token` value of a mutating command.
 *
 * Precedence of the refusals, all `exit 1` with the envelope already flushed:
 *
 * 1. `--run` supplied alongside `--token` → `INVALID_SYNTAX`. `--run` is a
 *    read-only selector and never mutation authority; combining the two
 *    would let a run id masquerade as proof of ownership.
 * 2. No `--token` → `TOKEN_REQUIRED`, with the remedy naming `owner_token`
 *    from `runbook_started`.
 * 3. A malformed token → `INVALID_SYNTAX`. The offending value is never
 *    echoed — it may be a near-miss of a real secret.
 *
 * @param raw - Raw Commander option values, each `undefined` when absent.
 * @param raw.token - Raw `--token` value, when supplied.
 * @param raw.run - Raw `--run` value, when supplied.
 * @param command - The mutating command, named in the refusal.
 * @param output - Output emitter used to render a refusal.
 * @returns The parsed Owner Token, or `undefined` when a refusal was rendered.
 * @throws {Error} Any failure from parsing the token other than
 *   `InvalidRunSecretError`, which is rendered as a refusal instead.
 */
export function parseTokenOption(
  raw: { readonly token?: string; readonly run?: string },
  command: string,
  output: OutputEmitter,
): OwnerToken | undefined {
  if (raw.run !== undefined) {
    output.error(
      `--run is a read-only selector and cannot authorize rundown ${command}; pass --token <owner_token> alone.`,
      'INVALID_SYNTAX',
    );
    output.flush();
    process.exitCode = 1;
    return undefined;
  }
  if (raw.token === undefined) {
    output.error(tokenRequiredMessage(command), CLIErrorCodes.TOKEN_REQUIRED);
    output.flush();
    process.exitCode = 1;
    return undefined;
  }
  try {
    return parseOwnerToken(raw.token);
  } catch (error) {
    if (error instanceof InvalidRunSecretError) {
      output.error(
        'Invalid --token: expected an owner token of the form rdo_<43 base64url characters>.',
        'INVALID_SYNTAX',
      );
      output.flush();
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

/**
 * The RD-303 / RD-304 "run finished" refusal for a finished run.
 *
 * `completed` renders RD-303, `stopped` and `abandoned` render RD-304: a
 * stopped run and an abandoned run are both runs that ended without
 * completing, which is the distinction the two codes draw.
 *
 * @param lifecycle - How the run finished.
 * @returns The RD code for the refusal.
 */
export function runFinishedCode(lifecycle: FinishedLifecycle): 'RD-303' | 'RD-304' {
  return lifecycle === 'completed' ? 'RD-303' : 'RD-304';
}

/**
 * Render the refusing arms of core's `resolveOwnedRun` and report whether
 * the command exits non-zero (always, for a refusal).
 *
 * @param output - Output emitter for CLI output.
 * @param command - The mutating command, named in the refusal.
 * @param resolution - A non-`running` resolution.
 * @returns `true`: every refusal requests a non-zero exit.
 */
export function renderOwnedRunRefusal(
  output: OutputEmitter,
  command: string,
  resolution: Exclude<OwnedRunResolution, { kind: 'running' }>,
): boolean {
  switch (resolution.kind) {
    case 'unknown_token':
      output.error(UNKNOWN_TOKEN_MESSAGE, CLIErrorCodes.UNKNOWN_TOKEN);
      return true;
    case 'finished':
      renderRunFinished(output, command, resolution.state.id, resolution.lifecycle);
      return true;
    default: {
      const _exhaustive: never = resolution;
      return _exhaustive;
    }
  }
}

/**
 * Render the "run finished" refusal shared by every mutating command.
 *
 * @param output - Output emitter for CLI output.
 * @param command - The mutating command, named in the refusal.
 * @param runId - The finished run.
 * @param lifecycle - How it finished.
 */
export function renderRunFinished(
  output: OutputEmitter,
  command: string,
  runId: RunId,
  lifecycle: FinishedLifecycle,
): void {
  output.error(
    `Run ${runId} has finished (${lifecycle}); rundown ${command} cannot be applied. Start a new run with rundown run.`,
    runFinishedCode(lifecycle),
    { runId, lifecycle },
  );
}
