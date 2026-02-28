import { describe, it, expect } from '@jest/globals';
import { abortDelegation } from '../../src/runbook/delegation-service.js';
import type { RunbookState, StepDelegation, SubstepState } from '../../src/runbook/types.js';

/** Helper: create a delegation object. */
function makeDelegation(overrides: Partial<StepDelegation> = {}): StepDelegation {
  return {
    tokenHash: `sha256:${'a'.repeat(64)}`,
    childRunbookPath: 'child.md',
    contextSnapshot: { vars: {}, ancestors: [] },
    childRunId: null,
    createdAt: '2026-02-27T10:00:00.000Z',
    cancelledAt: null,
    ...overrides,
  };
}

/** Helper: create minimal RunbookState for testing. */
function makeState(substepStates: SubstepState[]): RunbookState {
  return {
    id: 'run-1',
    runbook: 'parent.md',
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Main step',
    retryCount: 0,
    variables: {},
    steps: [{ id: '1', status: 'running' }],
    pendingSteps: [],
    agentBindings: {},
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    substepStates,
  };
}

describe('abortDelegation', () => {
  it('cancels a pending delegation (cancelledAt set, other substeps unchanged)', () => {
    const delegation = makeDelegation();
    const state = makeState([
      { id: '1', status: 'pending', delegation },
      { id: '2', status: 'pending' },
    ]);

    const result = abortDelegation({ parentState: state, substepId: '1' });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      // Target substep has cancelledAt set
      const updated1 = result.updatedSubstepStates.find((ss) => ss.id === '1');
      expect(updated1?.delegation?.cancelledAt).toBeDefined();
      expect(updated1?.delegation?.cancelledAt).not.toBeNull();

      // Other substep is unchanged
      const updated2 = result.updatedSubstepStates.find((ss) => ss.id === '2');
      expect(updated2?.delegation).toBeUndefined();
    }
  });

  it('returns already_cancelled for idempotent re-cancel', () => {
    const delegation = makeDelegation({ cancelledAt: '2026-02-27T11:00:00.000Z' });
    const state = makeState([{ id: '1', status: 'pending', delegation }]);

    const result = abortDelegation({ parentState: state, substepId: '1' });

    expect(result.status).toBe('already_cancelled');
  });

  it('returns needs_force when delegation is claimed without force', () => {
    const delegation = makeDelegation({ childRunId: 'child-run-1' });
    const state = makeState([{ id: '1', status: 'pending', delegation }]);

    const result = abortDelegation({ parentState: state, substepId: '1' });

    expect(result.status).toBe('needs_force');
    if (result.status === 'needs_force') {
      expect(result.childRunId).toBe('child-run-1');
    }
  });

  it('cancels a claimed delegation when force=true', () => {
    const delegation = makeDelegation({ childRunId: 'child-run-1' });
    const state = makeState([{ id: '1', status: 'pending', delegation }]);

    const result = abortDelegation({ parentState: state, substepId: '1', force: true });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
      expect(updated?.delegation?.cancelledAt).toBeDefined();
      expect(updated?.delegation?.cancelledAt).not.toBeNull();
    }
  });

  it('throws RD-801 for missing substep', () => {
    const state = makeState([{ id: '1', status: 'pending' }]);

    expect(() => abortDelegation({ parentState: state, substepId: '99' })).toThrow(
      /step not found/i,
    );
  });

  it('throws RD-801 for substep without delegation', () => {
    const state = makeState([{ id: '1', status: 'pending' }]);

    expect(() => abortDelegation({ parentState: state, substepId: '1' })).toThrow(
      /step not found/i,
    );
  });
});
