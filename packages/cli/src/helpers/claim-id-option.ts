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
  output.error('Invalid claim id. Expected rdclm_<22 base64url characters>.', 'INVALID_CLAIM_ID');
  output.flush();
  process.exitCode = 1;
  return { ok: false };
}
