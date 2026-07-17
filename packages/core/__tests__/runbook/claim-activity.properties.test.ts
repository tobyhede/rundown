import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
// No `type DurationMs` import: `assertDurationMs()` already RETURNS `DurationMs`, so
// every call site here is correctly typed without an annotation or a cast. Adding
// `as DurationMs` would trip `@typescript-eslint/no-unnecessary-type-assertion`
// (an ERROR here) and fail `pnpm run verify`.
import { claimActivity, isClaimProgressUnreadable } from '../../src/runbook/claim-activity.js';
import { assertDurationMs } from '../../src/runbook/duration.js';
import type { ClaimRecord } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';

function claimAt(lastProgressAt: string): ClaimRecord {
  return makeClaimRecord({ lastProgressAt });
}

// Bounded so every timestamp is a valid ISO string and every difference fits
// comfortably in a safe integer.
const epochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });
const thresholdMs = fc.integer({ min: 0, max: 86_400_000 });

/**
 * `now`, generated RELATIONALLY: an offset around `progressAt + threshold` rather
 * than an independent absolute instant.
 *
 * This is the difference between a property that tests the boundary and one that
 * only looks like it does. Drawing `nowAt` independently from `epochMs`
 * (0–4.1e12) while `threshold` maxes at 8.64e7 means the band where `idleFor` is
 * anywhere near `idleAfter` is sampled with probability ~1e-5 — effectively never
 * in 100 runs. Every draw lands deep in the far field where the answer is
 * unanimous, so such a property kills `>` -> `<`/`true`/`false` only because
 * everything disagrees out there, and NO off-by-one is reachable: `>` -> `>=` is
 * decided by a single instant that is never generated. Centring on the threshold
 * puts every draw within +/-2ms of the decision boundary.
 */
const offsetAroundThreshold = fc.integer({ min: -2, max: 2 });

describe('claimActivity properties (#519)', () => {
  it('is total over any valid ISO lastProgressAt and any valid now', () => {
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          assertDurationMs(threshold),
        );
        expect(typeof activity.idle).toBe('boolean');
        expect(activity.idleFor).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(activity.idleFor)).toBe(true);
      }),
    );
  });

  it('agrees with an INDEPENDENT oracle computed from the raw inputs', () => {
    // Deliberately NOT `expect(activity.idle).toBe(activity.idleFor > idleAfter)`.
    // That restates the implementation character-for-character using the
    // implementation's own output, so it holds under ANY mutation of `>` — a
    // tautology that costs runtime and buys nothing. This oracle is derived from
    // the raw inputs instead, so it disagrees when the comparison is mutated.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const idleAfter = assertDurationMs(threshold);
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          idleAfter,
        );
        const expectedIdle = nowAt > progressAt + threshold;
        expect(activity.idle).toBe(expectedIdle);
      }),
    );
  });

  it('agrees with the oracle AT the decision boundary, where off-by-one lives', () => {
    // The property above draws `nowAt` independently across a range ~50,000x the
    // threshold's, so every draw lands in the far field and the boundary is never
    // sampled. This one generates `now` RELATIVE to `progressAt + threshold`, so
    // every draw is within +/-2ms of the decision point.
    //
    // This is what makes the `>` -> `>=` mutant reachable in the property suite:
    // that mutant differs from the original at EXACTLY ONE instant
    // (idleFor === idleAfter), and offset 0 hits it on essentially every run.
    fc.assert(
      fc.property(epochMs, thresholdMs, offsetAroundThreshold, (progressAt, threshold, offset) => {
        const idleAfter = assertDurationMs(threshold);
        const nowAt = progressAt + threshold + offset;
        const activity = claimActivity(
          claimAt(new Date(progressAt).toISOString()),
          new Date(nowAt),
          idleAfter,
        );
        // Strictly greater: offset 0 (exactly at the threshold) is NOT idle.
        expect(activity.idle).toBe(offset > 0);
        expect(activity.idleFor).toBe(Math.max(0, threshold + offset));
      }),
    );
  });

  it('is monotonic in the threshold: raising idleAfter never makes a claim idler', () => {
    // A structural property with no counterpart line in the implementation:
    // a more generous threshold can only ever reclassify idle -> not idle.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, thresholdMs, (progressAt, nowAt, a, b) => {
        const [lower, higher] = a <= b ? [a, b] : [b, a];
        const record = claimAt(new Date(progressAt).toISOString());
        const strict = claimActivity(record, new Date(nowAt), assertDurationMs(lower));
        const lenient = claimActivity(record, new Date(nowAt), assertDurationMs(higher));
        if (!strict.idle) expect(lenient.idle).toBe(false);
      }),
    );
  });

  it('idleFor is monotonic non-decreasing in now', () => {
    fc.assert(
      fc.property(
        epochMs,
        epochMs,
        fc.integer({ min: 0, max: 86_400_000 }),
        thresholdMs,
        (progressAt, nowAt, delta, threshold) => {
          const record = claimAt(new Date(progressAt).toISOString());
          const idleAfter = assertDurationMs(threshold);
          const earlier = claimActivity(record, new Date(nowAt), idleAfter);
          const later = claimActivity(record, new Date(nowAt + delta), idleAfter);
          // Time only moves forward, so an unrefreshed claim only gets idler.
          expect(later.idleFor).toBeGreaterThanOrEqual(earlier.idleFor);
        },
      ),
    );
  });

  it('ALWAYS throws CLAIM_PROGRESS_UNREADABLE for an unparseable lastProgressAt (AC6)', () => {
    // AC6 is the failure this design calls "the single worst it can have", and every
    // OTHER property here builds its record via `new Date(x).toISOString()` — so
    // every generated timestamp is parseable and the RD-824 branch is UNREACHABLE
    // across the whole property suite. Without this, AC6 is pinned by exactly one
    // string literal ('not-a-date') in the unit suite.
    fc.assert(
      fc.property(
        fc.string().filter((s) => s.length > 0 && Number.isNaN(Date.parse(s))),
        epochMs,
        thresholdMs,
        (corrupt, nowAt, threshold) => {
          let thrown: unknown;
          try {
            claimActivity(claimAt(corrupt), new Date(nowAt), assertDurationMs(threshold));
          } catch (error) {
            thrown = error;
          }
          // Never a silent classification: the fail-open this AC exists to prevent
          // is `idle: false` on a dead claim, and `NaN > x` is false, so a missing
          // throw would present exactly as a healthy claim.
          expect(isClaimProgressUnreadable(thrown)).toBe(true);
        },
      ),
    );
  });

  it('passes lastProgressAt through verbatim, never a reformatted or substituted value', () => {
    // The unit suite asserts this at ONE point, where `claimAt` gives `updatedAt` and
    // `lastProgressAt` the SAME string — so that assertion cannot tell the two fields
    // apart, and a `record.updatedAt` mutant survives it. Here they are forced to
    // differ, so the field the implementation reads is observable.
    fc.assert(
      fc.property(epochMs, epochMs, thresholdMs, (progressAt, nowAt, threshold) => {
        const iso = new Date(progressAt).toISOString();
        const record = makeClaimRecord({
          lastProgressAt: iso,
          // A DIFFERENT instant, so reading the wrong field is observable.
          updatedAt: new Date(progressAt + 1).toISOString(),
        });
        const activity = claimActivity(record, new Date(nowAt), assertDurationMs(threshold));
        expect(activity.lastProgressAt).toBe(iso);
      }),
    );
  });

  it('never reports idle for a claim whose progress is at or after now (skew safety)', () => {
    // The clock-skew invariant, stated over the whole input space rather than the
    // single unit-test point: a holder that progressed at or after the observation
    // time can never be idle, at ANY threshold.
    fc.assert(
      fc.property(
        epochMs,
        fc.integer({ min: 0, max: 86_400_000 }),
        thresholdMs,
        (nowAt, skew, threshold) => {
          const activity = claimActivity(
            claimAt(new Date(nowAt + skew).toISOString()),
            new Date(nowAt),
            assertDurationMs(threshold),
          );
          expect(activity.idleFor).toBe(0);
          expect(activity.idle).toBe(false);
        },
      ),
    );
  });
});
