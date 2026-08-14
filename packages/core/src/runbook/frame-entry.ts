import { activeFrame, deriveActiveFrame, type Frame, type FrameKey } from './targeting.js';
import type { RunbookState } from './types.js';

/**
 * The exact persisted fields {@link inferFrameEntryFromState} reads.
 *
 * Deliberately as loose as `RunbookState` itself: this is what a *reader*
 * accepts, and persisted state genuinely arrives with each field independently
 * present or absent. Every branch of the inference already covers that. What
 * the machine *carries* is the stricter {@link FrameEntryCoordinates}.
 */
export type FrameEntryReadModel = Pick<
  RunbookState,
  'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'
>;

/**
 * Frame-entry coordinates for a frame that has been entered.
 *
 * `activeEntry` is meaningless without the `activeFrameKey` that says which
 * frame it belongs to — pairing it with a different frame silently attributes
 * one frame's entry to another — so the two are required together.
 */
export interface ActiveFrameEntryCoordinates {
  /** Frame the cursor currently occupies. */
  readonly activeFrameKey: FrameKey;
  /** Entry ordinal of {@link ActiveFrameEntryCoordinates.activeFrameKey}. */
  readonly activeEntry: number;
  /** Highest entry ordinal recorded for each frame the run has entered. */
  readonly frameEntryCounts?: Readonly<Record<FrameKey, number>>;
}

/**
 * Frame-entry coordinates before any frame has been entered.
 *
 * Both halves of the pair are absent together. `frameEntryCounts` may still
 * carry history: a run rehydrated from persisted state knows what each frame
 * reached without yet naming a current one.
 */
export interface BootstrapFrameEntryCoordinates {
  /** Never set: a bootstrap coordinate names no current frame. */
  readonly activeFrameKey?: undefined;
  /** Never set: there is no frame for an entry ordinal to belong to. */
  readonly activeEntry?: undefined;
  /** Highest entry ordinal recorded for each frame the run has entered. */
  readonly frameEntryCounts?: Readonly<Record<FrameKey, number>>;
}

/**
 * Frame-entry coordinates as the machine carries them.
 *
 * Named so a caller that has to carry the coordinates across a boundary — the
 * XState machine mirrors them into `RunbookContext` at actor bootstrap — carries
 * all three together. The union makes the pairing structural rather than a
 * documented convention: `{ activeEntry: 5 }` with no frame key does not
 * typecheck, so {@link advanceFrameEntry} does not have to defend that hole at
 * runtime and its bootstrap branch is a single narrowing check.
 */
export type FrameEntryCoordinates = ActiveFrameEntryCoordinates | BootstrapFrameEntryCoordinates;

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
export function inferFrameEntryFromState(state: FrameEntryReadModel, frameKey: FrameKey): number {
  return state.activeFrameKey === frameKey && state.activeEntry !== undefined
    ? state.activeEntry
    : (state.frameEntryCounts?.[frameKey] ?? 1);
}

/**
 * The frame target a run's live cursor resolves completion rows against.
 *
 * The single derivation of "where the drain is standing", so the resolved-
 * completion drain and the delegation collection-pending guard cannot disagree
 * about it (#749). Pair it with `completionTargetsFrame` to decide whether a
 * persisted row is reachable from here.
 *
 * The frame key is the persisted one, falling back to the cursor derivation for
 * a state that carries none. The active entry is authoritative for it — the two
 * name the same frame by construction — and {@link inferFrameEntryFromState}
 * owns the fallback to the frame's recorded count.
 *
 * @param state - Runbook state whose live cursor is read
 * @returns The active frame the cursor occupies, entry included
 * @throws {RangeError} When the inferred entry is not a positive integer, which
 *   persisted state cannot produce (the schema admits positive integers only).
 */
export function deriveActiveCompletionFrame(state: RunbookState): Frame {
  const frameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  return activeFrame(frameKey, state.activeEntry ?? inferFrameEntryFromState(state, frameKey));
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
 * - No frame entered yet (bootstrap): the entry is the frame's recorded count,
 *   or `1` when it has none. One narrowing check, not two — the union pairs
 *   `activeFrameKey` and `activeEntry`, so neither can be absent alone.
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
 * @returns New coordinates naming `frameKey` as active; the input is never mutated.
 */
export function advanceFrameEntry(
  coordinates: FrameEntryCoordinates,
  frameKey: FrameKey,
  reentered: boolean,
): ActiveFrameEntryCoordinates {
  const frameEntryCounts: Record<FrameKey, number> = { ...(coordinates.frameEntryCounts ?? {}) };
  const known = frameEntryCounts[frameKey] ?? 0;
  let entry: number;
  if (coordinates.activeFrameKey === undefined) {
    entry = known > 0 ? known : 1;
  } else if (reentered || frameKey !== coordinates.activeFrameKey) {
    entry = Math.max(known, coordinates.activeEntry) + 1;
  } else {
    entry = coordinates.activeEntry >= 1 ? coordinates.activeEntry : known > 0 ? known : 1;
  }
  frameEntryCounts[frameKey] = Math.max(known, entry);
  return { activeFrameKey: frameKey, activeEntry: entry, frameEntryCounts };
}
