import { fromPromise } from 'xstate';

import type { ExecutionUnitEntry } from '../execution-unit-entry.js';
import type { RunbookState } from '../types.js';

/** Runtime callable for the machine-selected execution-unit entry. */
export type EnterRunProgressionUnit = (state: RunbookState) => Promise<ExecutionUnitEntry>;

/** Input to {@link runProgressionEntryActor}. */
export interface RunProgressionEntryActorInput {
  /** Exact durable state selected by this activation. */
  readonly state: RunbookState;
  /** Compile-time-bound execution-unit entry operation. */
  readonly enter: EnterRunProgressionUnit;
}

/** Entry result retaining the exact state that was rendered. */
export interface RunProgressionEntryActorOutput {
  readonly state: RunbookState;
  readonly entered: ExecutionUnitEntry;
}

/**
 * Machine-invoked actor that renders the execution-unit entry the machine
 * selected.
 *
 * Invoked from `__progression-enter-unit`. The entry is a pure render of the
 * state it was given; the actor performs no persistence and returns that exact
 * state beside the classified {@link ExecutionUnitEntry} so the observation and
 * the runtime's cursor cannot describe two different versions of the run.
 */
export const runProgressionEntryActor = fromPromise<
  RunProgressionEntryActorOutput,
  RunProgressionEntryActorInput
>(async ({ input }) => ({
  state: input.state,
  entered: await input.enter(input.state),
}));
