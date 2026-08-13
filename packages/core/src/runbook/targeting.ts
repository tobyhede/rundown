import type { StepPosition } from '../cli/types.js';
import type {
  DelegationLinkage,
  ForContext,
  ResolvedCompletion,
  RunbookState,
  SubstepState,
} from './types.js';
import type { VariableValue } from './effective-vars.js';
import type { DelegationTokenHash } from './delegation-token.js';
import type { ClaimRecord } from './claim-id.js';

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
 * Derive the frame key for an execution cursor.
 *
 * The single frame-key derivation. It replaces a family of subtly different
 * ones that agreed only by accident: `deriveActiveFrame` checked both
 * `implicit` and `stepId`, while `deriveActorStatePatch`,
 * `buildDelegationIssueInvokeBlock`, `buildInlineLaunchInvokeBlock`,
 * `buildSubstepGotoResetAssignValue` and `runRetryHook` filtered `implicit` but
 * never compared `stepId`. Once the machine's entry ordinal depends on the
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

/** The authority coordinates shared by child linkage and delegated claims. */
export type DelegationAuthorityCoordinates = Omit<DelegationLinkage, 'kind'>;

const DELEGATION_AUTHORITY_COORDINATES = {
  parentRunId: true,
  parentStepId: true,
  parentStep: true,
  parentFrameKey: true,
  parentEntry: true,
  tokenHash: true,
} as const satisfies Record<keyof DelegationAuthorityCoordinates, true>;

const DELEGATION_AUTHORITY_COORDINATE_KEYS = Object.keys(
  DELEGATION_AUTHORITY_COORDINATES,
) as (keyof DelegationAuthorityCoordinates)[];

/**
 * Compare every coordinate that grants authority over a delegated child.
 *
 * Keeping the field set in one dependency-free predicate prevents claim-mint
 * and claim-resolution checks from drifting apart when the linkage schema
 * changes.
 *
 * @param left - First authority-bearing linkage descriptor.
 * @param right - Second authority-bearing linkage descriptor.
 * @returns `true` only when all shared authority coordinates are equal.
 */
export function delegationAuthorityCoordinatesMatch(
  left: DelegationAuthorityCoordinates,
  right: DelegationAuthorityCoordinates,
): boolean {
  return DELEGATION_AUTHORITY_COORDINATE_KEYS.every((key) => left[key] === right[key]);
}

/**
 * The subset of authority coordinates that identify *which* delegation a claim
 * belongs to, as opposed to the scope it was granted over.
 *
 * NEITHER SUBSET CAN DISAGREE IN PRODUCTION. `claimRunbookInTransaction` refuses
 * unless the child's write-once `parentLinkage` equals the incoming linkage on
 * all six shared coordinates (`session-service.ts`, the `linkageMatchesLinkage`
 * gate), and the descriptor is then built field-by-field from that same incoming
 * linkage. The equality is established by that gate, not by the two being written
 * together — before it was widened, the replay and orphan-adoption paths minted a
 * descriptor from a recomputed coordinate and the pair genuinely diverged (#738).
 * Do not restate the invariant as a co-write: that reads as licence to delete the
 * check that creates it.
 *
 * So a claim reaching the parent-advance guards with ANY disagreement is either a
 * row written before that gate existed or a tampered `delegation_json`. The split
 * is a policy for failing safely once that has already happened, and the two
 * halves need opposite defaults because this guard EXCLUDES claims:
 *
 * - Identity disagreeing means the claim does not name this delegation at all.
 *   Holding the parent on it would wedge the run on a claim that was never about
 *   the delegation being advanced past, so it stays excluded.
 * - Identity agreeing while scope disagrees means the claim does name this
 *   delegation and only its granted scope is untrustworthy. Excluding it would
 *   release the parent past a child that may still be running, so it counts open.
 *
 * Do not read `token-reissued` as a legitimate source of identity drift.
 * `classifyDelegationLiveness` compares the claim against the PARENT SUBSTEP's
 * token, never against the child's `parentLinkage`, and a reissue rewrites
 * neither the child's write-once linkage nor an existing descriptor.
 */
const DELEGATION_IDENTITY_COORDINATE_KEYS = [
  'parentRunId',
  'parentStepId',
  'tokenHash',
] as const satisfies readonly (keyof DelegationAuthorityCoordinates)[];

/**
 * True when `linkage` names the same delegation as `claim`, ignoring the scope
 * coordinates (`parentStep`, `parentFrameKey`, `parentEntry`).
 *
 * Pairs with {@link linkageMatchesClaim} at the parent-advance guards, and is
 * consulted only once that predicate has already failed: identity still matching
 * means the claim names this delegation and is held open, identity failing means
 * it names a different one and stays excluded. See
 * {@link DELEGATION_IDENTITY_COORDINATE_KEYS} for why both states are
 * production-unreachable and why the two arms nonetheless need opposite defaults.
 *
 * @param linkage - Parent linkage stored on the child runbook state (any kind, including absent).
 * @param claim - Claim record whose delegation identity must match.
 * @returns `true` only when both are delegation-shaped and the three identity coordinates agree.
 */
export function linkageIdentifiesClaim(
  linkage: RunbookState['parentLinkage'],
  claim: ClaimRecord,
): boolean {
  const delegation = claim.delegation;
  if (!delegation || linkage?.kind !== 'delegation') {
    return false;
  }
  return DELEGATION_IDENTITY_COORDINATE_KEYS.every((key) => linkage[key] === delegation[key]);
}

/**
 * True when `linkage` is a delegation linkage that matches every authority
 * coordinate in `claim`'s delegation descriptor. Equality on all seven is a
 * consistency check, NOT a proof of provenance — the child's `parentLinkage` is
 * written at `manager.create` before any claim exists, and the descriptor is
 * later copied from a linkage, so neither can be said to originate from the
 * other. Do not restate this as verifying that the linkage came from the claim.
 *
 * ALL SIX SHARED COORDINATES ARE REQUIRED because the descriptor is also spread
 * into the claim's `report-delegation-result` grant, and
 * `claimCanReportDelegationResult` evaluates that grant against the CHILD ROW's
 * `parentLinkage`. A claim allowed to differ on `parentStep`, `parentFrameKey` or
 * `parentEntry` therefore holds authority it can never exercise: it resolves, it
 * drives the child to terminal, and the parent report is silently dropped (#738).
 *
 * Lives here (a dependency-free leaf) so claim consumers and the storage layer
 * reuse the identical predicate without a store → service import cycle. The
 * descriptor's `childRunId` is not repeated in
 * `ParentLinkage`; callers obtain the child through `claim.controlledRunId`, and
 * this predicate requires that id to equal `claim.delegation.childRunId` before
 * comparing the six coordinates shared with `ParentLinkage`.
 *
 * @param linkage - Parent linkage stored on the child runbook state (any kind, including absent).
 * @param claim - Claim record whose six shared delegation coordinates must all match.
 * @returns `true` only when the claim's child ids agree, `linkage.kind === 'delegation'`,
 *   and every shared field matches `claim`. A claim carrying no delegation
 *   descriptor returns `false` rather than throwing — `stashForClaimId` accepts a
 *   run-control bearer and relies on that, so the optional chain on `delegation`
 *   is load-bearing and is pinned by its own test.
 */
export function linkageMatchesClaim(
  linkage: RunbookState['parentLinkage'],
  claim: ClaimRecord,
): boolean {
  const delegation = claim.delegation;
  if (delegation?.childRunId !== claim.controlledRunId) {
    return false;
  }
  return linkage?.kind === 'delegation' && delegationAuthorityCoordinatesMatch(linkage, delegation);
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
 * The parent-state fields {@link classifyDelegationLiveness} actually reads.
 *
 * Narrower than {@link RunbookState} on purpose, so a fixture supplying just
 * these fields satisfies the parameter outright instead of needing an
 * `as unknown as RunbookState` cast to suppress the ~30 required fields it does
 * not set. That cast suppressed checking of these six as well: a misspelled
 * `activeFrameKy` compiled, and the classifier then read `undefined` and the
 * test passed for the wrong reason. Under this type that is a `TS2561`.
 *
 * `Pick` preserves each selected field's source optionality: the five optional
 * fields remain optional, while `step` remains required. This buys name and
 * type checking without strengthening the source contract. Callers holding a
 * full `RunbookState` pass it unchanged.
 */
export type DelegationLivenessParent = Pick<
  RunbookState,
  'lifecycle' | 'step' | 'substepStates' | 'activeFrameKey' | 'activeEntry' | 'frameEntryCounts'
>;

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
  parent: DelegationLivenessParent | null,
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
