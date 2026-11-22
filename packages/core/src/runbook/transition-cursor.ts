/**
 * The `--step` / `--index` contract for `rundown pass` / `rundown fail` (#901,
 * ADR 0005).
 *
 * Under one writer per run the machine is in exactly one leaf, so a manual
 * transition can only land on the run's CURRENT position. `--step` is therefore
 * not a selector but a confirmation: the caller states which unit it believes
 * it is completing, and the seam refuses when that belief and the run disagree.
 * Every refusal names the current position so the operator's next command can
 * be written from the message alone, and nothing is written on refusal.
 *
 * @module runbook/transition-cursor
 */

import { parseStepIdFromString, resolvedStepHasSubsteps } from '@rundown-org/parser';
import type { ResolvedStep } from '@rundown-org/parser';
import { activeFrame, deriveActiveFrame, deriveExecutionAt, type Frame } from './targeting.js';
import type { RunbookState } from './types.js';

/**
 * Raw explicit `--step` / `--index` transition target.
 *
 * Category-A parsing (raw CLI strings to a step id + numeric iteration) is the
 * frontend's job; every state-dependent decision is made by
 * {@link resolveTransitionCursor} against the exact state the seam loaded.
 */
export interface ExplicitTransitionTarget {
  /** Raw qualified step id (e.g. `2`, `2.1` or `1.3.1`). */
  readonly stepId: string;
  /** Numeric `--index` iteration, when supplied (pre-parsed by the frontend). */
  readonly iteration?: number;
}

/**
 * The run position a `--step` / `--index` target was confirmed against.
 *
 * Produced by {@link resolveTransitionCursor}. Always the run's current
 * position: the contract admits nothing else.
 */
export interface TransitionCursor {
  /** Current step id. */
  readonly step: string;
  /** Current substep id, when the cursor is at a substep. */
  readonly substep?: string;
  /** Current FOR iteration, when the cursor is inside a FOR frame. */
  readonly iteration?: number;
  /** The active frame and its entry ordinal. */
  readonly frame: Frame;
  /** Qualified position string (e.g. `2.1`, `1.3.1`). */
  readonly at: string;
}

/**
 * Caller-input refusal of a `--step` / `--index` target.
 *
 * The target is outside the contract for the state it was resolved against. It
 * is a value rather than a throw so the lifecycle seam refuses it BEFORE any
 * state is written and the frontend renders it as `INVALID_STEP`. The message
 * always names the current position and never carries a secret.
 */
export interface InvalidStepTargetRefusal {
  readonly kind: 'invalid_step_target';
  /** Why the target was refused, naming the current position. */
  readonly message: string;
}

/** Outcome of resolving a `--step` / `--index` target. */
export type TransitionCursorResolution =
  | { readonly kind: 'resolved'; readonly cursor: TransitionCursor }
  | InvalidStepTargetRefusal;

/**
 * Confirm a `--step` / `--index` target against the run's current position.
 *
 * The rules, in the order they are checked:
 *
 * 1. `--step` is required.
 * 2. The step id must parse; a template AT expression is refused.
 * 3. The step must be the active step.
 * 4. At a substep, `--step` must name that substep; a bare step id is refused.
 *    At a top-level step with no active substep, the bare step id is accepted
 *    and a substep-qualified id is refused.
 * 5. Inside a FOR iteration, `--index` (or the AT slot of a three-level id) is
 *    required and must name the current iteration. Outside one, any index is
 *    refused.
 *
 * Pure — no IO, nothing written.
 *
 * @param steps - Parsed runbook steps for the run
 * @param state - Run state the target is confirmed against
 * @param target - Raw `--step` / `--index` target, or `undefined` when the
 *   caller supplied no `--step`
 * @returns The confirmed cursor, or an `invalid_step_target` refusal naming the
 *   current position
 * @throws {Error} when the active step is absent from `steps` — a state /
 *   definition mismatch the seam's freshness check already excludes, not a
 *   caller-input error
 */
export function resolveTransitionCursor(
  steps: readonly ResolvedStep[],
  state: RunbookState,
  target: ExplicitTransitionTarget | undefined,
): TransitionCursorResolution {
  return resolveCursor(steps, state, target, 'current');
}

/**
 * Outcome of resolving `rundown retry`'s `--step` / `--index` target (#905).
 *
 * `substep` is the substep `--step` named: any substep of the active step,
 * not only the cursor's, since a fan-out's later Delegations are reserved
 * with the cursor's.
 */
export type RetryTargetResolution =
  | {
      readonly kind: 'resolved';
      readonly cursor: TransitionCursor;
      /** The substep `--step` named. */
      readonly substep: string;
    }
  | InvalidStepTargetRefusal;

/**
 * Confirm `rundown retry`'s `--step` / `--index` target against the run's
 * current position (#905).
 *
 * The rules of {@link resolveTransitionCursor}, except that `--step` must
 * name a substep and may name any substep of the active step — one the step
 * defines; a substep it does not define is refused like any other wrong
 * position. Whether that substep delegates is the caller's decision.
 *
 * @param steps - Parsed runbook steps for the run
 * @param state - Run state the target is confirmed against
 * @param target - Raw `--step` / `--index` target, or `undefined` when the
 *   caller supplied no `--step`
 * @returns The confirmed cursor and named substep, or a refusal naming the
 *   current position
 * @throws {Error} when the active step is absent from `steps`
 */
export function resolveRetryTarget(
  steps: readonly ResolvedStep[],
  state: RunbookState,
  target: ExplicitTransitionTarget | undefined,
): RetryTargetResolution {
  const resolution = resolveCursor(steps, state, target, 'any_substep');
  if (resolution.kind !== 'resolved') return resolution;
  const substep = target === undefined ? undefined : parseStepIdFromString(target.stepId)?.substep;
  if (substep === undefined) throw new Error('A retry target resolved without a substep');
  return { ...resolution, substep };
}

/**
 * The shared `--step` / `--index` rules.
 *
 * @param steps - Parsed runbook steps for the run
 * @param state - Run state the target is confirmed against
 * @param target - Raw target, or `undefined` without `--step`
 * @param substepRule - `current`: `--step` names the cursor's own unit;
 *   `any_substep`: it names some substep of the active step
 * @returns The confirmed cursor, or a refusal naming the current position
 * @throws {Error} when the active step is absent from `steps`
 */
function resolveCursor(
  steps: readonly ResolvedStep[],
  state: RunbookState,
  target: ExplicitTransitionTarget | undefined,
  substepRule: 'current' | 'any_substep',
): TransitionCursorResolution {
  const invalid = (message: string): TransitionCursorResolution => ({
    kind: 'invalid_step_target',
    message,
  });
  const activeStep = steps.find((candidate) => candidate.name === state.step);
  if (!activeStep) {
    throw new Error(`Step "${state.step}" not found`);
  }
  const active = deriveActiveFrame(state);
  const at = deriveExecutionAt(state.step, state.substep, active.iteration);

  if (target === undefined) {
    return invalid(`--step is required; the current position is ${at}`);
  }

  const parsed = parseStepIdFromString(target.stepId);
  if (!parsed) {
    return invalid(`Invalid step target: ${target.stepId}`);
  }
  if (typeof parsed.at === 'string') {
    return invalid(
      `--step ${target.stepId} uses template AT expression "${parsed.at}", which cannot be resolved here. Use --index <number> instead.`,
    );
  }
  if (parsed.step !== state.step) {
    return invalid(
      `--step ${target.stepId} targets step "${parsed.step}" but the active step is "${state.step}"`,
    );
  }

  if (substepRule === 'any_substep') {
    if (parsed.substep === undefined || state.substep === undefined) {
      return invalid(
        `--step ${target.stepId} must name a delegated substep of step "${state.step}"; the current position is ${at}`,
      );
    }
    const named = parsed.substep;
    if (
      !resolvedStepHasSubsteps(activeStep) ||
      !activeStep.substeps.some((substep) => substep.id === named)
    ) {
      return invalid(
        `--step ${target.stepId} names substep "${named}" but step "${state.step}" has no substep "${named}"; the current position is ${at}`,
      );
    }
  } else if (parsed.substep !== undefined) {
    if (state.substep === undefined) {
      return invalid(
        `--step ${target.stepId} names substep "${parsed.substep}" but step "${state.step}" has no active substep`,
      );
    }
    if (parsed.substep !== state.substep) {
      return invalid(
        `--step ${target.stepId} names substep "${parsed.substep}" but the current position is ${at}`,
      );
    }
  } else if (state.substep !== undefined) {
    return invalid(
      `--step ${target.stepId} must name the current substep; the current position is ${at}`,
    );
  }

  // Numeric AT from a three-level id (`1.3.1`) is equivalent to `--index 3`;
  // an explicit iteration wins (the frontend already rejected conflicts).
  const requested = target.iteration ?? parsed.at;
  if (active.iteration === undefined) {
    if (requested !== undefined) {
      return activeStep.kind === 'for' || activeStep.kind === 'prompted-for'
        ? invalid(
            `--index ${String(requested)} was given but step "${state.step}" is not at a FOR iteration`,
          )
        : invalid(
            `--index requires step "${state.step}" to be a FOR or PROMPTED-FOR step, but it is "${activeStep.kind}"`,
          );
    }
  } else {
    if (requested === undefined) {
      return invalid(
        `--index is required inside FOR step "${state.step}" (current iteration ${String(active.iteration)})`,
      );
    }
    if (requested !== active.iteration) {
      return invalid(
        `--index ${String(requested)} names iteration ${String(requested)} of FOR step "${state.step}" but the current iteration is ${String(active.iteration)}`,
      );
    }
  }

  const frameKey = state.activeFrameKey ?? active.frameKey;
  return {
    kind: 'resolved',
    cursor: {
      step: state.step,
      ...(state.substep === undefined ? {} : { substep: state.substep }),
      ...(active.iteration === undefined ? {} : { iteration: active.iteration }),
      frame: activeFrame(frameKey, state.activeEntry ?? 1),
      at,
    },
  };
}
