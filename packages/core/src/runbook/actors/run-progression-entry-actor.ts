import { fromPromise } from 'xstate';

import type { ExecutionUnitEntry } from '../execution-unit-entry.js';
import type { FencedReEntryProjection } from '../re-entry-frontier.js';
import type { DelegateFrontierEntry } from '../../events/types.js';
import type { RunbookState } from '../types.js';

/** Runtime callable for the machine-selected re-entry frontier turn. */
export type ProjectRunProgressionFrontier = (
  state: RunbookState,
) => Promise<FencedReEntryProjection>;

/** Runtime callable for the machine-selected ordinary execution-unit entry. */
export type EnterRunProgressionUnit = (
  state: RunbookState,
  frontier?: readonly DelegateFrontierEntry[],
) => Promise<ExecutionUnitEntry>;

/** Input to {@link runProgressionFrontierActor}. */
export interface RunProgressionFrontierActorInput {
  /** Exact durable state selected by this activation. */
  readonly state: RunbookState;
  /** Compile-time-bound Category-C frontier operation. */
  readonly project: ProjectRunProgressionFrontier;
}

/** Input to {@link runProgressionEntryActor}. */
export interface RunProgressionEntryActorInput {
  /** Exact durable state selected by this activation. */
  readonly state: RunbookState;
  /** Compile-time-bound execution-unit entry operation. */
  readonly enter: EnterRunProgressionUnit;
  /** Transient bearers disclosed only after their frontier consume commits. */
  readonly frontier?: readonly DelegateFrontierEntry[];
}

/** Ordinary entry result retaining the exact state that was rendered. */
export interface RunProgressionEntryActorOutput {
  readonly state: RunbookState;
  readonly entered: ExecutionUnitEntry;
}

/**
 * Machine-invoked Category C actor for the fenced re-entry frontier turn.
 *
 * Invoked only after the compiled machine selects
 * `__progression-project-frontier`. The actor owns no frontier policy: it
 * hands the selected durable state to the compile-time-bound `project`
 * callable, which derives the projection under the SQLite execution fence and
 * commits `DELEGATE_FRONTIER_CONSUMED`. Its resolved
 * {@link FencedReEntryProjection} carries the transient bearers only on the
 * `projected` arm, after that commit landed, for the machine's
 * projected-frontier entry state to disclose exactly once.
 */
export const runProgressionFrontierActor = fromPromise<
  FencedReEntryProjection,
  RunProgressionFrontierActorInput
>(async ({ input }) => input.project(input.state));

/**
 * Machine-invoked actor that renders the execution-unit entry the machine
 * selected.
 *
 * Invoked from both `__progression-enter-unit` (no frontier) and
 * `__progression-enter-after-projected-frontier` (with the bearers the
 * frontier actor disclosed). The entry is a pure render of the state it was
 * given; the actor performs no persistence and returns that exact state
 * beside the classified {@link ExecutionUnitEntry} so the observation and the
 * runtime's cursor cannot describe two different versions of the run.
 */
export const runProgressionEntryActor = fromPromise<
  RunProgressionEntryActorOutput,
  RunProgressionEntryActorInput
>(async ({ input }) => ({
  state: input.state,
  entered: await input.enter(input.state, input.frontier),
}));
