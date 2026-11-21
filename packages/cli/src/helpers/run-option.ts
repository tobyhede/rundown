// packages/cli/src/helpers/run-option.ts

import { isRunId, type RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';
import { RUN_ID_ENV } from './run-id-env.js';

/**
 * Parse and validate the `--run <rd_…>` option.
 *
 * @param raw - Raw `--run` value from Commander; `undefined` when absent
 * @param output - Output emitter used to render validation failures
 * @returns `{ ok: true }` (no `--run`), `{ ok: true, runId }` (validated), or
 *   `{ ok: false }` after emitting the error
 */
export function parseRunOption(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly runId?: RunId } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  if (!isRunId(raw)) {
    output.error('Invalid run id. Expected rd_<32 hex characters>.', 'INVALID_RUN_ID');
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, runId: raw };
}

/**
 * Resolve the read-only run selector for a command that may run inside a step.
 *
 * Precedence: an explicit `--run <rd_…>` wins; without it, the `RD_RUN_ID`
 * that core injects into every step command names the invoking run. An empty
 * `RD_RUN_ID` counts as absent. The environment value is validated exactly as
 * `--run` is, so a malformed one is refused `INVALID_RUN_ID` rather than
 * ignored. This selects a run to read; it is never mutation authority.
 *
 * @param raw - Raw `--run` value from Commander; `undefined` when absent
 * @param output - Output emitter used to render validation failures
 * @returns `{ ok: true }` (no selector), `{ ok: true, runId }` (validated), or
 *   `{ ok: false }` after emitting the error
 */
export function parseRunSelector(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly runId?: RunId } | { readonly ok: false } {
  if (raw !== undefined) return parseRunOption(raw, output);
  const fromEnv = process.env[RUN_ID_ENV];
  if (fromEnv === undefined || fromEnv.length === 0) return { ok: true };
  if (!isRunId(fromEnv)) {
    output.error(`Invalid ${RUN_ID_ENV}. Expected rd_<32 hex characters>.`, 'INVALID_RUN_ID');
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, runId: fromEnv };
}
