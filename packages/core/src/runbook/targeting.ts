import type { StepPosition } from '../cli/types.js';
import type { ForContext, ResolvedCompletion, RunbookState, SubstepState } from './types.js';
import type { VariableValue } from './effective-vars.js';
import type { DelegationTokenHash } from './delegation-token.js';

/**
 * Sentinel entry value for pre-recorded completions targeting non-active frames.
 *
 * Entry=0 means "matches any visit to this frame." The drain's exact-entry
 * matching is preserved for inline completions (re-entry isolation), while
 * pre-recorded completions use the sentinel for frame-only matching.
 */
export const SENTINEL_ENTRY = 0;

/**
 * Nominal string type for frame identity keys.
 *
 * Format: `<step>|<iteration-or-empty>` (e.g., `"1|"`, `"1|2"`).
 * Construct only via {@link buildFrameKey} or {@link parseCompletionKey}.
 */
export type FrameKey = string & { readonly __brand: 'FrameKey' };

/**
 * Runtime frame target used when constructing completion identities.
 *
 * Active frames are the current cursor and active entry. Exact frames carry a
 * known historical/linkage entry that is not necessarily current. Inactive
 * frames carry only a frame key and persist with the sentinel entry.
 */
export type Frame =
  | { readonly kind: 'active'; readonly frameKey: FrameKey; readonly entry: number }
  | { readonly kind: 'exact'; readonly frameKey: FrameKey; readonly entry: number }
  | { readonly kind: 'inactive'; readonly frameKey: FrameKey };

/**
 * Validate that a frame entry is a positive integer.
 *
 * Entries must be >= 1; entry=0 is reserved for {@link SENTINEL_ENTRY}, and
 * negatives/NaN/non-integer values would produce invalid completion keys.
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
 * Resolve the completion entry used for persistence.
 *
 * @param frame - Frame target
 * @returns Exact entry for active/exact frames, otherwise the sentinel entry
 */
export function completionEntryForFrame(frame: Frame): number {
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
 * Runtime completion identity key.
 *
 * Format: `<frameKey>|<entry>|<substep-or-empty>`
 *
 * @param frame - Frame target
 * @param substep - Optional substep identifier
 * @returns Pipe-delimited completion key
 */
export function buildCompletionKey(frame: Frame, substep?: string): string {
  return `${frame.frameKey}|${String(completionEntryForFrame(frame))}|${substep ?? ''}`;
}

/**
 * Parse a completion key into frame/entry/substep components.
 *
 * @param key - Pipe-delimited completion key to parse
 * @returns Parsed components, or null if the key format is invalid
 */
export function parseCompletionKey(
  key: string,
): { frameKey: FrameKey; entry: number; substep?: string } | null {
  const parts = key.split('|');
  if (parts.length !== 4) return null;
  const [step, iterationRaw, entryRaw, substepRaw] = parts;
  if (!step || !entryRaw) return null;
  if (!/^\d+$/.test(entryRaw)) return null;
  const entry = Number(entryRaw);
  const frameKey = `${step}|${iterationRaw}` as FrameKey;
  return {
    frameKey,
    entry,
    ...(substepRaw ? { substep: substepRaw } : {}),
  };
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
    frameKey: buildFrameKey(state.step, activeFor?.iteration),
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
 * Build a ResolvedCompletion with conditional optional fields and defaulted completedAt.
 *
 * @param fields - Completion fields; `targetSubstep`, `targetIteration`, and `completedAt` are optional
 * @param fields.agentId - Identifier of the agent that produced the completion
 * @param fields.result - Whether the completion passed or failed
 * @param fields.targetStep - Step name this completion targets
 * @param fields.targetSubstep - Optional substep ID within the target step
 * @param fields.targetIteration - Optional FOR loop iteration number
 * @param fields.targetFrame - Frame target identifying the completion scope
 * @param fields.finalVars - Optional final variables produced by a child runbook
 * @param fields.completedAt - ISO 8601 timestamp (defaults to current time)
 * @returns A fully-formed ResolvedCompletion
 */
export function buildResolvedCompletion(fields: {
  agentId: string;
  result: 'pass' | 'fail';
  targetStep: string;
  targetSubstep?: string;
  targetIteration?: number;
  targetFrame: Frame;
  finalVars?: Readonly<Record<string, VariableValue>>;
  completedAt?: string;
}): ResolvedCompletion {
  return {
    agentId: fields.agentId,
    result: fields.result,
    targetStep: fields.targetStep,
    ...(fields.targetSubstep ? { targetSubstep: fields.targetSubstep } : {}),
    ...(fields.targetIteration !== undefined ? { targetIteration: fields.targetIteration } : {}),
    targetFrameKey: fields.targetFrame.frameKey,
    targetEntry: completionEntryForFrame(fields.targetFrame),
    ...(fields.finalVars ? { finalVars: fields.finalVars } : {}),
    completedAt: fields.completedAt ?? new Date().toISOString(),
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
 * The parent-side linkage fields a delegation-liveness decision depends on.
 *
 * Structurally a `Pick` of the persisted delegation-claim linkage, declared here
 * rather than imported from `claim-id.ts` to keep `targeting.ts` free of a claim
 * import cycle. Both transaction paths (the claim-side refusal and the
 * parent-commit invalidation hook) pass exactly these fields.
 */
export interface DelegationLivenessLinkage {
  /** Parent step name captured at delegation time (e.g. "1"). */
  readonly parentStep: string;
  /** Parent step/substep id where the delegation originated. */
  readonly parentStepId: string;
  /** Parent execution frame key at delegation time. */
  readonly parentFrameKey: FrameKey;
  /** Parent frame entry counter captured at delegation time. */
  readonly parentEntry: number;
  /** Hash of the delegation token that produced the child claim. */
  readonly tokenHash: DelegationTokenHash;
}

/**
 * Whether a delegated child claim is still live against its parent state.
 *
 * `parent-unreadable` is a hard database-integrity signal — a delegated claim
 * naming a parent that cannot be read is invalid state, never a routine
 * closed outcome. Callers must not treat it as live or fall through.
 */
export type DelegationLiveness =
  | { readonly kind: 'live'; readonly substep: SubstepState }
  | {
      readonly kind: 'closed';
      readonly reason: 'parent-ended' | 'cursor-advanced' | 'resolved' | 'token-reissued';
    }
  | { readonly kind: 'parent-unreadable' };

/**
 * Classify whether a delegated child claim is still live in the parent's
 * committed state. The single source of truth shared by the claim-side refusal
 * and the parent-commit invalidation hook.
 *
 * A delegation is live only when the parent exists and is non-terminal, its
 * cursor still sits on the delegating step, the matching substep exists and is
 * neither resolved nor cancelled, that substep still carries the same delegation
 * token, and — where the persisted frame carries a current entry — that entry
 * still matches the one captured at delegation time. Any divergence is a closed
 * outcome; this deliberately does NOT reduce to `status !== 'done'`, which would
 * miss the top-level cursor-advance path that writes no `done` substep row.
 *
 * @param parent - Parent run state read inside the deciding transaction, or null when absent.
 * @param linkage - Parent-side linkage fields captured on the delegated claim.
 * @returns The three-way liveness classification.
 */
export function classifyDelegationLiveness(
  parent: RunbookState | null,
  linkage: DelegationLivenessLinkage,
): DelegationLiveness {
  if (parent === null) {
    return { kind: 'parent-unreadable' };
  }
  if (parent.lifecycle === 'completed' || parent.lifecycle === 'stopped') {
    return { kind: 'closed', reason: 'parent-ended' };
  }
  if (parent.step !== linkage.parentStep) {
    return { kind: 'closed', reason: 'cursor-advanced' };
  }
  const substep = findSubstepState(
    parent.substepStates ?? [],
    linkage.parentStepId,
    linkage.parentFrameKey,
  );
  if (substep === undefined) {
    return { kind: 'closed', reason: 'cursor-advanced' };
  }
  if (substep.status === 'done') {
    return { kind: 'closed', reason: 'resolved' };
  }
  const delegation = substep.delegation;
  if (delegation === undefined) {
    return { kind: 'closed', reason: 'token-reissued' };
  }
  if (delegation.tokenHash !== linkage.tokenHash) {
    return { kind: 'closed', reason: 'token-reissued' };
  }
  if (delegation.cancelledAt !== null) {
    return { kind: 'closed', reason: 'resolved' };
  }
  // Entry identity: a frame revisited via GOTO/loop re-entry advances its entry
  // counter past the value captured on the claim. Compare only when the frame
  // carries a current entry; a frame with no recorded entry cannot mismatch.
  const currentEntry =
    parent.activeFrameKey === linkage.parentFrameKey && parent.activeEntry !== undefined
      ? parent.activeEntry
      : parent.frameEntryCounts?.[linkage.parentFrameKey];
  if (currentEntry !== undefined && currentEntry !== linkage.parentEntry) {
    return { kind: 'closed', reason: 'cursor-advanced' };
  }
  return { kind: 'live', substep };
}

/**
 * Replace-or-append a whole substep entry into an array, keyed by `(id,
 * frameKey)`.
 *
 * Replaces the entry matching the supplied entry's `(id, frameKey)` pair, or
 * appends it when none matches. Pure; returns a new array and leaves every other
 * entry untouched. This is the merge primitive a locked read-modify-write uses
 * to commit one issued substep entry without clobbering concurrent writes to
 * sibling substeps (see `RunbookStateManager.updateWithState`). Distinct from
 * {@link upsertSubstepState}, which merges a field patch onto an entry; this
 * substitutes the entry wholesale.
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

type SubstepStatePatch = Partial<Pick<SubstepState, 'status' | 'delegation' | 'inline'>> & {
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
