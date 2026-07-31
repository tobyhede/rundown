import { inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
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
