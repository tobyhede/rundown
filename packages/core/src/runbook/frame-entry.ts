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
