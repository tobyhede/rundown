/**
 * Run-bound Run Progression authority (#851 / ADR 0003, slimmed by ADR 0005).
 *
 * One core-verified value naming the run an activation may drive. Progression
 * accepts nothing else: carrying the run id as a branded value is what makes
 * "the target run cannot be swapped between selection and commit" a property
 * of the type rather than a convention across parameters.
 *
 * The claim key and delegation capabilities it used to carry went with the
 * multi-writer model; a single Owner Token proves ownership before the seam
 * mints this value, so the authority has nothing left to present per turn.
 *
 * @module runbook/run-progression-authority
 */

import type { RunId } from './run-id.js';

/**
 * Brand proving the authority was minted by core after verification.
 *
 * A real `unique symbol` that is never exported: the only producer of a
 * {@link RunProgressionAuthority} is {@link mintRunProgressionAuthority} in
 * this core-internal module. A frontend cannot assemble one from parts.
 */
const runProgressionAuthorityBrand: unique symbol = Symbol('runProgressionAuthority');

/**
 * One verified, run-bound authority for a Run Progression activation.
 *
 * Minted by core where the caller's Owner Token was verified. The activation
 * threads this single value through every mutating turn; frontends carry it
 * opaquely.
 */
export interface RunProgressionAuthority {
  /** The one run this authority may drive. */
  readonly runId: RunId;
  /** Brand proving core minted this value after verification. */
  readonly [runProgressionAuthorityBrand]: true;
}

/** Input to {@link mintRunProgressionAuthority}. */
export interface MintRunProgressionAuthorityInput {
  /** The one run the activation may drive. */
  readonly runId: RunId;
}

/**
 * Mint a run-bound progression authority from already-verified evidence.
 *
 * Core-internal: this module is deliberately absent from the public barrel, so
 * only core seams — which sit at the point verification happened — can produce
 * the branded value. Frontends receive it from those seams and pass it back
 * verbatim.
 *
 * @param input - The verified run to bind.
 * @returns The branded authority value.
 */
export function mintRunProgressionAuthority(
  input: MintRunProgressionAuthorityInput,
): RunProgressionAuthority {
  return {
    runId: input.runId,
    [runProgressionAuthorityBrand]: true,
  };
}
