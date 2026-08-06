import { describe, expect, it } from '@jest/globals';
import { StepDelegationSchema } from '../../src/schemas.js';
import type { DelegationCredentialIssuer } from '../../src/runbook/delegation-credential.js';
import {
  prepareManualDelegation,
  type ManualDelegationPreparationEvent,
  type ManualDelegationPreparationInput,
} from '../../src/runbook/manual-delegation-machine.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, SubstepState } from '../../src/runbook/types.js';
import { makeDelegationCredentialIssuer } from '../../src/testing/delegation-fixtures.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { makeState, makeSteps } from './delegation-service-fixtures.js';

const CHILD_RUN_ID = brandRunIdForTest(`rd_${'d'.repeat(32)}`);

/** Attach a claimed child run to every issued delegation in the given substep states. */
function linkChildRun(
  substepStates: readonly SubstepState[],
  childRunId: RunId,
): readonly SubstepState[] {
  return substepStates.map((substep) =>
    substep.delegation === undefined
      ? substep
      : { ...substep, delegation: { ...substep.delegation, childRunId } },
  );
}

/** Issue a fresh delegation on substep `1.1` and return the prepared substep states. */
function issueFixture(): readonly SubstepState[] {
  const issued = prepareManualDelegation({
    state: makeState(),
    steps: makeSteps(),
    issueCredential: makeDelegationCredentialIssuer(),
    event: {
      type: 'ISSUE',
      stepId: '1.1',
      frameKey: buildFrameKey('1'),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
    },
  });
  if (issued.status !== 'prepared') throw new Error('expected prepared issue');
  return issued.substepStates;
}

/** Outcome of one preparation call observed for both throw paths. */
interface ObservedPreparation {
  /** Value thrown synchronously out of `prepareManualDelegation`. */
  readonly caught: unknown;
  /** Errors that escaped asynchronously through Node's unhandled-error paths. */
  readonly unhandled: readonly unknown[];
}

/**
 * Run one preparation call while watching for asynchronously escaping errors.
 *
 * A throw raised inside an XState `assign` action does not propagate out of
 * `actor.send`; XState re-reports it on a later event-loop turn, which
 * terminates the process rather than reaching the CLI error envelope. Watching
 * both paths is what makes the distinction observable: the error must arrive at
 * `caught`, and `unhandled` must stay empty.
 *
 * @param input - Exact preparation input to dispatch.
 * @returns The synchronously caught value plus anything reported asynchronously.
 * @throws {Error} If the call returned normally instead of throwing.
 */
async function observePreparationThrow(
  input: ManualDelegationPreparationInput,
): Promise<ObservedPreparation> {
  const unhandled: unknown[] = [];
  const record = (error: unknown): void => {
    unhandled.push(error);
  };
  process.on('uncaughtException', record);
  process.on('unhandledRejection', record);
  try {
    let threw = false;
    let caught: unknown;
    try {
      prepareManualDelegation(input);
    } catch (error) {
      threw = true;
      caught = error;
    }
    // XState reports an action throw on a later event-loop turn, so drain one
    // timer turn before concluding that nothing escaped asynchronously.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    if (!threw) throw new Error('expected prepareManualDelegation to throw');
    return { caught, unhandled };
  } finally {
    process.off('uncaughtException', record);
    process.off('unhandledRejection', record);
  }
}

describe('prepareManualDelegation', () => {
  it('prepares fresh issuance through a typed machine without mutating captured state', () => {
    const state = makeState();
    const captured = structuredClone(state);
    const result = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    expect(state).toEqual(captured);
    expect(result.substepStates[0]?.delegation).toEqual(
      expect.objectContaining({
        childRunbookPath: 'child.md',
        childRunId: null,
        credential: expect.objectContaining({ version: 1 }),
      }),
    );
  });

  it('prepares retry from the captured descriptor and supersedes its token hash', () => {
    const issuer = makeDelegationCredentialIssuer();
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');
    const oldHash = issued.substepStates[0]?.delegation?.tokenHash;
    if (oldHash === undefined) throw new Error('expected issued token hash');

    const retried = prepareManualDelegation({
      state: { ...state, substepStates: [...issued.substepStates] },
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(retried.status).toBe('prepared');
    if (retried.status !== 'prepared') return;
    expect(retried.substepStates[0]?.delegation?.credential).toEqual(
      expect.objectContaining({ supersedesTokenHash: oldHash }),
    );
    expect(retried.substepStates[0]?.delegation?.tokenHash).not.toBe(oldHash);
  });

  it('threads ISSUE extraVars into the issued delegation and its inherited context', () => {
    const result = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { region: 'ap-southeast-2' },
      },
    });

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') return;
    const delegation = result.substepStates[0]?.delegation;
    // `extraVars` is the ONLY channel an operator's `--input` has into the child.
    // Dropping it at this seam issues a delegation the child then resolves
    // against the parent's variables alone — a silently wrong run, not a refusal.
    expect(delegation?.extraVars).toEqual({ region: 'ap-southeast-2' });
    // Pinned on the snapshot as well because that is what the child actually
    // reads: carrying the value on the delegation row but omitting it from the
    // captured context would leave the operator's input equally invisible.
    expect(delegation?.contextSnapshot.vars).toEqual(
      expect.objectContaining({ region: 'ap-southeast-2' }),
    );
  });

  it('merges RETRY overrides over the inherited extraVars of the superseded delegation', () => {
    const issuer = makeDelegationCredentialIssuer();
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { region: 'us-east-1', tier: 'gold' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');

    const retried = prepareManualDelegation({
      state: { ...state, substepStates: [...issued.substepStates] },
      steps: makeSteps(),
      issueCredential: issuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
        overrides: { region: 'eu-west-1' },
      },
    });

    expect(retried.status).toBe('prepared');
    if (retried.status !== 'prepared') return;
    // Asymmetric on purpose: `region` must be REPLACED and `tier` must SURVIVE.
    // A seam that drops `overrides` keeps `us-east-1`; one that replaces the
    // inherited set wholesale loses `tier`. Only forwarding the overrides into
    // the documented merge satisfies both halves.
    expect(retried.substepStates[0]?.delegation?.extraVars).toEqual({
      region: 'eu-west-1',
      tier: 'gold',
    });
    expect(retried.substepStates[0]?.delegation?.contextSnapshot.vars).toEqual(
      expect.objectContaining({ region: 'eu-west-1', tier: 'gold' }),
    );
  });

  it('prepares parent cancellation through the typed abort event', () => {
    const state = makeState();
    const issued = prepareManualDelegation({
      state,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });
    if (issued.status !== 'prepared') throw new Error('expected prepared issue');
    const issuedState = { ...state, substepStates: [...issued.substepStates] };

    const aborted = prepareManualDelegation({
      state: issuedState,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ABORT',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        force: false,
      },
    });

    expect(aborted.status).toBe('prepared');
    if (aborted.status !== 'prepared') return;
    expect(issuedState.substepStates[0]?.delegation?.cancelledAt).toBeNull();
    expect(aborted.substepStates[0]?.delegation?.cancelledAt).toEqual(expect.any(String));
  });

  it('refuses a repeated abort as already_cancelled without a state change', () => {
    const state = makeState();
    const aborted = prepareManualDelegation({
      state: { ...state, substepStates: [...issueFixture()] },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });
    if (aborted.status !== 'prepared') throw new Error('expected prepared abort');

    const repeated = prepareManualDelegation({
      state: { ...state, substepStates: [...aborted.substepStates] },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(repeated).toEqual({ status: 'already_cancelled' });
  });

  it('refuses aborting a claimed delegation with needs_force and its child run id', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(refused).toEqual({ status: 'needs_force', childRunId: CHILD_RUN_ID });
  });

  it('propagates the linked child run id when retry refuses an in-flight delegation', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(refused.status).toBe('child_in_flight');
    if (refused.status !== 'child_in_flight') return;
    expect(refused.childRunId).toBe(CHILD_RUN_ID);
    expect(refused.error).toEqual(
      expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    );
  });

  it('propagates the claimed child run id when issuance refuses a live delegation', () => {
    const state = makeState();

    const refused = prepareManualDelegation({
      state: { ...state, substepStates: linkChildRun(issueFixture(), CHILD_RUN_ID) },
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(refused.status).toBe('child_in_flight');
    if (refused.status !== 'child_in_flight') return;
    expect(refused.childRunId).toBe(CHILD_RUN_ID);
    expect(refused.error).toEqual(
      expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    );
  });

  it('maps every other issue refusal to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'ISSUE',
        stepId: '9.9',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  it('maps every other retry refusal to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  it('maps an abort against a substep with no delegation to the generic error status', () => {
    const refused = prepareManualDelegation({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(refused).toEqual({
      status: 'error',
      error: expect.objectContaining({ code: expect.any(String), message: expect.any(String) }),
    });
  });

  it('rethrows an issuer throw from ISSUE unchanged instead of discarding it', async () => {
    const boom = new Error('issuer exploded during fresh issuance');
    const throwingIssuer: DelegationCredentialIssuer = () => {
      throw boom;
    };

    const { caught, unhandled } = await observePreparationThrow({
      state: makeState(),
      steps: makeSteps(),
      issueCredential: throwingIssuer,
      event: {
        type: 'ISSUE',
        stepId: '1.1',
        frameKey: buildFrameKey('1'),
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
      },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('rethrows an issuer throw from RETRY unchanged instead of discarding it', async () => {
    const boom = new Error('issuer exploded during retry');
    const throwingIssuer: DelegationCredentialIssuer = () => {
      throw boom;
    };

    const { caught, unhandled } = await observePreparationThrow({
      state: { ...makeState(), substepStates: [...issueFixture()] },
      steps: makeSteps(),
      issueCredential: throwingIssuer,
      event: {
        type: 'RETRY',
        substepId: '1',
        frameKey: buildFrameKey('1'),
        allowLinkedChildRun: false,
      },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('rethrows a primitive throw from ABORT unchanged instead of discarding it', async () => {
    const boom = new Error('captured state read exploded during abort');
    // `abortDelegation` takes no injected callable, so the failure is staged
    // where the primitive reads the captured state. The assertion is about the
    // action boundary, not about this particular read: any throw raised inside
    // the ABORT action must reach the caller.
    const hostileState: RunbookState = Object.defineProperty({ ...makeState() }, 'substepStates', {
      configurable: true,
      enumerable: true,
      get: () => {
        throw boom;
      },
    });

    const { caught, unhandled } = await observePreparationThrow({
      state: hostileState,
      steps: makeSteps(),
      issueCredential: makeDelegationCredentialIssuer(),
      event: { type: 'ABORT', substepId: '1', frameKey: buildFrameKey('1'), force: false },
    });

    expect(caught).toBe(boom);
    expect(unhandled).toEqual([]);
  });

  it('still reports the generic failure when a dispatched event yields no result and no throw', () => {
    // An event the machine declares no handler for is dropped by XState, so
    // neither a result nor a captured throw lands in context. That is the only
    // case the generic guard is allowed to describe.
    expect(() =>
      prepareManualDelegation({
        state: makeState(),
        steps: makeSteps(),
        issueCredential: makeDelegationCredentialIssuer(),
        event: { type: 'UNHANDLED' } as unknown as ManualDelegationPreparationEvent,
      }),
    ).toThrow('Manual delegation machine produced no result.');
  });

  it('inherits the child run id brand from persisted-state validation, not a boundary assert', () => {
    // The live-child refusals surface `StepDelegation.childRunId` verbatim, so
    // the brand is guaranteed where the state is admitted rather than re-checked
    // downstream: a non-canonical id never survives the load that produces the
    // captured state the machine is handed. Pinned here because it is the reason
    // this module does not re-assert the brand itself.
    const delegation = issueFixture()[0]?.delegation;
    if (!delegation) throw new Error('expected an issued delegation');

    expect(
      StepDelegationSchema.safeParse({ ...delegation, childRunId: 'not-a-run-id' }).success,
    ).toBe(false);
    expect(
      StepDelegationSchema.safeParse({ ...delegation, childRunId: CHILD_RUN_ID }).success,
    ).toBe(true);
  });
});
