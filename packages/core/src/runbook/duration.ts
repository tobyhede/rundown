/**
 * Brand for {@link DurationMs}.
 *
 * Declared with `declare const` + `unique symbol` so the brand is purely
 * compile-time and no runtime property exists. Exported (like `runIdBrand` in
 * `run-id.ts:1`) so the brand survives into `@rundown-org/cli`'s view of the
 * built `.d.ts` — plan 3's humaniser consumes `DurationMs` across that boundary.
 *
 * Deliberately NOT the `{ readonly __brand: 'DurationMs' }` form: that appears
 * exactly ONCE in `packages/core/src` (`targeting.ts:20`), where the same file
 * also uses `__brand` as a real RUNTIME property (`:259`, `:290`) — so it is not
 * even a pure type brand there. Every other branded primitive in core uses a
 * unique symbol. A literal brand is also structurally forgeable by any module
 * that declares the same string; a symbol brand is not.
 */
export declare const durationMsBrand: unique symbol;

/**
 * A non-negative duration in milliseconds.
 *
 * Branded so a raw `number` cannot be passed where a duration is meant (and vice
 * versa). Milliseconds is the JSON wire unit for `idleFor`.
 */
export type DurationMs = number & { readonly [durationMsBrand]: true };

/**
 * Assert a raw millisecond count is a valid {@link DurationMs} and brand it.
 *
 * Named `assert*` to match every sibling brand seam — `assertRunId`
 * (`run-id.ts:29`), `assertClaimLookupKey` (`claim-id.ts:234`),
 * `assertDelegationTokenHash` (`delegation-token.ts:137`) — all of which take an
 * unbranded primitive, validate, throw on failure, and return the identical value
 * branded. This does exactly that, so it carries exactly that name.
 *
 * @param value - Non-negative, finite millisecond count.
 * @returns The branded duration.
 * @throws {RangeError} When `value` is negative, `NaN`, or infinite. A `RangeError`
 *   (not a bare `Error`) per `assertPositiveEntry` (`targeting.ts:44-48`), the
 *   repo's precedent for a caller-precondition violation: this is a code bug, not
 *   bad persisted data, and the read boundaries in plan 3 discriminate it from
 *   corrupt data BY TYPE rather than by message substring.
 */
export function assertDurationMs(value: number): DurationMs {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      `DurationMs must be a non-negative finite number, received: ${String(value)}`,
    );
  }
  return value as DurationMs;
}
