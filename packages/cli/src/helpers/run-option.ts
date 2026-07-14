// packages/cli/src/helpers/run-option.ts

import { isRunId, type RunId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

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
