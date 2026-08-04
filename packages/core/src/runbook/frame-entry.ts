import type { FrameKey } from './targeting.js';
import type { RunbookState } from './types.js';

/**
 * The exact persisted fields {@link inferFrameEntryFromState} reads.
 *
 * Named so a caller that has to carry the coordinates across a boundary — the
 * XState machine mirrors them into `RunbookContext` at actor bootstrap — carries
 * all three together. `activeEntry` is meaningless without the
 * `activeFrameKey` that says which frame it belongs to: pairing it with a
 * different frame silently attributes one frame's entry to another.
 */
export type FrameEntryCoordinates = Pick<
  RunbookState,
  'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'
>;

/**
 * Infer the current entry number for a runbook frame.
 *
 * The active entry is authoritative for the active frame. Otherwise the last
 * recorded entry is used, defaulting to the initial entry when no history is
 * available.
 *
 * @param state - Persisted runbook state containing frame entry history.
 * @param frameKey - Frame whose current entry should be inferred.
 * @returns The frame's active or recorded entry, defaulting to `1`.
 */
export function inferFrameEntryFromState(state: FrameEntryCoordinates, frameKey: FrameKey): number {
  return state.activeFrameKey === frameKey && state.activeEntry !== undefined
    ? state.activeEntry
    : (state.frameEntryCounts?.[frameKey] ?? 1);
}

/**
 * Advance the frame-entry coordinates for one state entry.
 *
 * The single owner of the entry bump rule. Semantics are preserved verbatim
 * from the projection this replaces (`deriveActiveEntryProjection`): the entry
 * ordinal is run-global and monotonic, not per-frame-local, so entering a fresh
 * frame from entry 5 yields 6 rather than 1. `classifyDelegationLiveness` and
 * completion-key scoping are calibrated against that form — do not "fix" it to
 * a per-frame counter.
 *
 * - No recorded active frame or no recorded active entry (bootstrap): the entry
 *   is the frame's recorded count, or `1` when it has none.
 * - Frame switch, or a re-entry the transition declared: one past the greater of
 *   the frame's recorded count and the previous active entry.
 * - Otherwise the active entry carries through unchanged.
 *
 * In every case the frame's recorded count is raised to the resulting entry and
 * never lowered.
 *
 * @param coordinates - The coordinates before this state entry.
 * @param frameKey - The frame being entered, from `frameKeyForCursor`.
 * @param reentered - Whether the transition declared this a GOTO/RETRY re-entry.
 * @returns New coordinates; the input is never mutated.
 */
export function advanceFrameEntry(
  coordinates: FrameEntryCoordinates,
  frameKey: FrameKey,
  reentered: boolean,
): FrameEntryCoordinates {
  const frameEntryCounts: Record<FrameKey, number> = { ...(coordinates.frameEntryCounts ?? {}) };
  const known = frameEntryCounts[frameKey] ?? 0;
  let entry: number;
  if (coordinates.activeFrameKey === undefined || coordinates.activeEntry === undefined) {
    entry = known > 0 ? known : 1;
  } else if (reentered || frameKey !== coordinates.activeFrameKey) {
    entry = Math.max(known, coordinates.activeEntry) + 1;
  } else {
    entry = coordinates.activeEntry >= 1 ? coordinates.activeEntry : known > 0 ? known : 1;
  }
  frameEntryCounts[frameKey] = Math.max(known, entry);
  return { activeFrameKey: frameKey, activeEntry: entry, frameEntryCounts };
}
