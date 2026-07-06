// packages/cli/src/helpers/caller-evidence.ts

import type { CallerEvidence, ClaimId } from '@rundown-org/core';

/** Inputs for gathering direct-CLI lifecycle caller evidence. */
export interface LifecycleEvidenceInput {
  /** Bearer claim id when the command targets a claimed child via `--claim-id`. */
  readonly claimId?: ClaimId;
}

/**
 * Gather the typed caller evidence for a direct-CLI lifecycle command.
 *
 * Only two lanes remain: claim bearer evidence and bare direct-CLI. Run
 * identifiers are target selectors, not authority.
 *
 * @param input - Optional claim evidence.
 * @returns Typed caller evidence for the core lifecycle command seam.
 */
export function readLifecycleCallerEvidence(input: LifecycleEvidenceInput = {}): CallerEvidence {
  if (input.claimId !== undefined) {
    return { kind: 'claim_bearer', claimId: input.claimId };
  }
  return { kind: 'direct_cli' };
}
