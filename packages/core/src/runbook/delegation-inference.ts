/**
 * Pure delegation inference helpers.
 *
 * These helpers inspect parsed steps and persisted state data to determine
 * delegation targets. They perform no I/O and never persist state.
 *
 * @module
 */

import { hasRunbooks, parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep, Substep } from '@rundown-org/parser';

import { Errors, RundownError } from '../errors/index.js';
import type { DelegateFrontierEntry } from '../events/types.js';
import type { ParentLinkage, RunId, RunbookState, StepDelegation, SubstepState } from './types.js';
import { formatRunbookRef, sameRunbookRef, type RunbookRef } from './runbook-ref.js';
import { buildFrameKey, deriveActiveFrame, findSubstepState, type FrameKey } from './targeting.js';

/**
 * Structural state required by pure delegation inference.
 */
export interface DelegationInferenceState {
  /** Current run id, used for nested-delegation diagnostics. */
  readonly id: RunId;
  /** Current top-level step id. */
  readonly step: string;
  /** Current substep id, when the persisted state is positioned inside one. */
  readonly substep?: string;
  /** Persisted per-frame substep execution state. */
  readonly substepStates?: readonly SubstepState[];
  /** Active frame key for frame-scoped substep lookup. */
  readonly activeFrameKey?: FrameKey;
  /** Active frame entry counter. */
  readonly activeEntry?: number;
  /** Known frame entry counters by frame key. */
  readonly frameEntryCounts?: Readonly<Record<FrameKey, number>>;
  /** Optional parent linkage for inline or delegated child runs. */
  readonly parentLinkage?: ParentLinkage;
}

/**
 * Result of delegation target inference.
 */
export interface InferredDelegation {
  /** Runbook reference from the substep's `runbooks` field. */
  readonly runbookRef: string;
  /** Qualified step id, for example `1.1`. */
  readonly stepId: string;
}

/**
 * Resolution of a bare `rd delegate` request against the current step.
 *
 * - `issuable` — a delegate substep has no active delegation; the caller should
 *   issue a fresh token via {@link createDelegation}.
 * - `already-issued` — every delegate substep already carries a pending
 *   (auto-issued) token; the caller should echo the existing frontier token
 *   rather than re-issue. Makes `rd delegate` idempotent on an auto-issued
 *   frontier instead of throwing RD-813.
 * - `none` — the current step has no delegatable substep at all (genuine
 *   RD-813 condition; the caller throws).
 */
export type DelegateTargetResolution =
  | { readonly kind: 'issuable'; readonly target: InferredDelegation }
  | {
      readonly kind: 'already-issued';
      readonly stepId: string;
      readonly token: string;
      readonly runbookRef: string;
    }
  | { readonly kind: 'none' };

/**
 * Resolved child runbook identity for delegation issuance.
 */
export interface ResolvedDelegationRunbook {
  /** Filesystem path passed to delegation creation as the child runbook path. */
  readonly path: string;
  /** Author-facing ref shown in delegate frontier entries. */
  readonly runbookRef: string;
  /** Canonical persisted child runbook reference. */
  readonly childRunbookRef: RunbookRef;
}

/**
 * Runtime resolver supplied by the front end that knows runbook discovery rules.
 *
 * The resolver MUST signal failure by resolving to `null`; it MUST NOT reject.
 * Callers (notably {@link delegationIssueActor}) wrap calls defensively, but
 * the contract keeps front-end-supplied resolvers compatible with the actor's
 * typed `failed` output.
 *
 * @param runbookRef - Runbook reference authored on the delegated substep.
 * @returns Resolved child runbook metadata, or `null` when the reference
 *   cannot be resolved.
 */
export type ResolveDelegationRunbook = (
  runbookRef: string,
) => Promise<ResolvedDelegationRunbook | null>;

/**
 * Check whether a substep has an active delegation in a frame.
 *
 * @param substepId - Substep id to check.
 * @param substepStates - Current substep states from persisted state.
 * @param frameKey - Frame key that scopes the lookup.
 * @returns True if the substep has a non-cancelled delegation.
 */
function hasActiveDelegation(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const substepState = findSubstepState(substepStates, substepId, frameKey);
  return substepState?.delegation?.cancelledAt === null;
}

/**
 * Check whether a substep is marked done in a frame.
 *
 * @param substepId - Substep id to check.
 * @param substepStates - Current substep states from persisted state.
 * @param frameKey - Frame key that scopes the lookup.
 * @returns True if the substep status is `done`.
 */
function isSubstepDone(
  substepId: string,
  substepStates: readonly SubstepState[] | undefined,
  frameKey: FrameKey,
): boolean {
  if (!substepStates) return false;
  const substepState = findSubstepState(substepStates, substepId, frameKey);
  return substepState?.status === 'done';
}

/**
 * Infer the first manual delegation target from the current step.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @returns The inferred delegation target.
 * @throws {RundownError} RD-813 if no suitable substep exists.
 * @deprecated Superseded by {@link resolveDelegationIssuance}, which unifies
 *   bare/positional/explicit-step issuance resolution and returns errors as
 *   data instead of throwing.
 */
export function inferDelegationTarget(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
): InferredDelegation {
  const currentStep = steps.find((step) => step.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) continue;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    return {
      runbookRef: substep.runbooks[0],
      stepId: `${currentStep.name}.${substep.id}`,
    };
  }

  throw Errors.delegationNoDelegatableSubstep(state.step);
}

/**
 * Resolve a bare `rd delegate` request, treating an auto-issued frontier as a
 * valid idempotent target rather than an RD-813 error.
 *
 * Prefers a fresh issuable substep (document order). Falls back to the first
 * substep that already has a pending delegation, surfacing its frontier token.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @param frontier - The persisted delegate frontier (`state.delegateFrontier`).
 * @returns Discriminated resolution; never throws RD-813 (returns `none`).
 * @throws {RundownError} RD-814 if a delegate substep lacks a runbook reference.
 * @deprecated Superseded by {@link resolveDelegationIssuance}, which reads
 *   pending tokens from `substepStates[].delegation` directly (no frontier
 *   input) and covers the positional/explicit-step forms uniformly.
 */
export function resolveDelegateTarget(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  frontier: readonly DelegateFrontierEntry[] = [],
): DelegateTargetResolution {
  const currentStep = steps.find((step) => step.name === state.step);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    return { kind: 'none' };
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  let alreadyIssued: DelegateTargetResolution | undefined;

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
    const stepId = `${currentStep.name}.${substep.id}`;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) {
      if (!alreadyIssued) {
        const entry = frontier.find((candidate) => candidate.id === stepId);
        if (entry) {
          alreadyIssued = {
            kind: 'already-issued',
            stepId,
            token: entry.token,
            runbookRef: entry.runbook,
          };
        }
      }
      continue;
    }

    return { kind: 'issuable', target: { runbookRef: substep.runbooks[0], stepId } };
  }

  return alreadyIssued ?? { kind: 'none' };
}

/**
 * Derive the delegate frontier for the current active frame from persisted
 * per-substep delegation records.
 *
 * The machine's `delegateFrontier` lives in the opaque state-machine snapshot
 * context, not as a typed `RunbookState` field. The same data — qualified step
 * id, child runbook ref, and the plaintext token recoverable while a delegation
 * is pending — is available on `substepStates[].delegation`, so the frontier is
 * derived from that typed source. Pending (non-cancelled) delegations carrying a
 * token become frontier entries keyed by qualified id (`<step>.<substep>`),
 * which {@link resolveDelegateTarget} matches against.
 *
 * Scoped to the active frame: `substepStates` accumulates one entry per
 * `(substep, frameKey)`, so in a FOR loop a delegation issued in an earlier
 * iteration can linger with a recoverable token. Including it would let
 * {@link resolveDelegateTarget}'s first-match lookup surface another frame's
 * token. Filtering by the active frame key keeps the derivation frame-correct,
 * mirroring the frame-scoped lookups used by the core inference helpers.
 *
 * This is runbook logic and lives in core; front ends consume it rather than
 * reconstructing frame-sensitive data themselves.
 *
 * @param state - Active runbook state.
 * @returns Frontier entries for active-frame substeps with a recoverable pending token.
 * @deprecated Superseded by {@link resolveDelegationIssuance}, which reads
 *   pending tokens from `substepStates[].delegation` directly without the
 *   frontier indirection.
 */
export function deriveDelegateFrontier(state: RunbookState): DelegateFrontierEntry[] {
  const activeFrameKey = state.activeFrameKey ?? deriveActiveFrame(state).frameKey;
  const frontier: DelegateFrontierEntry[] = [];
  for (const substep of state.substepStates ?? []) {
    if (substep.frameKey !== activeFrameKey) continue;
    const delegation = substep.delegation;
    if (!delegation) continue;
    if (delegation.cancelledAt !== null || !delegation.token) continue;
    frontier.push({
      id: `${state.step}.${substep.id}`,
      runbook: delegation.childRunbookRef.path,
      token: delegation.token,
    });
  }
  return frontier;
}

/**
 * Find the in-flight (pending, unclaimed, non-cancelled) delegation on a target
 * substep within a frame, with a recoverable plaintext token. Returns undefined
 * when the step id has no substep segment, when no matching substep state
 * exists, or when the delegation is cancelled/claimed/token-less. Pure; no I/O.
 *
 * @param state - Current runbook state data (per-frame substep states).
 * @param stepId - Qualified step id, for example `1.1`.
 * @param frameKey - Frame key scoping the lookup.
 * @returns The matching delegation (narrowed to carry a `token`), or undefined.
 */
export function findPendingDelegation(
  state: DelegationInferenceState,
  stepId: string,
  frameKey: FrameKey,
): (StepDelegation & { token: string }) | undefined {
  const parsed = parseStepIdFromString(stepId);
  // Require a substep segment AND that the frame belongs to the parsed step.
  // Substep ids collide across steps, and the frame key is the authority on
  // which step a substep instance belongs to; without the frame-step check a
  // request for `<other>.<id>` could match the current step's substep `<id>`
  // (the CLI derives the frame from the current step, not the parsed step).
  if (!parsed?.substep || !isFrameForStep(frameKey, parsed.step)) return undefined;
  const match = (state.substepStates ?? []).find(
    (ss): ss is SubstepState & { delegation: StepDelegation & { token: string } } =>
      ss.id === parsed.substep &&
      ss.frameKey === frameKey &&
      // Exclude completed substeps, mirroring resolveDelegateTarget's
      // isSubstepDone guard so the targeted path cannot classify a done
      // substep's lingering delegation record as in-flight.
      ss.status !== 'done' &&
      ss.delegation?.cancelledAt === null &&
      ss.delegation.childRunId === null &&
      ss.delegation.token != null,
  );
  return match?.delegation;
}

/**
 * How the CLI's requested positional arg resolved (front-end discovery).
 *
 * - `none` — bare `rd delegate --step S` (no positional runbook).
 * - `resolved` — the positional arg resolved to a canonical `RunbookRef`.
 * - `unresolvable` — the positional arg did not resolve to a runbook on disk.
 */
export type RequestedRunbookArg =
  | { readonly kind: 'none' }
  | { readonly kind: 'resolved'; readonly ref: RunbookRef; readonly raw: string }
  | { readonly kind: 'unresolvable'; readonly raw: string };

/**
 * Resolution of a targeted `rd delegate [<runbook>] --step S` against any
 * in-flight delegation on the substep.
 *
 * - `issuable` — no in-flight delegation; the caller proceeds to issue one.
 * - `echo` — an in-flight delegation exists and matches the request; the caller
 *   echoes the existing token (`action: "already-delegated"`).
 * - `conflict` — an in-flight delegation exists for a different runbook; the
 *   caller throws the carried RD-804 error.
 */
export type TargetedDelegateResolution =
  | { readonly kind: 'issuable' }
  | {
      readonly kind: 'echo';
      readonly stepId: string;
      readonly token: string;
      readonly runbookRef: string;
    }
  | { readonly kind: 'conflict'; readonly error: RundownError };

/**
 * Resolve a targeted `rd delegate [<runbook>] --step S` against any in-flight
 * delegation on the substep. Single source of truth for the RD-804
 * echo-vs-conflict decision (the bare path's {@link resolveDelegateTarget}
 * analogue). Pure; no I/O — the CLI resolves the requested arg to a
 * `RunbookRef` first and passes it as data.
 *
 * @param state - Current runbook state data.
 * @param stepId - Qualified step id, for example `1.1`.
 * @param frameKey - Frame key scoping the lookup.
 * @param requested - The CLI-resolved requested positional arg.
 * @returns Discriminated `issuable | echo | conflict` resolution.
 * @deprecated Superseded by {@link resolveDelegationIssuance}, which adds the
 *   RD-811 claimed-delegation conflict and authored-target validation on top of
 *   the same echo-vs-conflict decision.
 */
export function resolveTargetedDelegation(
  state: DelegationInferenceState,
  stepId: string,
  frameKey: FrameKey,
  requested: RequestedRunbookArg,
): TargetedDelegateResolution {
  const existing = findPendingDelegation(state, stepId, frameKey);
  if (!existing) return { kind: 'issuable' };

  const classified = classifyRequestedAgainstPending(existing, stepId, requested);
  if (classified.kind === 'conflict') return classified;
  return {
    kind: 'echo',
    stepId: classified.stepId,
    token: classified.token,
    runbookRef: classified.runbookRef,
  };
}

/**
 * Classify a pending (unclaimed, tokened) delegation against the CLI-resolved
 * requested runbook arg: a matching (or absent) request echoes the pending
 * token; a different request is the RD-804 conflict. Single source of truth for
 * the echo-vs-conflict decision shared by {@link resolveTargetedDelegation} and
 * {@link resolveDelegationIssuance}.
 *
 * @param existing - The pending delegation (narrowed to carry a token).
 * @param stepId - Qualified step id the request targets, for example `1.1`.
 * @param requested - The CLI-resolved requested positional arg.
 * @returns `already-issued` (echo) or `conflict` (RD-804) resolution.
 */
function classifyRequestedAgainstPending(
  existing: StepDelegation & { token: string },
  stepId: string,
  requested: RequestedRunbookArg,
): Extract<DelegationIssuanceResolution, { kind: 'already-issued' | 'conflict' }> {
  const matches =
    requested.kind === 'none' ||
    (requested.kind === 'resolved' && sameRunbookRef(requested.ref, existing.childRunbookRef));

  if (!matches) {
    // `requested.kind === 'none'` always matches, so here it is resolved/unresolvable.
    // Source-qualify both refs so a same-filename / different-source mismatch is
    // legible rather than rendering both sides as the bare filename. The
    // unresolvable form has no canonical ref, so fall back to the raw arg.
    const requestedLabel =
      requested.kind === 'resolved' ? formatRunbookRef(requested.ref) : requested.raw;
    return {
      kind: 'conflict',
      error: Errors.delegationAlreadyExists(
        stepId,
        `in-flight delegation for a different runbook: requested ${requestedLabel}, existing ${formatRunbookRef(existing.childRunbookRef)}, token hash ${existing.tokenHash}`,
      ),
    };
  }

  return {
    kind: 'already-issued',
    stepId,
    token: existing.token,
    runbookRef: existing.childRunbookRef.path,
  };
}

/**
 * Request shape for {@link resolveDelegationIssuance}, covering every manual
 * issuance invocation form (`rd delegate`, `rd delegate --step S`,
 * `rd delegate <runbook>`).
 */
export interface DelegationIssuanceRequest {
  /** Explicit `--step` target (qualified id, e.g. `1.1`); undefined => frontier scan. */
  readonly explicitStep?: string;
  /** CLI-resolved positional runbook arg; `{ kind: 'none' }` when absent. */
  readonly requested: RequestedRunbookArg;
}

/**
 * Unified resolution of a manual delegation-issuance request.
 *
 * - `issuable` — the caller should mint a fresh token for `stepId` against the
 *   authored `runbookRef` (RD-822 requested-vs-authored confirmation and child
 *   resolution stay with the caller).
 * - `already-issued` — an in-flight delegation matching the request exists; the
 *   caller echoes its token (`action: "already-delegated"`).
 * - `conflict` — an in-flight delegation exists for a different runbook
 *   (RD-804), or the targeted delegation is claimed by a live child (RD-811).
 * - `none` — nothing is delegatable: RD-813 (no delegatable substep) or RD-814
 *   (delegate substep without a runbook), carried as data so the resolver never
 *   throws and the caller has one uniform shape.
 */
export type DelegationIssuanceResolution =
  | { readonly kind: 'issuable'; readonly stepId: string; readonly runbookRef: string }
  | {
      readonly kind: 'already-issued';
      readonly stepId: string;
      readonly token: string;
      readonly runbookRef: string;
    }
  | { readonly kind: 'conflict'; readonly error: RundownError }
  | { readonly kind: 'none'; readonly error: RundownError };

/**
 * Resolve a manual delegation-issuance request — explicit `--step`, bare, or
 * positional — against the current state, in one pass.
 *
 * Single source of truth for issuance resolution: document-order frontier
 * scanning, the RD-804 echo-vs-conflict decision against the CLI-resolved
 * requested arg, and the RD-811 claimed-delegation conflict all live here, so
 * every invocation form gets identical semantics. Pure, no I/O, never throws —
 * RD-813/RD-814 conditions return `none` carrying the error.
 *
 * Explicit-step path: validates the substep is an authored DELEGATE with a
 * runbook, then classifies the existing delegation — claimed (linked,
 * non-cancelled, not done) conflicts with RD-811; pending-unclaimed echoes or
 * conflicts (RD-804) against the requested arg; otherwise issuable.
 *
 * Bare/positional path: scans the current step's delegate substeps in document
 * order. Done substeps are skipped; a pending-unclaimed substep with a token is
 * the echo candidate (subject to the same requested-match echo/conflict
 * decision); claimed substeps are skipped (auto-fan-out semantics unchanged —
 * `createDelegation`'s claimed guard is the backstop); the first substep with
 * no active delegation is issuable with its authored `runbooks[0]`. A fresh
 * issuable substep wins over an earlier echo candidate, preserving the bare
 * path's document-order preference.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @param frameKey - Frame key scoping the lookup (explicit `--index` or the
 *   active frame).
 * @param request - The invocation form: optional explicit step + requested arg.
 * @returns Discriminated `issuable | already-issued | conflict | none` resolution.
 */
export function resolveDelegationIssuance(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  frameKey: FrameKey,
  request: DelegationIssuanceRequest,
): DelegationIssuanceResolution {
  if (request.explicitStep !== undefined) {
    return resolveExplicitIssuance(state, steps, frameKey, request.explicitStep, request.requested);
  }
  return resolveFrontierIssuance(state, steps, frameKey, request.requested);
}

/** Explicit `--step` arm of {@link resolveDelegationIssuance}. */
function resolveExplicitIssuance(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  frameKey: FrameKey,
  stepId: string,
  requested: RequestedRunbookArg,
): DelegationIssuanceResolution {
  // Authored-target validation. inferRunbookFromStep owns the RD-801/813/814
  // checks; the resolver's never-throws contract converts them to `none` data.
  let authoredRef: string;
  try {
    authoredRef = inferRunbookFromStep(state, steps, stepId);
  } catch (error) {
    if (error instanceof RundownError) return { kind: 'none', error };
    throw error;
  }

  // Claimed-delegation conflict (RD-811): a linked, non-cancelled, not-yet-done
  // delegation must never be re-minted over — it would orphan the running
  // child. The frame-step guard mirrors findPendingDelegation: substep ids
  // collide across steps, so only a frame belonging to the parsed step counts.
  const parsed = parseStepIdFromString(stepId);
  if (parsed?.substep && isFrameForStep(frameKey, parsed.step)) {
    const substepState = findSubstepState(state.substepStates ?? [], parsed.substep, frameKey);
    const delegation = substepState?.delegation;
    if (
      delegation?.cancelledAt === null &&
      delegation.childRunId !== null &&
      substepState?.status !== 'done'
    ) {
      return {
        kind: 'conflict',
        error: Errors.delegationAlreadyClaimed(stepId, delegation.childRunId),
      };
    }
  }

  // Pending-unclaimed: echo the in-flight token or conflict (RD-804).
  const existing = findPendingDelegation(state, stepId, frameKey);
  if (existing) return classifyRequestedAgainstPending(existing, stepId, requested);

  return { kind: 'issuable', stepId, runbookRef: authoredRef };
}

/** Bare/positional frontier-scan arm of {@link resolveDelegationIssuance}. */
function resolveFrontierIssuance(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  frameKey: FrameKey,
  requested: RequestedRunbookArg,
): DelegationIssuanceResolution {
  const currentStep = steps.find((step) => step.name === state.step);
  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    return { kind: 'none', error: Errors.delegationNoDelegatableSubstep(state.step) };
  }

  let echoCandidate: DelegationIssuanceResolution | undefined;

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      return {
        kind: 'none',
        error: Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step),
      };
    }
    const stepId = `${currentStep.name}.${substep.id}`;
    const substepState = findSubstepState(state.substepStates ?? [], substep.id, frameKey);
    if (substepState?.status === 'done') continue;

    const delegation = substepState?.delegation;
    if (delegation?.cancelledAt === null) {
      // Active delegation. A pending-unclaimed one with a recoverable token is
      // the echo candidate — the fix for the positional path, which previously
      // skipped it and exhausted into RD-813. Claimed (or token-less) records
      // are skipped: auto-fan-out semantics are unchanged and createDelegation's
      // claimed guard backstops any direct re-mint attempt.
      if (
        echoCandidate === undefined &&
        delegation.childRunId === null &&
        delegation.token != null
      ) {
        echoCandidate = classifyRequestedAgainstPending(
          { ...delegation, token: delegation.token },
          stepId,
          requested,
        );
      }
      continue;
    }

    return { kind: 'issuable', stepId, runbookRef: substep.runbooks[0] };
  }

  return (
    echoCandidate ?? { kind: 'none', error: Errors.delegationNoDelegatableSubstep(state.step) }
  );
}

/**
 * Determine whether a frame key belongs to the given step.
 *
 * Frame keys are `<step>|<iteration-or-empty>` (see {@link buildFrameKey}), so
 * a frame belongs to a step when its leading `<step>` segment matches exactly.
 * Matching the full segment (rather than a prefix) keeps step `1` from
 * colliding with frames for step `12` and is iteration-agnostic, covering both
 * the base frame (`1|`) and FOR iteration frames (`1|0`, `1|1`, …).
 *
 * @param frameKey - Frame key to test.
 * @param step - Step name to match against the frame's step segment.
 * @returns True when the frame key's step segment equals `step`.
 */
function isFrameForStep(frameKey: FrameKey, step: string): boolean {
  const separator = frameKey.indexOf('|');
  const stepSegment = separator === -1 ? frameKey : frameKey.slice(0, separator);
  return stepSegment === step;
}

/**
 * Determine whether the current cursor sits directly on the successor of an
 * aggregated DELEGATE step.
 *
 * `rd collect` is idempotent only across the *genuine* post-aggregation
 * transition: once a DELEGATE step has aggregated and advanced the cursor to
 * the next step in document order, a repeated bare `rd collect` should report a
 * harmless `already-aggregated` no-op rather than erroring. The discriminating
 * fact is structural and is therefore runbook logic owned by core: the step
 * immediately preceding the current cursor (in document order) is a DELEGATE
 * step whose delegate substeps have all reached `status: 'done'` (evidence that
 * aggregation already fired).
 *
 * This is deliberately narrower than "any delegation exists anywhere in the
 * run". A run may delegate at an early step and later advance the cursor onto
 * an ordinary, unrelated non-DELEGATE step; a bare `rd collect` there is misuse
 * and must surface as an error, not be masked by stale delegation evidence.
 *
 * The check is intentionally position-based rather than transition-replaying:
 * aggregation advances the cursor sequentially to the next document step, so
 * the predecessor in document order is the aggregated DELEGATE step. A GOTO
 * aggregation that jumps elsewhere is not treated as an idempotent successor —
 * that step is reached by an explicit jump, not a transparent advance, so a
 * bare `rd collect` there is correctly surfaced as misuse.
 *
 * @param state - Current runbook state data (cursor step + substep states).
 * @param steps - Parsed steps from the active runbook, in document order.
 * @returns True when the cursor's document-order predecessor is an aggregated
 *   DELEGATE step.
 */
export function isPostDelegateAggregationCursor(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
): boolean {
  const index = steps.findIndex((step) => step.name === state.step);
  if (index <= 0) return false;

  const predecessor = steps[index - 1];
  if (!resolvedStepHasSubsteps(predecessor)) return false;

  const delegateSubsteps = predecessor.substeps.filter((substep) => substep.delegate);
  if (delegateSubsteps.length === 0) return false;

  // Aggregation evidence must come from a SINGLE frame. `substepStates`
  // accumulate one entry per `(id, frameKey)`, so a frame-agnostic existence
  // check would falsely classify the cursor as post-aggregation when each
  // delegate substep is `done` in a *different* frame (e.g. distinct FOR
  // iterations where no single iteration ran the whole DELEGATE step) or when
  // the `done` records belong to an unrelated step that happens to reuse the
  // same substep ids. A genuine aggregation drives every delegate substep to
  // `done` within one frame, so require that some single frame — belonging to
  // the predecessor step — has *all* delegate substeps `done`.
  const substepStates = state.substepStates ?? [];
  const candidateFrames = new Set<FrameKey>();
  for (const ss of substepStates) {
    if (ss.status === 'done' && isFrameForStep(ss.frameKey, predecessor.name)) {
      candidateFrames.add(ss.frameKey);
    }
  }

  for (const frameKey of candidateFrames) {
    const fullyAggregated = delegateSubsteps.every((substep) =>
      substepStates.some(
        (ss) => ss.id === substep.id && ss.frameKey === frameKey && ss.status === 'done',
      ),
    );
    if (fullyAggregated) return true;
  }

  return false;
}

/**
 * Infer the runbook reference from a specific substep.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @param stepId - Qualified step id, for example `1.1`.
 * @returns The first runbook reference from the substep.
 * @throws {RundownError} RD-813 if the substep is not marked as delegatable.
 * @throws {RundownError} RD-814 if the substep has no runbook reference.
 */
export function inferRunbookFromStep(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
  stepId: string,
): string {
  const parsed = parseStepIdFromString(stepId);
  if (!parsed) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  const step = steps.find((candidate) => candidate.name === parsed.step);

  if (!step) {
    throw Errors.delegationStepNotFound(parsed.step);
  }

  if (!resolvedStepHasSubsteps(step) || !parsed.substep) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const substep = step.substeps.find((candidate: Substep) => candidate.id === parsed.substep);
  if (!substep) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  if (!substep.delegate) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }
  if (!hasRunbooks(substep)) {
    throw Errors.delegationSubstepNoRunbook(stepId, state.step);
  }

  return substep.runbooks[0];
}

/**
 * Infer every eligible auto-delegated substep in the current active frame.
 *
 * @param state - Current runbook state data.
 * @param steps - Parsed steps from the active runbook.
 * @returns Inferred delegation targets in document order.
 * @throws {RundownError} RD-813 if the current step has no substeps.
 * @throws {RundownError} RD-814 if a delegated substep lacks a runbook ref.
 * @throws {RundownError} RD-817 if a delegated child attempts delegation fan-out.
 */
export function inferAllDelegateSubsteps(
  state: DelegationInferenceState,
  steps: readonly ResolvedStep[],
): InferredDelegation[] {
  if (state.parentLinkage?.kind === 'delegation') {
    throw Errors.delegationNestedForbidden(state.id);
  }

  const currentStep = steps.find((step) => step.name === state.step);

  if (!currentStep || !resolvedStepHasSubsteps(currentStep)) {
    throw Errors.delegationNoDelegatableSubstep(state.step);
  }

  const activeFrameKey = state.activeFrameKey ?? buildFrameKey(state.step);
  const results: InferredDelegation[] = [];

  for (const substep of currentStep.substeps) {
    if (!substep.delegate) continue;
    if (!hasRunbooks(substep)) {
      throw Errors.delegationSubstepNoRunbook(`${currentStep.name}.${substep.id}`, state.step);
    }
    if (hasActiveDelegation(substep.id, state.substepStates, activeFrameKey)) continue;
    if (isSubstepDone(substep.id, state.substepStates, activeFrameKey)) continue;

    results.push({
      runbookRef: substep.runbooks[0],
      stepId: `${currentStep.name}.${substep.id}`,
    });
  }

  return results;
}
