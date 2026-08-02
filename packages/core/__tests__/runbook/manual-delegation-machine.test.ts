import { describe, expect, it } from '@jest/globals';
import { StepDelegationSchema } from '../../src/schemas.js';
import { prepareManualDelegation } from '../../src/runbook/manual-delegation-machine.js';
import type { RunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { SubstepState } from '../../src/runbook/types.js';
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
