/**
 * The Inline Child's Current Child reservation (#903, ADR 0005), as pure
 * computation over run state.
 *
 * A runbook-list substep without `DELEGATE` launches an Inline Child: a Child
 * Run owned by the same agent as its parent. When the cursor enters such a
 * substep the compiled machine reserves the child in the parent's own record —
 * a preallocated run id and the parent's context — keyed by the substep's frame
 * and that frame's entry. Run Progression then creates the child row under the
 * reserved id and drives it; when the child reaches a terminal, the same owner
 * Collects its Child Result into the parent.
 *
 * Everything here is Category B (pure computation): the machine calls
 * {@link reserveInlineChild} from an entry action, and Run Progression and the
 * lifecycle seam call {@link currentInlineReservation} to find the child the
 * parent currently counts.
 *
 * @module runbook/inline-child
 */

import { resolvedStepHasSubsteps } from '@rundown-org/parser';
import { buildContextSnapshot } from './delegation-context.js';
import type { InitialTemplateVars, VariableValue } from './effective-vars.js';
import type { RunId } from './run-id.js';
import { deriveActiveFrame, upsertSubstepStateChild, type FrameKey } from './targeting.js';
import type {
  ForContext,
  InlineChildReservation,
  Lifecycle,
  ResolvedStep,
  RunbookState,
  SubstepState,
} from './types.js';

/**
 * The one runbook an inline substep launches, or `undefined` when the substep
 * does not launch an Inline Child.
 *
 * A substep launches one when it lists exactly one runbook and is not
 * `DELEGATE`. Longer lists are refused at run creation
 * (`findUnsupportedComposition`), so they never reach the machine.
 *
 * @param step - The step owning the substep.
 * @param substepId - The substep id.
 * @returns The authored (resolved) runbook reference, or `undefined`.
 */
export function inlineRunbookOf(step: ResolvedStep, substepId: string): string | undefined {
  if (!resolvedStepHasSubsteps(step)) return undefined;
  const substep = step.substeps.find((candidate) => candidate.id === substepId);
  if (substep === undefined || substep.delegate === true) return undefined;
  const runbooks = substep.runbooks ?? [];
  return runbooks.length === 1 ? runbooks[0] : undefined;
}

/** Input to {@link reserveInlineChild}. Plain data from the machine's context. */
export interface ReserveInlineChildInput {
  /** The parent's substep states before the reservation. */
  readonly substepStates: readonly SubstepState[];
  /** The step owning the inline substep. */
  readonly stepName: string;
  /** The inline substep. */
  readonly substepId: string;
  /** The runbook the child runs. */
  readonly runbook: string;
  /** The frame being entered. */
  readonly frameKey: FrameKey;
  /** That frame's entry, as the leaf's frame-entry sync made it current. */
  readonly entry: number;
  /** The parent's seeded template variables. */
  readonly templateVars: InitialTemplateVars;
  /** The parent's accumulated OUTPUTS and ARTIFACTS. */
  readonly variables: Readonly<Record<string, VariableValue>>;
  /** The parent's FOR stack; the child inherits the iteration binding. */
  readonly forStack: readonly ForContext[];
  /** The preallocated child run id. */
  readonly runId: RunId;
}

/**
 * Reserve a fresh Inline Child for one entry into an inline substep.
 *
 * Replaces whatever reservation the substep's frame carried: a reservation
 * from an earlier entry is stale the moment the frame is entered again, so
 * its child — finished or not — is never collected.
 *
 * @param input - The machine context the reservation is built from.
 * @returns The substep states with the reservation recorded.
 */
export function reserveInlineChild(input: ReserveInlineChildInput): readonly SubstepState[] {
  const child: InlineChildReservation = {
    kind: 'inline',
    runId: input.runId,
    entry: input.entry,
    runbook: input.runbook,
    contextSnapshot: buildContextSnapshot(
      {
        step: input.stepName,
        templateVars: input.templateVars,
        variables: input.variables,
        forStack: input.forStack,
      },
      input.substepId,
    ),
  };
  return upsertSubstepStateChild(input.substepStates, input.substepId, input.frameKey, child);
}

/**
 * The Inline Child the run's cursor currently counts, or `undefined`.
 *
 * Defined only when the cursor rests on an inline substep whose frame carries
 * a reservation made at the frame's active entry. A reservation from any other
 * entry is stale (#749).
 *
 * @param state - The parent run.
 * @returns The current reservation, or `undefined`.
 */
export function currentInlineReservation(state: RunbookState): InlineChildReservation | undefined {
  if (state.substep === undefined || state.activeEntry === undefined) return undefined;
  const { frameKey } = deriveActiveFrame(state);
  const child = state.substepStates?.find(
    (candidate) => candidate.id === state.substep && candidate.frameKey === frameKey,
  )?.child;
  return child?.kind === 'inline' && child.entry === state.activeEntry ? child : undefined;
}

/** A Child Result: the outcome a terminal child records in its own row. */
export type ChildResult = 'pass' | 'fail';

/**
 * Read a child's lifecycle as its Child Result.
 *
 * `completed` collects as pass; `stopped` and `abandoned` as fail. A running
 * child has no result yet.
 *
 * @param lifecycle - The child's persisted lifecycle.
 * @returns The Child Result, or `undefined` while the child runs.
 * @throws {Error} When the lifecycle is outside the closed union.
 */
export function childResultOf(lifecycle: Lifecycle | undefined): ChildResult | undefined {
  const value: Lifecycle = lifecycle ?? 'running';
  switch (value) {
    case 'running':
      return undefined;
    case 'completed':
      return 'pass';
    case 'stopped':
    case 'abandoned':
      return 'fail';
    default: {
      const _exhaustive: never = value;
      throw new Error(`Unknown lifecycle: ${String(_exhaustive)}`);
    }
  }
}
