import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ResolvedStep,
  Substep,
  SubstepState,
  StepDelegation,
} from '../../src/runbook/types.js';
// TDD red state: RetryWorkingState WILL FAIL to import until Task 4 exports it.
import type { RetryWorkingState } from '../../src/runbook/retry-hook.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { Errors } from '../../src/errors/factory.js';

// Same mock pattern as retry-hook.test.ts — control retryDelegation return values.
jest.unstable_mockModule('../../src/runbook/delegation-service.js', () => ({
  retryDelegation: jest.fn(),
}));

const { retryDelegation } = await import('../../src/runbook/delegation-service.js');
// TDD red state: retrySingleSubstep WILL FAIL to import until Task 4 exports it.
const { retrySingleSubstep } = await import('../../src/runbook/retry-hook.js');

const mockedRetryDelegation = retryDelegation as jest.MockedFunction<typeof retryDelegation>;

function makeInputs(overrides?: { substepStates?: readonly SubstepState[] }): {
  working: RetryWorkingState;
  substep: Substep;
  frameKey: ReturnType<typeof buildFrameKey>;
  parentName: string;
  steps: readonly ResolvedStep[];
  originalSubstepStates: readonly SubstepState[];
} {
  const frameKey = buildFrameKey('1');
  const parentName = '1';

  const substepTransitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
    fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
  };
  const parentTransitions = {
    pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
    fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
  };

  const substep: Substep = {
    kind: 'base',
    id: '1',
    description: 'Sub 1',
    transitions: substepTransitions,
  } as unknown as Substep;

  const parentStep = {
    kind: 'substeps',
    name: parentName,
    description: 'Parent',
    transitions: parentTransitions,
    aggregation: { strategy: 'ALL' as const },
    substeps: [substep],
  };
  const steps: ResolvedStep[] = [parentStep as unknown as ResolvedStep];

  const defaultDelegation: StepDelegation = {
    tokenHash: 'hash_test',
    childRunbookPath: 'child-1.md',
    childRunId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    cancelledAt: null,
    contextSnapshot: {
      vars: {},
      ancestors: [],
      step: '1',
      substep: '1',
      at: '1.1',
    },
  };

  const originalSubstepStates: readonly SubstepState[] = overrides?.substepStates ?? [
    {
      id: '1',
      frameKey,
      status: 'done',
      result: 'fail',
      delegation: defaultDelegation,
    },
  ];

  const working: RetryWorkingState = {
    step: parentName,
    substepStates: originalSubstepStates,
    templateVars: {},
    forStack: [],
    activeFrameKey: frameKey,
    variables: {},
  } as unknown as RetryWorkingState;

  return { working, substep, frameKey, parentName, steps, originalSubstepStates };
}

describe('retrySingleSubstep', () => {
  beforeEach(() => {
    mockedRetryDelegation.mockReset();
  });

  it('returns { status: "skipped" } when no substep state exists for the id', () => {
    const { working, substep, frameKey, parentName, steps } = makeInputs({ substepStates: [] });

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('skipped');
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('returns { status: "skipped" } when the substep state has no delegation record', () => {
    // Use the factory's frameKey to avoid double-construction. We still need
    // to materialize the SubstepState first because makeInputs accepts it as
    // an override; pull frameKey from the factory return on the next line.
    const dummyKey = buildFrameKey('1');
    const ss: SubstepState = { id: '1', frameKey: dummyKey, status: 'pending' };
    const { working, substep, frameKey, parentName, steps } = makeInputs({ substepStates: [ss] });

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('skipped');
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('returns { status: "retried" } with updated working and frontier entry using contextSnapshot.at', () => {
    const { working, substep, frameKey, parentName, steps, originalSubstepStates } = makeInputs();

    const newDelegation: StepDelegation = {
      tokenHash: 'hash_new',
      childRunbookPath: 'child-1.md',
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: {},
        ancestors: [],
        step: '1',
        substep: '1',
        at: '1.2.1',
        index: 2,
      },
    };
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'retried' as const,
      token: 'rdtk_new_token',
      tokenHash: 'hash_new',
      delegation: newDelegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('retried');
    if (outcome.status === 'retried') {
      // Canonical contextSnapshot.at is used — NOT the computed "1.1"
      expect(outcome.frontierEntry.id).toBe('1.2.1');
      expect(outcome.frontierEntry.id).not.toBe('1.1');
      expect(outcome.frontierEntry.runbook).toBe('child-1.md');
      expect(outcome.frontierEntry.token).toBe('rdtk_new_token');
      // working should be a new object (immutable update)
      expect(outcome.working).not.toBe(working);
      // The retried substep should be reset to pending with result cleared
      const retriedSubstep = outcome.working.substepStates?.find(
        (ss: SubstepState) => ss.id === '1' && ss.frameKey === frameKey,
      );
      expect(retriedSubstep?.status).toBe('pending');
      expect(retriedSubstep?.result).toBeUndefined();
    }
  });

  it('error variant on not_found surfaces wrapped RundownError code/message', () => {
    const { working, substep, frameKey, parentName, steps } = makeInputs();
    const inner = Errors.delegationStepNotFound('1');
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_found' as const,
      error: inner,
    }));

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.code).toBe(inner.code);
      expect(outcome.message).toBe(inner.message);
    }
    // Rollback invariant: error variant must NOT carry substepStates
    expect(Object.hasOwn(outcome, 'substepStates')).toBe(false);
  });

  it('error variant on not_current surfaces wrapped RundownError code/message', () => {
    const { working, substep, frameKey, parentName, steps } = makeInputs();
    const inner = Errors.delegationStepNotCurrent('2', '1');
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_current' as const,
      ownerStep: '2',
      currentStep: '1',
      error: inner,
    }));

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.code).toBe(inner.code);
      expect(outcome.message).toBe(inner.message);
    }
    // Rollback invariant: error variant must NOT carry substepStates
    expect(Object.hasOwn(outcome, 'substepStates')).toBe(false);
  });

  it('error variant from RD-904 on missing contextSnapshot.at does NOT carry substepStates', () => {
    const { working, substep, frameKey, parentName, steps, originalSubstepStates } = makeInputs();
    const delegationNoAt: StepDelegation = {
      tokenHash: 'hash_no_at',
      childRunbookPath: 'child-1.md',
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: {},
        ancestors: [],
        step: '1',
        substep: '1',
        // at intentionally omitted
      },
    };
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'retried' as const,
      token: 'rdtk_new_token',
      tokenHash: 'hash_no_at',
      delegation: delegationNoAt,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.code).toBe('RD-904');
      expect(outcome.message).toMatch(/contextSnapshot\.at/);
    }
    // Rollback invariant: error variant must NOT carry substepStates
    expect(Object.hasOwn(outcome, 'substepStates')).toBe(false);
  });

  it('error variant from retryDelegation result.status error propagates code + message', () => {
    const { working, substep, frameKey, parentName, steps } = makeInputs();
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'error' as const,
      error: { code: 'RD-XYZ', message: 'inner failure' },
    }));

    const outcome = retrySingleSubstep(working, substep, frameKey, parentName, steps);

    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') {
      expect(outcome.code).toBe('RD-XYZ');
      expect(outcome.message).toBe('inner failure');
    }
    // Rollback invariant: error variant must NOT carry substepStates
    expect(Object.hasOwn(outcome, 'substepStates')).toBe(false);
  });

  it('does not mutate the input working state', () => {
    const { working, substep, frameKey, parentName, steps, originalSubstepStates } = makeInputs();
    const snapshot = JSON.parse(JSON.stringify(working)) as RetryWorkingState;

    const newDelegation: StepDelegation = {
      tokenHash: 'hash_new',
      childRunbookPath: 'child-1.md',
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: {},
        ancestors: [],
        step: '1',
        substep: '1',
        at: '1.1',
      },
    };
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'retried' as const,
      token: 'rdtk_new_token',
      tokenHash: 'hash_new',
      delegation: newDelegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    retrySingleSubstep(working, substep, frameKey, parentName, steps);

    // Input working must be unchanged (immutability)
    expect(working).toEqual(snapshot);
  });
});
