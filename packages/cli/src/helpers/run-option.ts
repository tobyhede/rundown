// packages/cli/src/helpers/run-option.ts

import { isRunId, type RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Validate a run id given on the command line — a `--run` value or a
 * positional `<run-id>` — rendering `INVALID_RUN_ID` when it is malformed.
 *
 * @param raw - Raw run id from Commander
 * @param output - Output emitter used to render the validation failure
 * @returns The validated run id, or `undefined` after emitting the error and
 *   setting exit code 1
 */
export function parseRunId(raw: string, output: OutputEmitter): RunId | undefined {
  if (isRunId(raw)) return raw;
  output.error('Invalid run id. Expected rd_<32 hex characters>.', 'INVALID_RUN_ID');
  output.flush();
  process.exitCode = 1;
  return undefined;
}

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
  const runId = parseRunId(raw, output);
  return runId === undefined ? { ok: false } : { ok: true, runId };
}
