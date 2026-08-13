import type { StepPosition } from '../cli/types.js';
import type { ForContext, ResolvedCompletion, RunbookState, SubstepState } from './types.js';
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

/**
 * The authority coordinates a delegation linkage and a claim's delegation
 * descriptor share, and the single place their comparison is written.
 *
 * `linkageMatchesClaim` and `linkageMatchesLinkage` compare the same six fields
 * for the same reason (see WHY ALL SIX below), and spelling that comparison out
 * twice is what let the field set drift apart before: the two predicates were
 * introduced together at three fields, `grantAllows` grew to seven, and neither
 * was widened (#738). One list means a coordinate cannot be added to the
 * descriptor and forgotten at one gate but not the other.
 */
export interface DelegationAuthorityCoordinates {
  readonly parentRunId: RunbookState['id'];
  readonly parentStepId: string;
  readonly parentStep: string;
  readonly parentFrameKey: FrameKey;
  readonly parentEntry: number;
  readonly tokenHash: DelegationTokenHash;
}

const DELEGATION_AUTHORITY_COORDINATE_KEYS = [
  'parentRunId',
  'parentStepId',
  'parentStep',
  'parentFrameKey',
  'parentEntry',
  'tokenHash',
] as const satisfies readonly (keyof DelegationAuthorityCoordinates)[];

/**
 * True when two authority-bearing linkages agree on every shared coordinate.
 *
 * @param left - First authority-bearing linkage descriptor.
 * @param right - Second authority-bearing linkage descriptor.
 * @returns `true` only when all six shared authority coordinates are equal.
 */
export function delegationAuthorityCoordinatesMatch(
  left: DelegationAuthorityCoordinates,
  right: DelegationAuthorityCoordinates,
): boolean {
  return DELEGATION_AUTHORITY_COORDINATE_KEYS.every((key) => left[key] === right[key]);
}

/**
 * True when `linkage` is a delegation linkage that matches every authority
 * coordinate in `claim`'s delegation descriptor.
 *
 * Equality on all six is a CONSISTENCY check, not a proof of provenance. The
 * child's `parentLinkage` is written at `manager.create` before any claim
 * exists, and the descriptor is later copied from a linkage, so neither can be
 * said to originate from the other and this predicate cannot establish that it
 * did. It answers only "do these two agree", which is what every call site
 * needs. Do not restate it as verifying that the linkage came from the claim —
 * that was the wording #738 called out, because it names a property three
 * fields plainly did not establish and six still do not.
 *
 * Lives here (a dependency-free leaf) so both `session-service.ts` and the
 * storage layer reuse the identical predicate without a store → session-service
 * import cycle.
 *
 * WHY ALL SIX. The field set is not a judgement call — it is dictated by
 * `grantAllows` (`claim-id.ts`), which decides at the point of USE whether this
 * claim may report the child's result, and compares seven: these six plus
 * `childRunId`. Anything this predicate skips is a coordinate on which the claim
 * and the child can diverge while every gate on the way in still passes, and
 * `grantAllows` then refuses silently — `shouldReport` false, no parent target,
 * the child closes `completed` with `reported: 'not-applicable'` and the parent
 * waits forever. That is #738, and it was reachable precisely because this
 * predicate compared three of the six. Widening a gate is never the whole fix
 * for a coordinate that should not have drifted — see
 * {@link classifyDelegationLiveness}, which rejects the drift at its source.
 *
 * POLARITY IS NOT UNIFORM ACROSS THE CALL SITES, so "which direction is
 * dangerous" has no single answer and must be read at the site that asked:
 *
 * - FAIL-CLOSED (three sites, all in `session-service.ts`:
 *   `getActiveForClaimId`, `stashForClaimId`, `unstashForClaimId`). `false` is
 *   a refusal — `child-linkage-mismatch` — and the caller stops. Here a
 *   predicate that is too WEAK is the silent-failure generator: it admits a
 *   claim/child pair that diverges on a coordinate `grantAllows` will compare
 *   later, and the divergence surfaces only as a report that never arrives.
 * - FAIL-OPEN (two sites: `SessionService.listOpenClaimsForParent` and
 *   `RunbookStore.openDelegatedChildrenFor`). `false` means `continue` — the
 *   claim is EXCLUDED from the set of children that must block the parent, so
 *   the parent is free to advance past it. Here the danger inverts: a predicate
 *   that is too STRICT drops a genuinely open child from the blocking set and
 *   lets the parent walk away from work still in flight, while a weaker one
 *   merely over-blocks.
 *
 * Both failures are silent and they are not the same failure. Any change to the
 * field set has to be judged against both directions, not against the
 * fail-closed reading alone.
 *
 * The seventh, `childRunId`, is absent from `ParentLinkage` and needs no
 * comparison here: callers obtain the child through `claim.controlledRunId`, and
 * claim validation requires that id to equal `claim.delegation.childRunId`.
 *
 * @param linkage - Parent linkage stored on the child runbook state (any kind, including absent).
 * @param claim - Claim record whose six shared delegation coordinates must all match.
 * @returns `true` only when `linkage.kind === 'delegation'` and every shared field matches `claim`.
 */
export function linkageMatchesClaim(
  linkage: RunbookState['parentLinkage'],
  claim: ClaimRecord,
): boolean {
  if (!claim.delegation) {
    return false;
  }
  return (
    linkage?.kind === 'delegation' && delegationAuthorityCoordinatesMatch(linkage, claim.delegation)
  );
}

/**
 * The parent-side linkage a caller presents to a delegation-liveness decision.
 *
 * Structurally a `Pick` of the persisted delegation-claim linkage, declared here
 * rather than imported from `claim-id.ts` to keep `targeting.ts` free of a claim
 * import cycle. Both transaction paths (the claim-side refusal and the
 * parent-commit invalidation hook) pass exactly these fields, as does
 * `claimAndLaunch`'s pre-check, which builds one inline.
 *
 * Note it is the *presented* shape, not the read surface — unlike
 * {@link DelegationLivenessParent}, which is exactly what the classifier reads.
 * The set is the persisted linkage's, so a caller holding one passes it whole;
 * see {@link DelegationLivenessLinkage.parentEntry} for the field that is
 * carried but deliberately not decided on.
 */
export interface DelegationLivenessLinkage {
  /** Parent step name captured at delegation time (e.g. "1"). */
  readonly parentStep: string;
  /** Parent step/substep id where the delegation originated. */
  readonly parentStepId: string;
  /** Parent execution frame key at delegation time. */
  readonly parentFrameKey: FrameKey;
  /**
   * Parent frame entry counter captured at delegation time.
   *
   * Part of the linkage, and compared by {@link linkageMatchesClaim} — but NOT
   * read by {@link classifyDelegationLiveness}, which decides entry identity
   * against the issuance entry on the substep's own credential. Keeping it in
   * the shape lets a caller pass its persisted linkage unchanged; trusting it
   * would reopen #738, where the entry a caller recomputed from live state was
   * compared against live state. See the comment inside the classifier.
   */
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
 * token, and — where the persisted frame records one — the frame's current entry
 * still equals the entry stamped on the substep's credential at issuance. Any
 * divergence is a closed outcome; this deliberately does NOT reduce to
 * `status !== 'done'`, which would miss the top-level cursor-advance path that
 * writes no `done` substep row.
 *
 * Entry identity is decided against the credential alone. `linkage.parentEntry`
 * is not consulted, so no caller can present a recomputed entry and have it
 * believed; see the comment at the entry comparison.
 *
 * @param parent - Parent run state read inside the deciding transaction, or null when absent.
 * @param linkage - Parent-side linkage presented by the caller. Every field but
 *   `parentEntry` participates in the decision.
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
  // Entry identity, decided against the ISSUANCE entry on the substep's
  // credential — never against the caller's `linkage.parentEntry` (#738). The
  // credential is written once when the delegation is issued and
  // `resetReopenedSubsteps` preserves it across frame re-entry, so it is the
  // only entry coordinate here that a caller cannot recompute. Comparing live
  // state against a linkage the caller derived from that same live state was
  // self-satisfying, and that is what let a claim mint authority naming entry 2
  // for a child stamped at entry 1, whose report `grantAllows` then silently
  // dropped.
  //
  // ONE comparison, live state against issuance, which is `classifyReplacementUse`'s
  // `entry_superseded` rule (#701) stated for liveness. It is what the
  // production path reaches now that `claimAndLaunch` reads the entry off the
  // credential: the cursor has moved past the entry the child was stamped with.
  //
  // `linkage.parentEntry` is deliberately NOT read. Asserting it equals
  // `issuedEntry` would be a check no production input can fail — the
  // pre-check reads both off the same substep row, every other caller presents
  // a persisted linkage minted from the credential, and a re-issue changes the
  // `tokenHash`, which the arm above catches first — and it reported
  // `cursor-advanced` for a condition in which no cursor had moved. Not reading
  // the coordinate is the stronger form of the same invariant than asserting
  // agreement with it: a caller cannot induce this classifier to trust a
  // recomputed entry when there is no path by which a recomputed entry is
  // consulted. State that could only reach that assertion — an older binary, a
  // hand edit — is the persistence boundary's to refuse, not a pure
  // classifier's to reinterpret.
  //
  // `inferFrameEntryFromState` computes almost this `currentEntry`, but the two
  // are NOT the same expression and must not be unified: it ends `?? 1`, so it
  // always yields a number, while this abstains (`undefined`) and the guard
  // below skips the comparison. Abstention is correct here. A frame with no
  // recorded entry is one this run's committed state never entered, and the
  // entry ordinal is run-global monotonic, so a delegation's issuance entry is
  // legitimately > 1; defaulting to 1 would manufacture a coordinate and close
  // a live delegation `cursor-advanced` on the strength of an invented number.
  const issuedEntry = delegation.credential.parentEntry;
  const currentEntry =
    parent.activeFrameKey === linkage.parentFrameKey && parent.activeEntry !== undefined
      ? parent.activeEntry
      : parent.frameEntryCounts?.[linkage.parentFrameKey];
  if (currentEntry !== undefined && currentEntry !== issuedEntry) {
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
