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

/** Execute the frontier turn selected by the compiled runbook machine. */
export const runProgressionFrontierActor = fromPromise<
  FencedReEntryProjection,
  RunProgressionFrontierActorInput
>(async ({ input }) => input.project(input.state));

/** Enter the ordinary execution unit selected by the compiled runbook machine. */
export const runProgressionEntryActor = fromPromise<
  RunProgressionEntryActorOutput,
  RunProgressionEntryActorInput
>(async ({ input }) => ({
  state: input.state,
  entered: await input.enter(input.state, input.frontier),
}));
