import { advanceFrameEntry, inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
import type { RunbookState } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

describe('inferFrameEntryFromState', () => {
  const frameKey = buildFrameKey('1');
  const otherFrameKey = buildFrameKey('2');

  it('uses the active entry for the active frame', () => {
    const state = {
      activeFrameKey: frameKey,
      activeEntry: 7,
      frameEntryCounts: { [frameKey]: 5 },
    } as RunbookState;

    expect(inferFrameEntryFromState(state, frameKey)).toBe(7);
  });

  it('uses the recorded entry for an inactive frame', () => {
    const state = {
      activeFrameKey: otherFrameKey,
      activeEntry: 3,
      frameEntryCounts: { [frameKey]: 5 },
    } as RunbookState;

    expect(inferFrameEntryFromState(state, frameKey)).toBe(5);
  });

  it('uses the recorded entry when the active frame has no active entry', () => {
    const state = {
      activeFrameKey: frameKey,
      frameEntryCounts: { [frameKey]: 5 },
    } as RunbookState;

    expect(inferFrameEntryFromState(state, frameKey)).toBe(5);
  });

  it('defaults to the first entry when the frame has no recorded entry', () => {
    const state = {
      activeFrameKey: otherFrameKey,
      activeEntry: 3,
    } as RunbookState;

    expect(inferFrameEntryFromState(state, frameKey)).toBe(1);
  });
});

describe('advanceFrameEntry', () => {
  const FRAME_1 = buildFrameKey('1');
  const FRAME_2 = buildFrameKey('2');

  it('bootstraps to 1 when no active frame has been recorded', () => {
    expect(advanceFrameEntry({}, FRAME_1, false)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });

  it('bootstraps to the recorded count when the frame has history but no active entry', () => {
    expect(advanceFrameEntry({ frameEntryCounts: { [FRAME_1]: 4 } }, FRAME_1, false)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 4,
      frameEntryCounts: { [FRAME_1]: 4 },
    });
  });

  it('bootstraps when activeFrameKey is present but activeEntry is not', () => {
    expect(
      advanceFrameEntry({ activeFrameKey: FRAME_1, frameEntryCounts: {} }, FRAME_1, false),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });

  it('leaves the entry unchanged for a same-frame entry that is not a declared re-entry', () => {
    const coords = {
      activeFrameKey: FRAME_1,
      activeEntry: 3,
      frameEntryCounts: { [FRAME_1]: 3 },
    };
    expect(advanceFrameEntry(coords, FRAME_1, false)).toEqual(coords);
  });

  it('bumps on a declared same-frame re-entry', () => {
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 3, frameEntryCounts: { [FRAME_1]: 3 } },
        FRAME_1,
        true,
      ),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 4,
      frameEntryCounts: { [FRAME_1]: 4 },
    });
  });

  it('is run-global and monotonic across a frame switch, not per-frame-local', () => {
    // Entering frame 2 for the FIRST time from frame 1 at entry 5 yields 6, not 1.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 5, frameEntryCounts: { [FRAME_1]: 5 } },
        FRAME_2,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_2,
      activeEntry: 6,
      frameEntryCounts: { [FRAME_1]: 5, [FRAME_2]: 6 },
    });
  });

  it('takes the max of the per-frame count and the previous active entry', () => {
    expect(
      advanceFrameEntry(
        {
          activeFrameKey: FRAME_1,
          activeEntry: 2,
          frameEntryCounts: { [FRAME_1]: 2, [FRAME_2]: 9 },
        },
        FRAME_2,
        false,
      ).activeEntry,
    ).toBe(10);
  });

  it('never lowers a recorded count', () => {
    const next = advanceFrameEntry(
      { activeFrameKey: FRAME_2, activeEntry: 3, frameEntryCounts: { [FRAME_1]: 7, [FRAME_2]: 3 } },
      FRAME_2,
      false,
    );
    expect(next.frameEntryCounts).toEqual({ [FRAME_1]: 7, [FRAME_2]: 3 });
  });

  it('does not mutate the coordinates it is given', () => {
    const counts = { [FRAME_1]: 1 };
    const coords = { activeFrameKey: FRAME_1, activeEntry: 1, frameEntryCounts: counts };
    advanceFrameEntry(coords, FRAME_2, false);
    expect(counts).toEqual({ [FRAME_1]: 1 });
  });

  it('bootstraps rather than switching when the frame key is recorded but the entry is not', () => {
    // Both disjuncts of the bootstrap predicate matter independently. A missing
    // `activeEntry` alongside a recorded `activeFrameKey` must still bootstrap
    // even though the frame is changing, because the switch arm reads
    // `activeEntry` arithmetically and has nothing to add to.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: undefined, frameEntryCounts: { [FRAME_1]: 5 } },
        FRAME_2,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_2,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 5, [FRAME_2]: 1 },
    });
  });

  it('bootstraps when the entry is recorded but the frame key is not', () => {
    // The other half of the bootstrap predicate. With no `activeFrameKey` there
    // is no frame the entry can be said to belong to, so the switch arm must not
    // claim this as a frame change and add one to it.
    expect(
      advanceFrameEntry(
        { activeFrameKey: undefined, activeEntry: 5, frameEntryCounts: { [FRAME_1]: 5 } },
        FRAME_1,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 5,
      frameEntryCounts: { [FRAME_1]: 5 },
    });
  });

  it('carries a same-frame entry through in preference to the recorded count', () => {
    // The carry-through arm returns the ACTIVE entry, not the frame's recorded
    // count, when the two disagree.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 1, frameEntryCounts: { [FRAME_1]: 3 } },
        FRAME_1,
        false,
      ).activeEntry,
    ).toBe(1);
  });

  it('normalises a non-positive persisted entry up to the recorded count', () => {
    // Preserves `deriveActiveEntryProjection`'s `if (!entry || entry < 1)`
    // clamp verbatim. Reachable only from corrupt persisted state, but the
    // clamp is the reason an entry ordinal can never be 0 or negative.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 0, frameEntryCounts: { [FRAME_1]: 4 } },
        FRAME_1,
        false,
      ).activeEntry,
    ).toBe(4);
  });

  it('normalises a non-positive persisted entry to 1 when the frame has no recorded count', () => {
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 0, frameEntryCounts: {} },
        FRAME_1,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });
});
