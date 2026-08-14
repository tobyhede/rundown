import {
  advanceFrameEntry,
  deriveActiveCompletionFrame,
  inferFrameEntryFromState,
} from '../../src/runbook/frame-entry.js';
import type { FrameEntryCoordinates } from '../../src/runbook/frame-entry.js';
import type { RunbookState } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

describe('FrameEntryCoordinates', () => {
  const FRAME = buildFrameKey('1');

  it('pairs the frame key and the entry structurally', () => {
    // `activeEntry` is meaningless without the `activeFrameKey` that says which
    // frame it belongs to, and an `activeFrameKey` with no entry is a frame
    // nothing has been recorded for. Both halves travel together or neither
    // does — the type says so, so `advanceFrameEntry` does not have to defend
    // the hole at runtime.
    const bootstrap: FrameEntryCoordinates = { frameEntryCounts: { [FRAME]: 3 } };
    const active: FrameEntryCoordinates = {
      activeFrameKey: FRAME,
      activeEntry: 3,
      frameEntryCounts: { [FRAME]: 3 },
    };
    expect(bootstrap.activeEntry).toBeUndefined();
    expect(active.activeEntry).toBe(3);

    // @ts-expect-error an entry with no frame key is not a coordinate
    const entryWithoutFrame: FrameEntryCoordinates = { activeEntry: 5 };
    // @ts-expect-error a frame key with no entry is not a coordinate
    const frameWithoutEntry: FrameEntryCoordinates = { activeFrameKey: FRAME };
    // @ts-expect-error an explicitly undefined entry does not satisfy the pair
    const halfPaired: FrameEntryCoordinates = { activeFrameKey: FRAME, activeEntry: undefined };
    expect([entryWithoutFrame, frameWithoutEntry, halfPaired]).toHaveLength(3);
  });
});

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

describe('deriveActiveCompletionFrame', () => {
  const frameKey = buildFrameKey('1');

  it('names the persisted active frame and entry', () => {
    const state = {
      step: '1',
      activeFrameKey: frameKey,
      activeEntry: 2,
      frameEntryCounts: { [frameKey]: 2 },
    } as RunbookState;

    expect(deriveActiveCompletionFrame(state)).toEqual({
      kind: 'active',
      frameKey,
      entry: 2,
    });
  });

  it('falls back to the frame entry counter when no active entry is persisted', () => {
    const state = {
      step: '1',
      activeFrameKey: frameKey,
      frameEntryCounts: { [frameKey]: 3 },
    } as RunbookState;

    expect(deriveActiveCompletionFrame(state)).toEqual({
      kind: 'active',
      frameKey,
      entry: 3,
    });
  });

  it('derives the frame key from the cursor when none is persisted', () => {
    const state = { step: '1', forStack: [] } as unknown as RunbookState;

    expect(deriveActiveCompletionFrame(state)).toEqual({
      kind: 'active',
      frameKey,
      entry: 1,
    });
  });

  it('derives the FOR-scoped frame key from the live stack', () => {
    const state = {
      step: '1',
      forStack: [
        { stepId: '1', iteration: 2, start: 1, end: 3, implicit: false, source: { kind: 'range' } },
      ],
      activeEntry: 4,
    } as unknown as RunbookState;

    expect(deriveActiveCompletionFrame(state)).toEqual({
      kind: 'active',
      frameKey: buildFrameKey('1', 2),
      entry: 4,
    });
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

  it('bootstraps to 1 when the frame has an empty recorded history', () => {
    // The bootstrap arm's `known > 0` test: an empty `frameEntryCounts` is not
    // the same input as an absent one, and both must land on 1.
    expect(advanceFrameEntry({ frameEntryCounts: {} }, FRAME_1, false)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 1 },
    });
  });

  it('bootstraps to another frame recorded count without claiming it as the entry', () => {
    // Bootstrap reads the count of the frame being ENTERED, not the highest
    // count in the map.
    expect(advanceFrameEntry({ frameEntryCounts: { [FRAME_2]: 9 } }, FRAME_1, false)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_2]: 9, [FRAME_1]: 1 },
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

  it('bootstraps into a different frame without claiming a switch', () => {
    // What the two half-paired cases used to prove, now that the type makes
    // them unrepresentable: bootstrap never takes the switch arm, so it never
    // adds one to an entry it does not have. The frame it enters differs from
    // every frame in the recorded history.
    expect(advanceFrameEntry({ frameEntryCounts: { [FRAME_1]: 5 } }, FRAME_2, false)).toEqual({
      activeFrameKey: FRAME_2,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 5, [FRAME_2]: 1 },
    });
  });

  it('bootstraps to the entered frame recorded count even when re-entry is declared', () => {
    // `reentered` is only consulted once a frame is active. From bootstrap it
    // must not add one, or a rehydrated run's first GOTO would skip an ordinal.
    expect(advanceFrameEntry({ frameEntryCounts: { [FRAME_1]: 5 } }, FRAME_1, true)).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 5,
      frameEntryCounts: { [FRAME_1]: 5 },
    });
  });

  it('carries a same-frame entry through in preference to the recorded count', () => {
    // The carry-through arm returns the ACTIVE entry, not the frame's recorded
    // count, when the two disagree.
    //
    // This is also the only fixture where `known > entry`, so it is the one that
    // can prove the `Math.max(known, entry)` floor on the recorded count: with
    // `known === entry` the max is indistinguishable from either operand. A
    // count that followed the entry down would let `inferFrameEntryFromState`
    // answer a lower ordinal for this frame than a credential already stamped
    // in it, so the whole assignment is asserted, not just `.activeEntry`.
    expect(
      advanceFrameEntry(
        { activeFrameKey: FRAME_1, activeEntry: 1, frameEntryCounts: { [FRAME_1]: 3 } },
        FRAME_1,
        false,
      ),
    ).toEqual({
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      frameEntryCounts: { [FRAME_1]: 3 },
    });
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
