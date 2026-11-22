import type { StepPosition } from '../cli/types.js';
import type { ChildReservation, ForContext, RunbookState, SubstepState } from './types.js';

/**
 * Sentinel entry value for a frame target that names no specific entry.
 *
 * Entry=0 means "matches any visit to this frame." Real entries start at 1
 * (`advanceFrameEntry`), so the two ranges cannot collide.
 */
export const SENTINEL_ENTRY = 0;

/**
 * Nominal string type for frame identity keys.
 *
 * Format: `<step>|<iteration-or-empty>` (e.g., `"1|"`, `"1|2"`).
 * Construct only via {@link buildFrameKey}.
 */
export type FrameKey = string & { readonly __brand: 'FrameKey' };

/**
 * Runtime frame target.
 *
 * Active frames are the current cursor and active entry. Exact frames carry a
 * known historical entry that is not necessarily current. Inactive frames carry
 * only a frame key and resolve to the sentinel entry.
 */
export type Frame =
  | { readonly kind: 'active'; readonly frameKey: FrameKey; readonly entry: number }
  | { readonly kind: 'exact'; readonly frameKey: FrameKey; readonly entry: number }
  | { readonly kind: 'inactive'; readonly frameKey: FrameKey };

/**
 * Validate that a frame entry is a positive integer.
 *
 * Entries must be >= 1; entry=0 is reserved for {@link SENTINEL_ENTRY}, and
 * negatives/NaN/non-integer values would produce invalid frame targets.
 *
 * @param entry - Entry value to validate
 * @param kind - Frame kind for error reporting
 * @throws {RangeError} When entry is not a positive integer
 */
function assertPositiveEntry(entry: number, kind: 'active' | 'exact'): void {
  if (!Number.isInteger(entry) || entry < 1) {
    throw new RangeError(`${kind} frame entry must be a positive integer, got ${String(entry)}`);
  }
}

/**
 * Construct a frame for the current active cursor.
 *
 * @param frameKey - Current active frame key
 * @param entry - Current active entry (must be a positive integer)
 * @returns Active frame target
 * @throws {RangeError} When `entry` is not a positive integer
 */
export function activeFrame(frameKey: FrameKey, entry: number): Frame {
  assertPositiveEntry(entry, 'active');
  return { kind: 'active', frameKey, entry };
}

/**
 * Construct a frame with a known exact entry that is not necessarily current.
 *
 * @param frameKey - Target frame key
 * @param entry - Known entry for the target frame (must be a positive integer)
 * @returns Exact frame target
 * @throws {RangeError} When `entry` is not a positive integer
 */
export function exactFrame(frameKey: FrameKey, entry: number): Frame {
  assertPositiveEntry(entry, 'exact');
  return { kind: 'exact', frameKey, entry };
}

/**
 * Construct a frame-only target with no reliable entry.
 *
 * @param frameKey - Target frame key
 * @returns Inactive frame target
 */
export function inactiveFrame(frameKey: FrameKey): Frame {
  return { kind: 'inactive', frameKey };
}

/**
 * Determine whether a frame carries an exact entry.
 *
 * @param frame - Frame target to inspect
 * @returns True when the frame includes an entry
 */
export function frameHasExactEntry(
  frame: Frame,
): frame is Extract<Frame, { kind: 'active' | 'exact' }> {
  return frame.kind === 'active' || frame.kind === 'exact';
}

/**
 * Resolve the entry a frame target names.
 *
 * @param frame - Frame target
 * @returns Exact entry for active/exact frames, otherwise the sentinel entry
 */
export function entryForFrame(frame: Frame): number {
  return frameHasExactEntry(frame) ? frame.entry : SENTINEL_ENTRY;
}

/**
 * Derive execution location notation for runtime targets.
 *
 * - Non-loop step/substep: `STEP.SUBSTEP` (for example, `2.1`)
 * - Loop-scoped step/substep: `STEP.INDEX.SUBSTEP` (for example, `1.2.1`)
 *
 * @param step - Step identifier (e.g. "1", "ErrorHandler")
 * @param substep - Optional substep identifier within the step
 * @param iteration - Optional FOR loop iteration number
 * @returns Dot-separated location string (e.g. "2.1", "1.2.1")
 */
export function deriveExecutionAt(step: string, substep?: string, iteration?: number): string {
  if (iteration !== undefined) {
    return substep ? `${step}.${String(iteration)}.${substep}` : `${step}.${String(iteration)}`;
  }
  return substep ? `${step}.${substep}` : step;
}

/**
 * Derive execution location notation for a position payload.
 *
 * @param position - Position object with current step, optional substep and FOR context
 * @param position.current - Current step identifier
 * @param position.substep - Optional substep identifier
 * @param position.for - Optional FOR loop context
 * @param position.for.index - Iteration index within the FOR loop
 * @returns Dot-separated location string
 */
export function derivePositionAt(position: {
  current: string;
  substep?: string;
  for?: { index: number };
}): string {
  return deriveExecutionAt(position.current, position.substep, position.for?.index);
}

/**
 * Canonical runtime key for target identity.
 *
 * Format: `<step>|<substep-or-empty>|<iteration-or-empty>`
 *
 * @param step - Step identifier
 * @param substep - Optional substep identifier
 * @param iteration - Optional FOR loop iteration number
 * @returns Pipe-delimited target key
 */
export function buildTargetKey(step: string, substep?: string, iteration?: number): string {
  return `${step}|${substep ?? ''}|${iteration !== undefined ? String(iteration) : ''}`;
}

/**
 * Runtime frame identity key.
 *
 * Format: `<step>|<iteration-or-empty>`
 *
 * @param step - Step identifier
 * @param iteration - Optional FOR loop iteration number
 * @returns Pipe-delimited frame key
 */
export function buildFrameKey(step: string, iteration?: number): FrameKey {
  const iterationPart = iteration !== undefined ? String(iteration) : '';
  return `${step}|${iterationPart}` as FrameKey;
}

/**
 * Whether a string has the shape every {@link buildFrameKey} result matches:
 * `<step>|<iteration-or-empty>`.
 *
 * Lives beside {@link buildFrameKey} so the format has one owner — a pattern
 * restated at a consumer would drift the day the format changes. `FrameKeySchema`
 * in `schemas.ts` is its sole caller, refusing every malformed frame key that
 * arrives from the untrusted persisted-state edge.
 *
 * The step segment is any run of non-pipe characters: what a step may be *named*
 * is the parser's constraint, not this format's.
 *
 * @param value - Raw frame key string.
 * @returns Whether the value is well-formed.
 */
export function isFrameKey(value: string): value is FrameKey {
  return /^[^|]+\|(?:\d+)?$/.test(value);
}

/**
 * Get the active FOR context for the current step, if present.
 *
 * Implicit synthetic contexts are not exposed as loop scope.
 *
 * @param forStack - Current FOR context stack
 * @param step - Step identifier to match against the top context
 * @returns The active FOR context, or undefined if none applies
 */
export function getActiveForContext(
  forStack: readonly ForContext[] | undefined,
  step: string,
): ForContext | undefined {
  if (!forStack || forStack.length === 0) return undefined;
  const top = forStack[forStack.length - 1];
  if (top.implicit || top.stepId !== step) return undefined;
  return top;
}

/**
 * Derive the frame key for an execution cursor.
 *
 * The single frame-key derivation. It replaces a family of subtly different
 * ones that agreed only by accident: `deriveActiveFrame` checked both
 * `implicit` and `stepId`, while `deriveActorStatePatch`,
 * `buildSubstepGotoResetAssignValue` and the parent-retry assigns filtered
 * `implicit` but never compared `stepId`. Once the machine's entry ordinal depends on the
 * frame key matching what committed-state readers compute, that accident
 * becomes load-bearing, so every cursor-keyed site routes here.
 *
 * They coincide for every stack `initForStack` can build today — it always
 * returns a single-element stack naming the step being entered — so this is a
 * guarantee replacing an accident, not a live repair. `targeting.test.ts` pins
 * each consumer against a stack whose top names a foreign step, and scans
 * `src/runbook` for any site that re-derives the iteration from a raw stack
 * top.
 *
 * @param stepName - The step the cursor sits on.
 * @param forStack - The live FOR context stack, or undefined.
 * @returns The frame key: `step|iteration` when a non-implicit FOR context for
 *   this step is on top of the stack, otherwise `step|`.
 */
export function frameKeyForCursor(
  stepName: string,
  forStack: readonly ForContext[] | undefined,
): FrameKey {
  return buildFrameKey(stepName, getActiveForContext(forStack, stepName)?.iteration);
}

/**
 * Derive active runtime frame from persisted runbook state.
 *
 * @param state - Current runbook state
 * @returns Frame key, step, and optional iteration for the active frame
 */
export function deriveActiveFrame(state: RunbookState): {
  frameKey: FrameKey;
  step: string;
  iteration?: number;
} {
  const activeFor = getActiveForContext(state.forStack, state.step);
  return {
    frameKey: frameKeyForCursor(state.step, state.forStack),
    step: state.step,
    ...(activeFor ? { iteration: activeFor.iteration } : {}),
  };
}

/**
 * Opaque oracle answering whether a frame is currently OPEN.
 *
 * This is the sole authority for frame openness. It is constructed only from the
 * live FOR stack via {@link deriveOpenFrames}. The monotonic entry counter
 * (`RunbookState.frameEntryCounts`) deliberately cannot produce one — its keys
 * record that a frame was *ever* entered, never whether it is *open* — so
 * openness can never be answered from entry-count history. The `__brand` field
 * prevents a bare `Set<FrameKey>` (e.g. one built from entry-counter keys) from
 * structurally masquerading as an `OpenFrames`.
 */
export interface OpenFrames {
  /** Nominal brand; only {@link deriveOpenFrames} can mint an `OpenFrames`. */
  readonly __brand: 'OpenFrames';
  /**
   * Test whether a frame is currently open.
   *
   * @param frameKey - Frame key to test
   * @returns True when the frame is the active frame or a live (non-implicit)
   *   FOR context at its current iteration; false for closed/exited frames
   */
  has(frameKey: FrameKey): boolean;
}

/**
 * Derive the set of currently-open frames from the live execution stack.
 *
 * A frame is open when it is the active frame or a non-implicit FOR context on
 * the live `forStack` at its current iteration. Closed iterations and exited
 * loops are absent — even though their keys persist in the monotonic entry
 * counter — which is precisely why openness must be read from here, not from
 * that counter.
 *
 * @param state - Current runbook state
 * @returns Opaque openness oracle for the run's live frames
 */
export function deriveOpenFrames(state: RunbookState): OpenFrames {
  const open = new Set<FrameKey>();
  for (const context of state.forStack ?? []) {
    if (!context.implicit) {
      open.add(buildFrameKey(context.stepId, context.iteration));
    }
  }
  open.add(deriveActiveFrame(state).frameKey);
  return { __brand: 'OpenFrames', has: (frameKey) => open.has(frameKey) };
}

/**
 * Build a StepPosition enriched with optional loop scope and expanded path.
 *
 * @param current - Current step identifier
 * @param total - Total number of numbered steps in the runbook
 * @param substep - Optional active substep identifier
 * @param forStack - Optional FOR context stack for loop scope
 * @returns StepPosition with loop and substep fields populated as needed
 */
export function buildStepPosition(
  current: string,
  total: number,
  substep: string | undefined,
  forStack?: readonly ForContext[],
): StepPosition {
  const activeFor = getActiveForContext(forStack, current);

  return {
    current,
    total,
    ...(substep ? { substep } : {}),
    ...(activeFor
      ? {
          for: {
            index: activeFor.iteration,
            ...(activeFor.end !== undefined ? { end: activeFor.end } : {}),
          },
        }
      : {}),
  };
}

/**
 * Find a SubstepState by `(id, frameKey)`.
 *
 * Strict match: both `id` and `frameKey` must equal.
 *
 * @param substepStates - Array of substep states to search
 * @param substepId - Substep ID to match
 * @param frameKey - Frame key to match
 * @returns The matching SubstepState, or undefined
 */
export function findSubstepState(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: FrameKey,
): SubstepState | undefined {
  return substepStates.find((ss) => ss.id === substepId && ss.frameKey === frameKey);
}

/**
 * Replace-or-append a whole substep entry into an array, keyed by `(id,
 * frameKey)`.
 *
 * Replaces the entry matching the supplied entry's `(id, frameKey)` pair, or
 * appends it when none matches. Pure; returns a new array and leaves every other
 * entry untouched. Distinct from {@link upsertSubstepState}, which merges a
 * field patch onto an entry; this substitutes the entry wholesale.
 *
 * @param substepStates - Current substep states (the freshly-read array).
 * @param entry - The substep entry to replace-or-append by its `(id, frameKey)`.
 * @returns A new array with `entry` replacing-or-appended.
 */
export function replaceSubstepStateEntry(
  substepStates: readonly SubstepState[],
  entry: SubstepState,
): SubstepState[] {
  const index = substepStates.findIndex(
    (ss) => ss.id === entry.id && ss.frameKey === entry.frameKey,
  );
  if (index === -1) {
    return [...substepStates, entry];
  }
  return substepStates.map((ss, i) => (i === index ? entry : ss));
}

type SubstepStatePatch = Partial<Pick<SubstepState, 'status'>> & {
  readonly result?: SubstepState['result'] | undefined;
};

function applySubstepStatePatch(base: SubstepState, patch: SubstepStatePatch): SubstepState {
  const patched = { ...base, ...patch };
  if (Object.hasOwn(patch, 'result') && patch.result === undefined) {
    const { result, ...withoutResult } = patched;
    void result;
    return withoutResult;
  }
  return patched;
}

/**
 * Update an existing SubstepState by `(id, frameKey)` or append a new entry.
 *
 * If a matching entry exists, applies `patch` to it. If no match is found,
 * appends a new entry with `id`, `frameKey`, `status: 'pending'`, and the patch.
 * Passing `result: undefined` explicitly removes any existing result field.
 *
 * @param substepStates - Existing substep states array
 * @param substepId - Substep ID to match or create
 * @param frameKey - Frame key to match or create
 * @param patch - Fields to apply on the matched or new entry. An explicit
 * `result: undefined` removes the prior result.
 * @returns New array with the updated or appended entry
 */
export function upsertSubstepState(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: FrameKey,
  patch: SubstepStatePatch,
): readonly SubstepState[] {
  const existing = findSubstepState(substepStates, substepId, frameKey);
  if (existing) {
    return substepStates.map((ss) => (ss === existing ? applySubstepStatePatch(ss, patch) : ss));
  }
  return [
    ...substepStates,
    applySubstepStatePatch({ id: substepId, frameKey, status: 'pending' as const }, patch),
  ];
}

/**
 * Record a Current Child reservation on the substep state for `(id, frameKey)`,
 * appending a pending entry when the frame has none yet.
 *
 * Replaces any reservation the entry already carried; every other field and
 * every other entry is left untouched. Pure.
 *
 * @param substepStates - Existing substep states array
 * @param substepId - Substep the reservation is for
 * @param frameKey - Frame the reservation is made in
 * @param child - The reservation
 * @returns New array with the reservation recorded
 */
export function upsertSubstepStateChild(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: FrameKey,
  child: ChildReservation,
): readonly SubstepState[] {
  const existing = findSubstepState(substepStates, substepId, frameKey);
  if (existing) {
    return substepStates.map((ss) => (ss === existing ? { ...ss, child } : ss));
  }
  return [...substepStates, { id: substepId, frameKey, status: 'pending' as const, child }];
}

/**
 * Record that the parent Collected the Current Child reserved on `(id,
 * frameKey)`: the reservation keeps its identity and gains the Child Result.
 *
 * Pure. A substep state without a reservation is returned unchanged.
 *
 * @param substepStates - Existing substep states array
 * @param substepId - Substep the reservation is for
 * @param frameKey - Frame the reservation was made in
 * @param result - The Child Result Collected
 * @returns New array with the reservation marked collected
 */
export function recordChildCollected(
  substepStates: readonly SubstepState[],
  substepId: string,
  frameKey: FrameKey,
  result: 'pass' | 'fail',
): readonly SubstepState[] {
  return substepStates.map((ss) =>
    ss.id === substepId && ss.frameKey === frameKey && ss.child !== undefined
      ? { ...ss, child: { ...ss.child, collected: result } }
      : ss,
  );
}
