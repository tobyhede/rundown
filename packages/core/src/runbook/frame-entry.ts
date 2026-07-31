import type { FrameKey } from './targeting.js';
import type { RunbookState } from './types.js';

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
export function inferFrameEntryFromState(state: RunbookState, frameKey: FrameKey): number {
  return state.activeFrameKey === frameKey && state.activeEntry !== undefined
    ? state.activeEntry
    : (state.frameEntryCounts?.[frameKey] ?? 1);
}
