import { describe, expect, it } from '@jest/globals';
import { prepareManualDelegation } from '../../src/runbook/manual-delegation-machine.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { makeDelegationCredentialIssuer } from '../../src/testing/delegation-fixtures.js';
import { makeState, makeSteps } from './delegation-service-fixtures.js';

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
});
