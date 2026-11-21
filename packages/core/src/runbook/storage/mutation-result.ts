/**
 * Typed vocabulary for conditional runbook state writes.
 *
 * One writer per run (ADR 0005) leaves a single concurrency counter:
 * `StateVersion`, the lost-update check a conditional `UPDATE` compares
 * against. The claim generations, execution epochs, linkage versions and
 * execution tokens that once lived here coordinated a second writer, and went
 * with it.
 *
 * @module runbook/storage/mutation-result
 */

declare const stateVersionBrand: unique symbol;

/**
 * Lost-update counter on `runs`. Bumped by the `runs_bump_state_version`
 * trigger on every `state_json` write. A mismatch at write time is
 * `concurrent_modification`, refused once and never retried.
 */
export type StateVersion = number & { readonly [stateVersionBrand]: true };

/**
 * Brand a non-negative safe integer as a {@link StateVersion}.
 *
 * @param value - Candidate integer.
 * @returns Branded state version.
 * @throws {Error} When the value is not a non-negative safe integer.
 */
export function assertStateVersion(value: number): StateVersion {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid StateVersion: expected a non-negative safe integer, got ${String(value)}`,
    );
  }
  return value as StateVersion;
}
