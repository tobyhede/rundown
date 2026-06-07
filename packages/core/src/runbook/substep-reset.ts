/**
 * Pure reset of re-opened substep rows for the "reset-on-reopen" behaviour.
 *
 * @module
 */

import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep, SubstepState } from './types.js';
import type { FrameKey } from './targeting.js';

/**
 * Reset a re-opened substep — and every later substep in the same frame — to a
 * clean `pending` slate.
 *
 * On RETRY or intra-frame GOTO the machine resumes at `fromSubstepId` and walks
 * forward, re-prompting that substep through the last substep of the step. This
 * helper makes the persisted projection match that forward walk: every row in
 * the active `frameKey` whose substep index is `>= index(fromSubstepId)` is
 * reset to `{ status: 'pending' }` with any prior `result` removed. Rows in
 * other frames, and rows before `fromSubstepId`, are returned untouched.
 * Non-status/result fields (notably `delegation`, `inline`) are preserved.
 *
 * Pure: no machine, service, or CLI awareness. Category B (computation over
 * context) per `CLAUDE.md`.
 *
 * @param step - The active step whose substeps are being re-walked.
 * @param frameKey - The active frame key scoping the reset (FOR iteration aware).
 * @param fromSubstepId - Inclusive start substep id; this row and all later
 *   same-frame rows are reset.
 * @param substepStates - Current substep states.
 * @returns A new array with the re-opened rows reset; the input array is never
 *   mutated. If `fromSubstepId` is not a declared substep of `step`, or `step`
 *   has no substeps, the input is returned unchanged.
 */
export function resetReopenedSubsteps(
  step: ResolvedStep,
  frameKey: FrameKey,
  fromSubstepId: string,
  substepStates: readonly SubstepState[],
): readonly SubstepState[] {
  if (!resolvedStepHasSubsteps(step)) return substepStates;
  const orderedIds = step.substeps.map((substep) => substep.id);
  const fromIndex = orderedIds.indexOf(fromSubstepId);
  if (fromIndex === -1) return substepStates;
  const reopened = new Set(orderedIds.slice(fromIndex));

  return substepStates.map((ss) => {
    if (ss.frameKey !== frameKey || !reopened.has(ss.id)) return ss;
    if (ss.status === 'pending' && ss.result === undefined) return ss;
    const { result, ...rest } = ss;
    void result;
    return { ...rest, status: 'pending' as const };
  });
}
