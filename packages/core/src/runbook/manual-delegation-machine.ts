/**
 * Typed XState seam that prepares one manual delegation issue, retry, or abort.
 *
 * The design rationale — why a single-state machine is the intended shape
 * rather than scaffolding, how the prepared abort re-enters the compiled runbook
 * machine, and what is deliberately left open about the longer trajectory —
 * lives in `docs/internal/architecture.md`
 * § "Manual delegation preparation machine".
 *
 * @module runbook/manual-delegation-machine
 */

import { assign, createActor, setup } from 'xstate';

import type { RundownError } from '../errors/rundown-error.js';
import type { DelegationCredentialIssuer } from './delegation-credential.js';
import { abortDelegation, createDelegation, retryDelegation } from './delegation-service.js';
import type { RunId } from './run-id.js';
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

/**
 * Result prepared by the manual-delegation state machine.
 *
 * Every arm carries the `status` discriminant so callers narrow on the
 * discriminant rather than probing for structural fields. The two live-child
 * refusals are kept distinct because they carry different operator remedies:
 * `needs_force` is the idempotent abort refusal (retry the same abort with
 * `--force`), while `child_in_flight` refuses an issue/retry that would orphan
 * the running child (force-abort first, then reissue).
 */
export type ManualDelegationPreparationResult =
  /** Machine-prepared substep states the caller must commit through its fence. */
  | { readonly status: 'prepared'; readonly substepStates: readonly SubstepState[] }
  /** The targeted delegation was already cancelled; no state change is required. */
  | { readonly status: 'already_cancelled' }
  /** Abort refused: the delegation is claimed by a live child and needs `force`. */
  | { readonly status: 'needs_force'; readonly childRunId: RunId }
  /** Issue/retry refused: a live child run holds the targeted delegation. */
  | {
      readonly status: 'child_in_flight';
      /** Child run that must be force-aborted before the mutation can proceed. */
      readonly childRunId: RunId;
      /** Domain error raised by the refusing delegation primitive. */
      readonly error: RundownError;
    }
  /** Any other domain refusal produced by the core delegation primitives. */
  | { readonly status: 'error'; readonly error: RundownError };

/**
 * Handler map the `ready` state must declare, keyed by every event variant.
 *
 * XState does not require `on` to be total over the event union, so a new
 * {@link ManualDelegationPreparationEvent} variant would otherwise compile,
 * be silently ignored by the actor, and surface as a missing result. The
 * `satisfies` check on `ready.on` turns that into a compile error.
 */
type ManualDelegationReadyHandlers = {
  readonly [K in ManualDelegationPreparationEvent['type']]: unknown;
};

interface ManualDelegationContext {
  readonly state: RunbookState;
  readonly result?: ManualDelegationPreparationResult;
  /**
   * Unexpected throw raised by a delegation primitive, boxed for rethrow.
   *
   * Kept out of {@link ManualDelegationPreparationResult} on purpose: that
   * union models domain refusals, all carrying a `RundownError`, whereas this
   * field carries a programming or runtime failure that the caller must see
   * unchanged. Boxing keeps `thrown !== undefined` a faithful "the action
   * threw" test even when the thrown value is itself `undefined`.
   */
  readonly thrown?: { readonly error: unknown };
}

/** Context patch one delegation command produces: a result, or a captured throw. */
type ManualDelegationOutcome =
  | { readonly result: ManualDelegationPreparationResult }
  | { readonly thrown: { readonly error: unknown } };

/**
 * Run one delegation primitive so no throw reaches XState's action pipeline.
 *
 * A throw escaping an `assign` callback does not propagate out of
 * `actor.send()`: the send returns normally with the context unassigned, and
 * XState re-reports the error asynchronously through its unhandled-error path,
 * which terminates the process instead of reaching the CLI error envelope.
 * Catching here keeps the throw inside the machine's data, so
 * {@link prepareManualDelegation} can rethrow the original value.
 *
 * @param prepare - Delegation primitive call plus its result mapping.
 * @returns The prepared result, or the boxed value the primitive threw.
 */
function captureManualDelegationOutcome(
  prepare: () => ManualDelegationPreparationResult,
): ManualDelegationOutcome {
  try {
    return { result: prepare() };
  } catch (error) {
    return { thrown: { error } };
  }
}

/** Input bound when constructing one manual-delegation preparation machine. */
export interface ManualDelegationPreparationInput {
  /** Exact captured parent state. */
  readonly state: RunbookState;
  /** Parsed parent steps corresponding to the captured state. */
  readonly steps: readonly ResolvedStep[];
  /** Verified claim-bound credential issuer retained outside machine context. */
  readonly issueCredential: DelegationCredentialIssuer;
  /** Typed issue, retry, or abort command. */
  readonly event: ManualDelegationPreparationEvent;
}

/**
 * Prepare manual delegation issuance, retry, or abort through a dedicated typed
 * XState machine.
 *
 * The machine is ephemeral and never persists its context. Runtime authority is
 * bound in the machine-construction closure, while the context itself contains
 * only the captured run state data. The caller commits the returned substep
 * state through the aggregate execution fence.
 *
 * The live-child refusals carry `StepDelegation.childRunId` verbatim, so their
 * {@link RunId} brand comes from the persisted-state schema that admitted the
 * captured state — there is no re-assert at this boundary to restore it.
 *
 * An unexpected throw from a delegation primitive is not a domain refusal, so
 * it is never mapped onto {@link ManualDelegationPreparationResult}: the action
 * captures it into context (see {@link captureManualDelegationOutcome}) and
 * this function rethrows the original value, identity intact.
 *
 * @param input - Exact state, parsed steps, verified issuer, and typed command.
 * @returns Prepared substep state or the domain refusal produced by core delegation logic.
 * @throws {unknown} Whatever a delegation primitive threw, unchanged — the same
 *   value, not a wrapped or re-stringified copy.
 * @throws {Error} If the dispatched command produced neither a result nor a
 *   throw, which means the machine did not handle the event.
 */
export function prepareManualDelegation(
  input: ManualDelegationPreparationInput,
): ManualDelegationPreparationResult {
  const machineSetup = setup({
    types: {
      context: {} as ManualDelegationContext,
      events: {} as ManualDelegationPreparationEvent,
    },
  });
  const ready = machineSetup.createStateConfig({
    on: {
      ISSUE: {
        actions: assign(({ context, event }) =>
          captureManualDelegationOutcome(() => {
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
            switch (result.status) {
              case 'created':
                return { status: 'prepared', substepStates: result.updatedSubstepStates };
              case 'delegation_claimed':
                return {
                  status: 'child_in_flight',
                  childRunId: result.childRunId,
                  error: result.error,
                };
              case 'step_not_found':
              case 'step_not_current':
              case 'substep_required':
              case 'substep_not_found':
              case 'not_delegatable':
              case 'delegation_exists':
              case 'parent_is_delegated':
                return { status: 'error', error: result.error };
              default: {
                const _exhaustive: never = result;
                return _exhaustive;
              }
            }
          }),
        ),
      },
      RETRY: {
        actions: assign(({ context, event }) =>
          captureManualDelegationOutcome(() => {
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
            switch (result.status) {
              case 'retried':
                return { status: 'prepared', substepStates: result.updatedSubstepStates };
              case 'in_flight':
                return {
                  status: 'child_in_flight',
                  childRunId: result.childRunId,
                  error: result.error,
                };
              case 'not_found':
              case 'not_current':
              case 'error':
                return { status: 'error', error: result.error };
              default: {
                const _exhaustive: never = result;
                return _exhaustive;
              }
            }
          }),
        ),
      },
      ABORT: {
        actions: assign(({ context, event }) =>
          captureManualDelegationOutcome(() => {
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
          }),
        ),
      },
    },
  }) satisfies { readonly on: ManualDelegationReadyHandlers };
  const machine = machineSetup.createMachine({
    initial: 'ready',
    context: { state: input.state },
    states: { ready },
  });
  const actor = createActor(machine);
  actor.start();
  try {
    actor.send(input.event);
    const { result, thrown } = actor.getSnapshot().context;
    if (thrown !== undefined) throw thrown.error;
    if (result === undefined) throw new Error('Manual delegation machine produced no result.');
    return result;
  } finally {
    actor.stop();
  }
}
