import { isClaimId, type ClaimId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Parse and validate an optional CLI claim id argument.
 *
 * @param raw - Raw claim id option value
 * @param output - Output emitter used to report validation errors
 * @returns Parsed claim id result, or `ok: false` after emitting an error
 */
export function parseClaimIdOption(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly claimId?: ClaimId } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  if (isClaimId(raw)) return { ok: true, claimId: raw };
  output.error(
    'Invalid claim id. Expected rdclm_<32 lowercase hex characters>_<43 base64url characters>.',
    'INVALID_CLAIM_ID',
  );
  output.flush();
  process.exitCode = 1;
  return { ok: false };
}

/**
 * Reject ambiguous claim-plus-run targeting.
 *
 * `--claim-id` is bearer authority and currently resolves its own target;
 * `--run` is only a selector. Until the API explicitly models
 * claim-plus-selector narrowing, accepting both would silently ignore one of
 * the caller's constraints.
 *
 * @param input - Raw option presence and output emitter.
 * @param input.claimId - Raw claim id option value.
 * @param input.run - Raw run id option value.
 * @param input.output - Output emitter used to report validation errors.
 * @returns True when the command should stop.
 */
export function rejectClaimRunCombination(input: {
  readonly claimId?: string;
  readonly run?: string;
  readonly output: OutputEmitter;
}): boolean {
  if (input.claimId === undefined || input.run === undefined) return false;
  input.output.error(
    'Pass either --claim-id or --run, not both. --claim-id is bearer authority; --run is target selection only.',
    'INVALID_SYNTAX',
  );
  input.output.flush();
  process.exitCode = 1;
  return true;
}
