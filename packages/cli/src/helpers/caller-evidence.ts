// packages/cli/src/helpers/caller-evidence.ts

import type { CallerEvidence } from '@rundown-org/core';

/**
 * Claim evidence reconstructed CLI-side from a resolved `--claim-id` record.
 *
 * The fields are exactly the claim variant of {@link CallerEvidence} minus its
 * discriminant — derived from it so the two cannot drift.
 */
export type ResolvedClaimEvidence = Omit<Extract<CallerEvidence, { kind: 'claim' }>, 'kind'>;

/**
 * Gather the typed caller evidence for a direct-CLI lifecycle command.
 *
 * The CLI is the trusted direct lane: a genuine direct-CLI invocation maps to
 * `{ kind: 'direct_cli' }`, which core resolves to a trusted run controller over
 * the active run. A `--claim-id` invocation instead carries claim evidence
 * (`claimId`, `tokenHash`, `controlledRunId`) reconstructed from the resolved
 * claim record, which core maps to a claim controller over the controlled run.
 *
 * The CLI process cannot itself distinguish a human invocation from a
 * subprocess-spawned one, so it does not try to: subprocess front ends (plugin /
 * MCP) withhold bare role-specific mutations upstream (see
 * `@rundown-org/core` `bareRoleSpecificMutation`), leaving the CLI free to treat
 * its own bare invocation as direct-CLI. No source label is read or trusted.
 *
 * @param claim - Resolved claim evidence when the command targets a claimed
 *   child via `--claim-id`; omit for a bare direct-CLI invocation.
 * @returns Typed caller evidence for the core lifecycle command seam.
 */
export function readLifecycleCallerEvidence(claim?: ResolvedClaimEvidence): CallerEvidence {
  if (claim) {
    return { kind: 'claim', ...claim };
  }
  return { kind: 'direct_cli' };
}
