import { assertRunCapability, type ClaimCapability, type RunCapability } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Parse and validate the `--run-capability <rdrc_…>` option.
 *
 * @param raw - Raw option value from Commander
 * @param claimCapability - Parsed claim capability, used for mutual exclusion
 * @param output - Output emitter used to render validation failures
 * @returns Parsed run capability or an emitted validation failure
 */
export function parseRunCapabilityOption(
  raw: string | undefined,
  claimCapability: ClaimCapability | undefined,
  output: OutputEmitter,
): { readonly ok: true; readonly runCapability?: RunCapability } | { readonly ok: false } {
  if (raw === undefined) return { ok: true };
  if (claimCapability !== undefined) {
    output.error(
      '--run-capability and --claim-capability are mutually exclusive: use exactly one authority credential.',
      'INVALID_SYNTAX',
    );
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
  try {
    return { ok: true, runCapability: assertRunCapability(raw) };
  } catch {
    output.error(
      'Invalid run capability. Expected rdrc_<run id body>_<43 base64url characters>.',
      'INVALID_RUN_CAPABILITY',
    );
    output.flush();
    process.exitCode = 1;
    return { ok: false };
  }
}
