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
  type ExecutionLeaseRefusal,
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
 * @param description - Help text for `--token`; defaults to
 *   {@link TOKEN_OPTION_DESCRIPTION}. A command whose token selects
 *   differently (prune) extends that text rather than rewording it.
 * @returns The same command, for chaining.
 */
export function withTokenOption(
  command: Command,
  description: string = TOKEN_OPTION_DESCRIPTION,
): Command {
  return (
    command
      .option('--token <token>', description)
      // Registered hidden so that `--run` on a mutating command is refused
      // with the documented `INVALID_SYNTAX` envelope by `parseTokenOption`
      // rather than by Commander's plain-text "unknown option" error.
      .addOption(new Option('--run <runId>').hideHelp())
  );
}

/**
 * Outcome of parsing a `--token` that the command does not require.
 *
 * `refused` means the refusal envelope is already flushed and the exit code
 * set; the caller returns without touching state.
 */
export type OptionalTokenOption =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly token: OwnerToken }
  | { readonly kind: 'refused' };

// Render a token-option refusal: flushed envelope, exit 1.
function refuse(output: OutputEmitter, message: string, code: string): void {
  output.error(message, code);
  output.flush();
  process.exitCode = 1;
}

/**
 * Parse the raw `--token` value of a mutating command for which the token is
 * optional (`prune`: finished runs prune without one; only a running run
 * needs its token).
 *
 * Precedence of the refusals, all `exit 1` with the envelope already flushed:
 *
 * 1. `--run` supplied, with or without `--token` → `INVALID_SYNTAX`. `--run`
 *    is a read-only selector and never mutation authority.
 * 2. A malformed token → `INVALID_SYNTAX`. The offending value is never
 *    echoed — it may be a near-miss of a real secret.
 *
 * @param raw - Raw Commander option values, each `undefined` when absent.
 * @param raw.token - Raw `--token` value, when supplied.
 * @param raw.run - Raw `--run` value, when supplied.
 * @param command - The mutating command, named in the refusal.
 * @param output - Output emitter used to render a refusal.
 * @returns `absent` when no token was given, `present` with the parsed Owner
 *   Token, or `refused` when a refusal was rendered.
 * @throws {Error} Any failure from parsing the token other than
 *   `InvalidRunSecretError`, which is rendered as a refusal instead.
 */
export function parseOptionalTokenOption(
  raw: { readonly token?: string; readonly run?: string },
  command: string,
  output: OutputEmitter,
): OptionalTokenOption {
  if (raw.run !== undefined) {
    refuse(
      output,
      `--run is a read-only selector and cannot authorize rundown ${command}; pass --token <owner_token> alone.`,
      'INVALID_SYNTAX',
    );
    return { kind: 'refused' };
  }
  if (raw.token === undefined) return { kind: 'absent' };
  try {
    return { kind: 'present', token: parseOwnerToken(raw.token) };
  } catch (error) {
    if (error instanceof InvalidRunSecretError) {
      refuse(
        output,
        'Invalid --token: expected an owner token of the form rdo_<43 base64url characters>.',
        'INVALID_SYNTAX',
      );
      return { kind: 'refused' };
    }
    throw error;
  }
}

/**
 * Parse the raw `--token` value of a mutating command that requires it.
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
  const parsed = parseOptionalTokenOption(raw, command, output);
  switch (parsed.kind) {
    case 'present':
      return parsed.token;
    case 'absent':
      refuse(output, tokenRequiredMessage(command), CLIErrorCodes.TOKEN_REQUIRED);
      return undefined;
    case 'refused':
      return undefined;
    default: {
      const _exhaustive: never = parsed;
      return _exhaustive;
    }
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

/**
 * Render a core execution-lease refusal (#902) as its error envelope.
 *
 * Core decided the refusal, its code and its message; this only carries the
 * lease's public fields as details. The lease never
 * carries a secret.
 *
 * @param output - Output emitter for CLI output.
 * @param refusal - The core lease refusal.
 * @returns `true`: a lease refusal always requests a non-zero exit.
 */
export function renderExecutionLeaseRefusal(
  output: OutputEmitter,
  refusal: ExecutionLeaseRefusal,
): true {
  output.error(refusal.message, refusal.code, {
    runId: refusal.runId,
    step: refusal.step,
    attempt: refusal.lease.attempt,
    pid: refusal.lease.pid,
    startedAt: refusal.lease.startedAt,
  });
  return true;
}
