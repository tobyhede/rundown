import { assertClaimCapability, type ClaimCapability } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Parse and validate an optional CLI claim capability argument.
 *
 * @param raw - Raw claim capability option value
 * @param output - Output emitter used to report validation errors
 * @returns Parsed claim capability result, or `ok: false` after emitting an error
 */
export function parseClaimCapabilityOption(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly claimCapability?: ClaimCapability } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  try {
    return { ok: true, claimCapability: assertClaimCapability(raw) };
  } catch {
    output.error(
      'Invalid claim capability. Expected rdcc_<claim id body>_<43 base64url characters>.',
      'INVALID_CLAIM_CAPABILITY',
    );
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
}
