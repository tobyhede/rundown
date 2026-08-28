/**
 * Run-bound Run Progression authority (#851 / ADR 0003).
 *
 * One core-verified value naming the run an activation may drive, the claim
 * authority presented for its fenced turns, and the delegation capabilities
 * verified for it. Progression accepts nothing else: carrying the three as one
 * branded value is what makes "the target run, the claim generation, and the
 * delegation capabilities cannot disagree" a property of the type rather than a
 * convention across three parameters.
 *
 * @module runbook/run-progression-authority
 */

import type { ClaimLookupKey } from './claim-id.js';
import type { DelegationRuntimeCapabilities } from './delegation-credential.js';
import type { RunId } from './run-id.js';

/**
 * Brand proving the authority was minted by core after verification.
 *
 * A real `unique symbol` that is never exported, mirroring
 * `DelegationRuntimeCapabilities`' same-authority brand: the only producer of a
 * {@link RunProgressionAuthority} is {@link mintRunProgressionAuthority} in this
 * module, which core seams call at the point caller evidence was verified.
 * A frontend cannot assemble one from parts.
 */
const runProgressionAuthorityBrand: unique symbol = Symbol('runProgressionAuthority');

/**
 * One verified, run-bound authority for a Run Progression activation.
 *
 * Minted by core where the caller's evidence was verified (for the collect
 * continuation, inside the collection seam that verified the collector's
 * bearer). The activation threads this single value through every mutating
 * turn; frontends carry it opaquely.
 */
export interface RunProgressionAuthority {
  /** The one run this authority may drive. */
  readonly runId: RunId;
  /**
   * Presented bearer lookup key for fenced captures, when the continuation is
   * claim-authenticated. Absent for an authorized bare/run-control caller,
   * matching the fence's bare-capture path.
   */
  readonly claimKey?: ClaimLookupKey;
  /**
   * Verified claim-bound delegation capabilities for this run, when the
   * verifying seam derived them. Both halves of one authority — see
   * {@link DelegationRuntimeCapabilities}. Absent when the caller presented no
   * delegation-capable authority; progression then refuses any turn that
   * would need to issue or project a delegation frontier.
   */
  readonly delegationRuntime?: DelegationRuntimeCapabilities;
  /** Brand proving core minted this value after verification. */
  readonly [runProgressionAuthorityBrand]: true;
}

/** Input to {@link mintRunProgressionAuthority}. */
export interface MintRunProgressionAuthorityInput {
  /** The one run the activation may drive. */
  readonly runId: RunId;
  /** Presented bearer lookup key, when the continuation is claim-authenticated. */
  readonly claimKey?: ClaimLookupKey;
  /** Verified delegation capabilities bound to this run's authority. */
  readonly delegationRuntime?: DelegationRuntimeCapabilities;
}

/**
 * Mint a run-bound progression authority from already-verified evidence.
 *
 * Core-internal: this module is deliberately absent from the public barrel, so
 * only core seams — which sit at the point verification happened — can produce
 * the branded value. Frontends receive it from those seams and pass it back
 * verbatim.
 *
 * @param input - The verified run, optional claim key, and optional delegation
 *   capabilities to bind.
 * @returns The branded authority value.
 */
export function mintRunProgressionAuthority(
  input: MintRunProgressionAuthorityInput,
): RunProgressionAuthority {
  return {
    runId: input.runId,
    ...(input.claimKey !== undefined ? { claimKey: input.claimKey } : {}),
    ...(input.delegationRuntime !== undefined
      ? { delegationRuntime: input.delegationRuntime }
      : {}),
    [runProgressionAuthorityBrand]: true,
  };
}
