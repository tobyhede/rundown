// packages/cli/src/helpers/run-option.ts

import {
  isRunId,
  type ClaimCapability,
  type ClaimId,
  type RunCapability,
  type RunId,
} from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Parse and validate the `--run <rd_…>` option (Category-A flag parsing only).
 *
 * Validates format via core's `isRunId` and enforces mutual exclusion with
 * delegated claim authority: an orchestrator names its own run, a delegated
 * child names its claim capability — never both. On failure the error envelope
 * is emitted and a non-zero exit code requested; the caller simply returns.
 *
 * @param raw - Raw `--run` value from Commander; `undefined` when absent
 * @param claimId - Parsed `--claim-id` value, for the mutual-exclusion check
 * @param output - Output emitter used to render validation failures
 * @param claimCapability - Parsed `--claim-capability` value, for the
 * mutual-exclusion check
 * @param runCapability - Parsed `--run-capability` value, for the
 * mutual-exclusion check
 * @returns `{ ok: true }` (no `--run`), `{ ok: true, runId }` (validated), or
 *   `{ ok: false }` after emitting the error
 */
export function parseRunOption(
  raw: string | undefined,
  claimId: ClaimId | undefined,
  output: OutputEmitter,
  claimCapability?: ClaimCapability,
  runCapability?: RunCapability,
): { readonly ok: true; readonly runId?: RunId } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  if (claimId !== undefined || claimCapability !== undefined || runCapability !== undefined) {
    output.error(
      '--run cannot be combined with authority credentials: use --run-capability or --claim-capability for mutations.',
      'INVALID_SYNTAX',
    );
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
  if (!isRunId(raw)) {
    output.error('Invalid run id. Expected rd_<32 hex characters>.', 'INVALID_RUN_ID');
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
  return { ok: true, runId: raw };
}
