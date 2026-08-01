import { assign, createActor, setup } from 'xstate';

import type { RundownError } from '../errors/rundown-error.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import { abortDelegation, createDelegation, retryDelegation } from './delegation-service.js';
import type { RunbookRef } from './runbook-ref.js';
import type { FrameKey } from './targeting.js';
import type { ResolvedStep, RunbookState, SubstepState, TemplateVarValue } from './types.js';

/** Typed command accepted by the manual-delegation preparation machine. */
export type ManualDelegationPreparationEvent =
  | {
      readonly type: 'ISSUE';
      readonly stepId: string;
      readonly frameKey: FrameKey;
      readonly childRunbookPath: string;
      readonly childRunbookRef: RunbookRef;
      readonly extraVars?: Readonly<Record<string, TemplateVarValue>>;
    }
  | {
      readonly type: 'RETRY';
      readonly substepId: string;
      readonly frameKey: FrameKey;
      readonly allowLinkedChildRun: boolean;
      readonly overrides?: Readonly<Record<string, TemplateVarValue>>;
    }
  | {
      readonly type: 'ABORT';
      readonly substepId: string;
      readonly frameKey: FrameKey;
      readonly force: boolean;
    };

/** Result prepared by the manual-delegation state machine. */
export type ManualDelegationPreparationResult =
  | { readonly status: 'prepared'; readonly substepStates: readonly SubstepState[] }
  | { readonly status: 'already_cancelled' }
  | { readonly status: 'needs_force'; readonly childRunId: string }
  | { readonly status: 'error'; readonly error: RundownError };

interface ManualDelegationContext {
  readonly state: RunbookState;
  readonly result?: ManualDelegationPreparationResult;
}

/** Input bound when constructing one manual-delegation preparation machine. */
export interface ManualDelegationPreparationInput {
  /** Exact captured parent state. */
  readonly state: RunbookState;
  /** Parsed parent steps corresponding to the captured state. */
  readonly steps: readonly ResolvedStep[];
  /** Verified claim-bound credential issuer retained outside machine context. */
  readonly issueCredential: DelegationCredentialIssuer;
  /** Typed issue or retry command. */
  readonly event: ManualDelegationPreparationEvent;
}

/**
 * Prepare manual delegation issuance through a dedicated typed XState machine.
 *
 * The machine is ephemeral and never persists its context. Runtime authority is
 * bound in the machine-construction closure, while the context itself contains
 * only the captured run state data. The caller commits the returned substep
 * state through the aggregate execution fence.
 *
 * @param input - Exact state, parsed steps, verified issuer, and typed command.
 * @returns Prepared substep state or the domain refusal produced by core delegation logic.
 */
export function prepareManualDelegation(
  input: ManualDelegationPreparationInput,
): ManualDelegationPreparationResult {
  const machine = setup({
    types: {
      context: {} as ManualDelegationContext,
      events: {} as ManualDelegationPreparationEvent,
    },
  }).createMachine({
    initial: 'ready',
    context: { state: input.state },
    states: {
      ready: {
        on: {
          ISSUE: {
            actions: assign({
              result: ({ context, event }) => {
                const result = createDelegation(
                  {
                    state: context.state,
                    stepId: event.stepId,
                    childRunbookPath: event.childRunbookPath,
                    childRunbookRef: event.childRunbookRef,
                    ...(event.extraVars === undefined ? {} : { extraVars: event.extraVars }),
                    ancestors: [],
                    frameKey: event.frameKey,
                    issueCredential: input.issueCredential,
                  },
                  input.steps,
                );
                return result.status === 'created'
                  ? { status: 'prepared', substepStates: result.updatedSubstepStates }
                  : { status: 'error', error: result.error };
              },
            }),
          },
          RETRY: {
            actions: assign({
              result: ({ context, event }) => {
                const result = retryDelegation(
                  {
                    state: context.state,
                    substepId: event.substepId,
                    frameKey: event.frameKey,
                    allowLinkedChildRun: event.allowLinkedChildRun,
                    issueCredential: input.issueCredential,
                    ...(event.overrides === undefined ? {} : { overrides: event.overrides }),
                  },
                  input.steps,
                );
                return result.status === 'retried'
                  ? { status: 'prepared', substepStates: result.updatedSubstepStates }
                  : { status: 'error', error: result.error };
              },
            }),
          },
          ABORT: {
            actions: assign({
              result: ({ context, event }) => {
                const result = abortDelegation({
                  parentState: context.state,
                  substepId: event.substepId,
                  frameKey: event.frameKey,
                  force: event.force,
                });
                switch (result.status) {
                  case 'cancelled':
                    return { status: 'prepared', substepStates: result.updatedSubstepStates };
                  case 'already_cancelled':
                  case 'needs_force':
                    return result;
                  case 'not_found':
                    return { status: 'error', error: result.error };
                  default: {
                    const _exhaustive: never = result;
                    return _exhaustive;
                  }
                }
              },
            }),
          },
        },
      },
    },
  });
  const actor = createActor(machine);
  actor.start();
  try {
    actor.send(input.event);
    const result = actor.getSnapshot().context.result;
    if (result === undefined) throw new Error('Manual delegation machine produced no result.');
    return result;
  } finally {
    actor.stop();
  }
}
