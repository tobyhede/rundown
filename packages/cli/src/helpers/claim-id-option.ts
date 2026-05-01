import { assertClaimId, type ClaimId } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

export function parseClaimIdOption(
  raw: string | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly claimId?: ClaimId } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  try {
    return { ok: true, claimId: assertClaimId(raw) };
  } catch {
    output.error('Invalid claim id. Expected rdclm_<22 base64url characters>.', 'INVALID_CLAIM_ID');
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
}
