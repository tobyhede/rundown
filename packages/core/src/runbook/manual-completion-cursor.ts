import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep } from '@rundown-org/parser';
import {
  activeFrame,
  buildFrameKey,
  deriveActiveFrame,
  deriveExecutionAt,
  inactiveFrame,
  type Frame,
} from './targeting.js';
import type { RunbookState } from './types.js';

/**
 * Raw explicit `--step` / `--index` transition target.
 *
 * Category-A parsing (raw CLI strings to a step id + numeric iteration) is the
 * frontend's job; every state-dependent decision — step match, substep
 * existence, FOR bounds, active-iteration default, active-vs-inactive frame —
 * is made by {@link resolveManualCompletionCursor} against the state the seam
 * reads under the completion lock.
 */
export interface ExplicitTransitionTarget {
  /** Raw qualified step id (e.g. `1.2` or `1.2.1`). */
  readonly stepId: string;
  /** Numeric `--index` iteration, when supplied (pre-parsed by the frontend). */
  readonly iteration?: number;
}

/**
 * Resolved explicit substep cursor for `--step` / `--index` transitions.
 *
 * Produced by {@link resolveManualCompletionCursor} from a raw
 * {@link ExplicitTransitionTarget} and the runbook state it is resolved
 * against.
 */
export interface ExplicitCompletionCursor {
  /** Target step id. */
  readonly step: string;
  /** Target substep id. */
  readonly substep: string;
  /** Target FOR iteration, when applicable. */
  readonly iteration?: number;
  /** Resolved targeting frame for the completion. */
  readonly frame: Frame;
  /** Qualified position string (e.g. `1.2.1`) used in idempotent status output. */
  readonly at: string;
}

/**
 * Resolved explicit substep cursor for `--step` / `--index` transitions.
 *
 * @deprecated `LifecycleTransitionInput` no longer takes a pre-resolved cursor
 * (`manualTarget` was replaced by the raw `explicitTarget` — #500): the seam
 * derives the cursor in-lock via {@link resolveManualCompletionCursor}, which
 * returns {@link ExplicitCompletionCursor}. Retained as a type-only alias
 * (zero runtime cost) so the published surface keeps the name.
 */
export type ManualCompletionCursor = ExplicitCompletionCursor;

/**
 * Resolve the substep completion cursor for an explicit `--step` / `--index`
 * pass/fail transition against the supplied runbook state.
 *
 * Derive-or-refuse: called by the lifecycle seam INSIDE its completion-lock
 * scope against the locked re-read, so the returned cursor cannot go stale
 * between resolution and the record/drain it feeds (#500). Pure — no IO.
 *
 * @param steps - Parsed runbook steps for the resolved target run
 * @param activeState - Runbook state the cursor is resolved against
 * @param target - Explicit step id + optional numeric iteration
 * @returns The validated manual completion cursor
 * @throws {Error} on a missing/invalid/mismatched step target, a missing or
 *   non-existent substep, a template AT expression, or an out-of-bounds /
 *   non-FOR iteration
 */
export function resolveManualCompletionCursor(
  steps: readonly ResolvedStep[],
  activeState: RunbookState,
  target: ExplicitTransitionTarget,
): ExplicitCompletionCursor {
  const activeStep = steps.find((candidate) => candidate.name === activeState.step);
  if (!activeStep) {
    throw new Error(`Step "${activeState.step}" not found`);
  }
  // --step targets a substep, so reject if we're not in substep mode.
  if (!activeState.substep || !resolvedStepHasSubsteps(activeStep) || !activeStep.substeps.length) {
    throw new Error(
      `--step requires the runbook to be at a substep, but step "${activeState.step}" has no active substep`,
    );
  }
  const parsed = parseStepIdFromString(target.stepId);
  if (!parsed) {
    throw new Error(`Invalid step target: ${target.stepId}`);
  }
  if (parsed.step !== activeState.step) {
    throw new Error(
      `--step ${target.stepId} targets step "${parsed.step}" but the active step is "${activeState.step}"`,
    );
  }
  // Require substep — bare step IDs create unreachable completions.
  if (!parsed.substep) {
    throw new Error(`--step ${target.stepId} must include a substep (e.g., "${parsed.step}.1")`);
  }
  const validIds = activeStep.substeps.map((s) => s.id);
  if (!validIds.includes(parsed.substep)) {
    throw new Error(
      `--step ${target.stepId}: substep "${parsed.substep}" does not exist in step "${parsed.step}". Valid substeps: ${validIds.join(', ')}`,
    );
  }

  // Reject template AT expressions — they cannot be resolved in pass/fail context.
  if (typeof parsed.at === 'string') {
    throw new Error(
      `--step ${target.stepId} uses template AT expression "${parsed.at}", which cannot be resolved here. Use --index <number> instead.`,
    );
  }

  // Numeric AT from a three-level id (`1.2.1`) is equivalent to `--index 2`;
  // an explicit iteration wins (the frontend already rejected conflicts).
  let resolvedIndex = target.iteration ?? parsed.at;

  // Default to the live iteration when inside a FOR step without an explicit index.
  if (
    resolvedIndex === undefined &&
    (activeStep.kind === 'for' || activeStep.kind === 'prompted-for')
  ) {
    resolvedIndex = deriveActiveFrame(activeState).iteration;
  }

  if (resolvedIndex !== undefined) {
    if (activeStep.kind !== 'for' && activeStep.kind !== 'prompted-for') {
      throw new Error(
        `--index requires step "${parsed.step}" to be a FOR or PROMPTED-FOR step, but it is "${activeStep.kind}"`,
      );
    }
    // Bounds checks only apply to 'for' steps (prompted-for has no forClause).
    if (activeStep.kind === 'for') {
      const fc = activeStep.forClause;
      if (resolvedIndex < fc.start) {
        throw new Error(
          `--index ${String(resolvedIndex)} is below FOR start ${String(fc.start)} for step "${parsed.step}"`,
        );
      }
      if ('end' in fc && resolvedIndex > fc.end) {
        throw new Error(
          `--index ${String(resolvedIndex)} exceeds FOR end ${String(fc.end)} for step "${parsed.step}"`,
        );
      }
    }
  }

  const targetFrameKey = buildFrameKey(parsed.step, resolvedIndex);
  const active = deriveActiveFrame(activeState);
  const activeFrameKey = activeState.activeFrameKey ?? active.frameKey;
  const activeEntry = activeState.activeEntry ?? 1;
  const frame =
    targetFrameKey === activeFrameKey
      ? activeFrame(targetFrameKey, activeEntry)
      : inactiveFrame(targetFrameKey);

  return {
    step: parsed.step,
    substep: parsed.substep,
    ...(resolvedIndex !== undefined ? { iteration: resolvedIndex } : {}),
    frame,
    at: deriveExecutionAt(parsed.step, parsed.substep, resolvedIndex),
  };
}
