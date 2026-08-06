/**
 * `advanceFrameEntry` is a monotonic counter, proved over arbitrary walks.
 *
 * The unit suite pins each arm on a hand-built coordinate. This one folds the
 * function over an arbitrary sequence of `(frameKey, reentered)` steps — the
 * shape a real run produces — and asserts the invariants every consumer relies
 * on rather than any single arm's arithmetic:
 *
 * - the ordinal never goes backwards, and never jumps by more than one, so a
 *   credential stamped in a frame is always reproducible from committed state;
 * - it advances by one *exactly* when a frame is entered — a switch, or a
 *   re-entry the transition declared — so `classifyDelegationLiveness` cannot
 *   close a delegation the cursor never left, nor keep one it did;
 * - a frame's recorded count never falls, so `inferFrameEntryFromState` can
 *   still answer for a frame the cursor has left;
 * - the active frame's own answer is the active entry, which is the identity
 *   the machine and committed-state readers meet on.
 *
 * The keys include bare-step and FOR-iteration frames of the same step, because
 * a loop-back is a frame switch and the two forms must not be conflated.
 */
import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';

import {
  advanceFrameEntry,
  inferFrameEntryFromState,
  type ActiveFrameEntryCoordinates,
  type FrameEntryCoordinates,
} from '../../src/runbook/frame-entry.js';
import { buildFrameKey, type FrameKey } from '../../src/runbook/targeting.js';

/** Bare step frames and two FOR-iteration frames of step `1`. */
const KEYS: readonly FrameKey[] = [
  buildFrameKey('1'),
  buildFrameKey('1', 1),
  buildFrameKey('1', 2),
  buildFrameKey('2'),
];

/** One state entry: the frame being entered and whether the transition declared a re-entry. */
const stepArb = fc.record({
  frameKey: fc.constantFrom(...KEYS),
  reentered: fc.boolean(),
});

describe('advanceFrameEntry: monotonicity over arbitrary walks', () => {
  it('advances by exactly one per frame entered and never retreats', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 40 }), (steps) => {
        let coordinates: FrameEntryCoordinates = {};

        for (const [index, step] of steps.entries()) {
          const previous = coordinates;
          const next: ActiveFrameEntryCoordinates = advanceFrameEntry(
            previous,
            step.frameKey,
            step.reentered,
          );

          // The frame just entered is the active one, and reading the
          // coordinates back for it reproduces the ordinal exactly. This is the
          // identity a stamped `parentEntry` is later compared against.
          expect(next.activeFrameKey).toBe(step.frameKey);
          expect(inferFrameEntryFromState(next, step.frameKey)).toBe(next.activeEntry);

          if (index === 0) {
            // Bootstrap: no frame was active, so there is no delta to score.
            expect(next.activeEntry).toBe(1);
          } else {
            const before = previous.activeEntry ?? 0;
            const delta = next.activeEntry - before;
            expect(delta === 0 || delta === 1).toBe(true);
            expect(delta === 1).toBe(step.reentered || step.frameKey !== previous.activeFrameKey);
          }

          // No frame's recorded count ever falls.
          for (const [key, count] of Object.entries(previous.frameEntryCounts ?? {})) {
            expect(next.frameEntryCounts?.[key as FrameKey] ?? 0).toBeGreaterThanOrEqual(count);
          }

          coordinates = next;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('leaves the coordinates it was given untouched', () => {
    // The fold above would still agree with itself if the function mutated its
    // input in place, so the input is deep-copied before each call and compared
    // to the original after it.
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 20 }), (steps) => {
        let coordinates: FrameEntryCoordinates = {};
        for (const step of steps) {
          const before: FrameEntryCoordinates = structuredClone(coordinates);
          const input = coordinates;
          coordinates = advanceFrameEntry(input, step.frameKey, step.reentered);
          expect(input).toEqual(before);
        }
        expect(coordinates.activeEntry).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 50 },
    );
  });
});
