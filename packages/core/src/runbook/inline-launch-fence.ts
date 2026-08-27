/**
 * The inline-launch claim-generation fence (ADR 0002, #714).
 *
 * `rundown run --step` attaches a child run to a PRE-EXISTING composing parent
 * by marking that parent's linkage-named substep `running`. The parent is
 * another actor's run, so the write must not commit under authority established
 * at a different point in time: the launch captures the parent's controlling
 * run-control claim at linkage-determination time, and this module commits the
 * substep mark compare-and-swapped against BOTH that claim's generation and the
 * parent's state version. A parent re-claimed in the window between
 * determination and commit refuses `claim_superseded` — permanently, because
 * the parent now belongs to a different orchestrator and attaching under the
 * new authority silently is exactly what the fence exists to prevent.
 *
 * The derivation re-runs against a fresh capture on every attempt, preserving
 * the lost-update fold (#746): `substepStates` is a verbatim-replace field, so
 * the array committed is always derived from the row the compare-and-swap
 * commits onto, and the already-resolved decision is made against that same
 * row (the merge-revert hazard — a drained `done` row must never regress to
 * `running`).
 *
 * @module runbook/inline-launch-fence
 */

import type { RunbookState } from './types.js';
import type { FrameKey } from './targeting.js';
import { findSubstepState, upsertSubstepState } from './targeting.js';
import type { CapturedAuthority, GuardedMutationResult } from './storage/mutation-result.js';
import { DEFAULT_MUTATE_ATTEMPTS, mutateBackoffMs } from './storage/runbook-store.js';
import { applyRunbookStateUpdate, type RunbookStateManager } from './state.js';

/**
 * The store-backed operations the fence commits through.
 *
 * Structurally satisfied by {@link RunbookStateManager}, which is what the CLI
 * holds; the narrow shape keeps the fence testable and pins exactly which
 * seams it is allowed to touch.
 */
export type InlineLaunchFenceDeps = Pick<
  RunbookStateManager,
  'captureAuthorityState' | 'saveState'
>;

/**
 * Input for {@link markInlineSubstepLaunched}.
 */
export interface InlineLaunchMarkInput {
  /**
   * The parent's controlling authority captured at linkage-determination time.
   * Its claim generation is the fact the commit is fenced against.
   */
  readonly authority: CapturedAuthority;
  /** Substep id of the linkage target within the parent's frame. */
  readonly parentStepId: string;
  /** Frame the target substep belongs to. */
  readonly parentFrameKey: FrameKey;
  /**
   * Substep ids of the target step in document order; empty when the step has
   * no substeps, which disables the cursor half of the already-resolved check.
   */
  readonly targetSubstepIds: readonly string[];
}

/**
 * Typed refusals of the fenced mark — the non-committed arms of
 * {@link GuardedMutationResult}, passed through as themselves so no reason is
 * re-labelled at this seam.
 */
export type InlineLaunchMarkRefusal = Exclude<
  GuardedMutationResult<never>,
  { readonly kind: 'committed' }
>;

/**
 * Outcome of {@link markInlineSubstepLaunched}.
 *
 * `marked` committed the substep as `running` under the captured claim
 * generation. `already-resolved` wrote nothing because the target substep is
 * already resolved on the row the commit would have landed on. Every other arm
 * is a refusal: `claim_superseded` (the parent's claim rotated or its
 * generation advanced since determination — permanent), `missing` (the parent
 * run is gone — permanent), `concurrent_modification` (the retry budget was
 * spent under sustained version contention), and the ownership arms
 * (`execution_in_progress`, `recovery_required`) exactly as the store reports
 * them.
 */
export type InlineLaunchMarkOutcome =
  | { readonly kind: 'marked' }
  | { readonly kind: 'already-resolved' }
  | InlineLaunchMarkRefusal;

/**
 * Decide whether an inline-launch target substep is already resolved.
 *
 * Two independent ways a substep is spent, and both must be checked:
 *
 * 1. Its row is `done` — a completion was recorded against it.
 * 2. The parent cursor has advanced past it. Drain consumes the resolved
 *    completion and advances the cursor WITHOUT marking the row `done`, so (1)
 *    does not catch it. Only meaningful on the active frame: `state.substep` is
 *    the current iteration's cursor, not the target iteration's.
 *
 * Pure and synchronous by construction, because it is evaluated in two places
 * that impose different constraints: once as the caller-facing pre-read
 * refusal, and again inside the fenced commit cycle, which may re-run its
 * derivation up to the store's attempt budget and must therefore have no
 * external effect.
 *
 * @param state - Parent state to decide against — the pre-read copy at the
 *   guard, the freshly captured version inside the commit cycle
 * @param substepId - Target substep id within the frame
 * @param frameKey - Frame the target substep belongs to
 * @param orderedSubstepIds - Substep ids of the target step in document order;
 *   empty when the step has no substeps, which disables the cursor check
 * @returns Whether the substep is already resolved and must not be re-entered
 */
export function inlineTargetAlreadyResolved(
  state: RunbookState,
  substepId: string,
  frameKey: FrameKey,
  orderedSubstepIds: readonly string[],
): boolean {
  // Stryker disable next-line ArrayDeclaration: equivalent — a non-empty junk
  // default contains no row shaped like a substep, so the lookup misses either way.
  if (findSubstepState(state.substepStates ?? [], substepId, frameKey)?.status === 'done') {
    return true;
  }
  if (frameKey !== state.activeFrameKey || !state.substep) {
    return false;
  }
  const cursorIndex = orderedSubstepIds.indexOf(state.substep);
  const targetIndex = orderedSubstepIds.indexOf(substepId);
  // An unknown target (-1) never resolves — state may be corrupt or
  // mid-transition. An unknown or absent cursor needs no guard of its own:
  // -1 is never greater than a found target's index, and an empty
  // `orderedSubstepIds` yields -1 for both, so those arms fall out here too.
  return targetIndex !== -1 && cursorIndex > targetIndex;
}

/**
 * Wait between fenced-commit attempts.
 *
 * @param ms - Milliseconds to pause, from {@link mutateBackoffMs}.
 * @returns A promise resolving after the pause.
 */
// Stryker disable next-line BlockStatement: timing-only — a pause that resolves
// immediately changes pacing, never which outcome the fence returns.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Mark the linkage-named substep `running` under the captured claim generation.
 *
 * Each attempt re-captures the parent's authority UNDER THE ORIGINAL CLAIM KEY
 * — never re-resolving to whichever claim controls the run now — verifies the
 * generation still matches the determination-time capture, derives the substep
 * upsert from the freshly captured state, and commits through
 * {@link RunbookStateManager.saveState}, whose transaction re-classifies both
 * CAS terms. Only the ambiguous `concurrent_modification` arm retries, paced by
 * the store's exported budget; every permanent refusal returns as itself.
 *
 * @param deps - Capture and commit seams, satisfied by the state manager.
 * @param input - Determination-time authority and the linkage coordinates.
 * @returns The fenced outcome — see {@link InlineLaunchMarkOutcome}.
 */
export async function markInlineSubstepLaunched(
  deps: InlineLaunchFenceDeps,
  input: InlineLaunchMarkInput,
): Promise<InlineLaunchMarkOutcome> {
  const { authority, parentStepId, parentFrameKey, targetSubstepIds } = input;
  // Initialized to the outcome an exhausted budget reports. Every committed or
  // permanent arm returns out of the loop, so this value survives only when
  // all attempts refused `concurrent_modification` — and each such refusal
  // replaces it, so the store's own last refusal is what the caller receives.
  // Stryker disable ObjectLiteral,StringLiteral: unreachable — every iteration
  // either returns or overwrites this before the tail can read it; the
  // initializer exists so the loop tail types without a non-null assertion.
  let lastRefusal: InlineLaunchMarkRefusal = {
    kind: 'concurrent_modification',
    runId: authority.runId,
    message: `Run ${authority.runId} was modified concurrently.`,
  };
  // Stryker restore ObjectLiteral,StringLiteral
  // Zero-based, exactly as the store paces its own cycle: `mutateBackoffMs`
  // documents a zero-based index, and there is no pause after the final
  // attempt — a sleep nothing follows would only delay the refusal.
  for (let attempt = 0; attempt < DEFAULT_MUTATE_ATTEMPTS; attempt += 1) {
    const captured = await deps.captureAuthorityState(authority.runId, authority.claimKey);
    if (captured.kind !== 'captured') {
      // 'missing' or 'claim_superseded' — permanent for this launch.
      return captured;
    }
    if (captured.authority.claimGeneration !== authority.claimGeneration) {
      return {
        kind: 'claim_superseded',
        runId: authority.runId,
        message: `Run ${authority.runId} claim generation advanced since inline linkage was determined.`,
      };
    }
    if (
      inlineTargetAlreadyResolved(captured.state, parentStepId, parentFrameKey, targetSubstepIds)
    ) {
      return { kind: 'already-resolved' };
    }
    const next = applyRunbookStateUpdate(
      captured.state,
      {
        substepStates: upsertSubstepState(
          captured.state.substepStates ?? [],
          parentStepId,
          parentFrameKey,
          { status: 'running' as const },
        ),
      },
      new Date().toISOString(),
    );
    const result = await deps.saveState(captured.authority, next);
    if (result.kind === 'committed') {
      return { kind: 'marked' };
    }
    if (result.kind !== 'concurrent_modification') {
      return result;
    }
    lastRefusal = result;
    // Stryker disable next-line all: timing-only — this guard paces the retries
    // and skips the pause nothing follows; it can never change which outcome is
    // returned.
    if (attempt < DEFAULT_MUTATE_ATTEMPTS - 1) {
      await delay(mutateBackoffMs(attempt));
    }
  }
  return lastRefusal;
}
