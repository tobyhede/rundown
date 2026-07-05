// packages/cli/src/helpers/caller-evidence.ts

import {
  parseRunCapability,
  type CallerEvidence,
  type RunCapability,
  type RunId,
} from '@rundown-org/core';

/**
 * Claim evidence reconstructed CLI-side from a resolved `--claim-id` record.
 *
 * The fields are exactly the claim variant of {@link CallerEvidence} minus its
 * discriminant — derived from it so the two cannot drift.
 */
export type ResolvedClaimEvidence = Omit<Extract<CallerEvidence, { kind: 'claim' }>, 'kind'>;

/** Inputs for gathering direct-CLI lifecycle caller evidence. */
export interface LifecycleEvidenceInput {
  /** Resolved claim evidence when the command targets a claimed child via `--claim-id`. */
  readonly claim?: ResolvedClaimEvidence;
  /** Caller-named run authority from a validated `--run` flag. */
  readonly runId?: RunId;
  /** Verified run capability from a validated `--run-capability` flag. */
  readonly runCapability?: RunCapability;
}

/**
 * Gather the typed caller evidence for a direct-CLI lifecycle command.
 *
 * Three lanes, in precedence order (exclusivity of `--run` / `--claim-id` is
 * enforced upstream by `parseRunOption`, so at most one input is present):
 *
 * 1. **Claim** — a `--claim-id` invocation carries claim evidence (`claimId`,
 *    `tokenHash`, `controlledRunId`) reconstructed from the resolved claim
 *    record, which core maps to a claim controller over the controlled run.
 * 2. **Run capability** — a `--run-capability <rdrc_…>` invocation names the
 *    verified authority credential; core maps it to a trusted controller of
 *    exactly that embedded run (`deriveEffectiveRole` refuses an id/target
 *    mismatch).
 * 3. **Direct CLI** — a bare invocation maps to `{ kind: 'direct_cli' }`; core
 *    decides whether that grants anything for the resolved target.
 *
 * The CLI process cannot itself distinguish a human invocation from a
 * subprocess-spawned one, so it does not try to: subprocess front ends (plugin /
 * MCP) withhold bare role-specific mutations upstream (see
 * `@rundown-org/core` `bareRoleSpecificMutation`), leaving the CLI free to treat
 * its own bare invocation as direct-CLI. No source label is read or trusted.
 *
 * @param input - Optional claim evidence and/or validated `--run` run id.
 * @returns Typed caller evidence for the core lifecycle command seam.
 */
export function readLifecycleCallerEvidence(input: LifecycleEvidenceInput = {}): CallerEvidence {
  if (input.claim) {
    return { kind: 'claim', ...input.claim };
  }
  if (input.runCapability !== undefined) {
    return { kind: 'run_capability', runId: parseRunCapability(input.runCapability).runId };
  }
  if (input.runId !== undefined) {
    return { kind: 'run_identifier', runId: input.runId };
  }
  return { kind: 'direct_cli' };
}
