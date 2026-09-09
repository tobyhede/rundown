import { fromPromise } from 'xstate';

import type { TerminalPropagationResult } from '../run-progression.js';

/** Input to the machine-owned inline terminal flow-back actor. */
export interface InlineTerminalFlowBackActorInput {
  /** Core-owned operation bound to the activation's exact runtime services. */
  readonly execute: () => Promise<TerminalPropagationResult | null>;
}

/**
 * Apply one inline terminal completion and resolve its parent activation.
 *
 * Runtime services remain outside persisted context and enter through the
 * invoke-input callable; the actor owns the asynchronous Category-B turn.
 */
export const inlineTerminalFlowBackActor = fromPromise<
  TerminalPropagationResult | null,
  InlineTerminalFlowBackActorInput
>(async ({ input }) => input.execute());
