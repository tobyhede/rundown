import { describe, it, expect } from '@jest/globals';
import { createDelegation, type DelegateOptions } from '../../src/runbook/delegation-service.js';
import { hashDelegationToken, TOKEN_PREFIX } from '../../src/runbook/delegation-token.js';
import type { RunbookState, Step, AncestorSnapshot } from '../../src/runbook/types.js';

/** Helper: create minimal RunbookState for testing. */
function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
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
    substepStates: [
      { id: '1', status: 'pending' },
      { id: '2', status: 'pending' },
    ],
    templateVars: { env: 'staging' },
    ...overrides,
  } as RunbookState;
}

/** Helper: create minimal Step[] for testing. */
function makeSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly Step[] {
  return [
    {
      name: stepName,
      description: 'Test step',
      substeps: substepIds.map((id) => ({
        id,
        description: `Substep ${id}`,
      })),
    },
  ] as readonly Step[];
}

/** Helper: create steps without substeps. */
function makeSimpleSteps(stepName = '1'): readonly Step[] {
  return [
    {
      name: stepName,
      description: 'Simple step',
    },
  ] as readonly Step[];
}

describe('createDelegation', () => {
  it('succeeds on a step with substeps', () => {
    const state = makeState();
    const steps = makeSteps();
    const options: DelegateOptions = {
      state,
      stepId: '1.1',
      childRunbookPath: 'child.md',
    };

    const result = createDelegation(options, steps);

    expect(result.token).toBeDefined();
    expect(result.tokenHash).toBeDefined();
    expect(result.delegation).toBeDefined();
    expect(result.updatedSubstepStates).toBeDefined();
  });

  it('returns a token with correct format', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps);

    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(result.token.length).toBe(37);
  });

  it('returns hash that matches token', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps);

    expect(result.tokenHash).toBe(hashDelegationToken(result.token));
  });

  it('delegation has correct fields', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps);

    expect(result.delegation.childRunbookPath).toBe('child.md');
    expect(result.delegation.childRunId).toBeNull();
    expect(result.delegation.cancelledAt).toBeNull();
    expect(result.delegation.tokenHash).toBe(result.tokenHash);
    expect(result.delegation.createdAt).toBeDefined();
  });

  it('throws DELEGATION_STEP_NOT_FOUND for missing step', () => {
    const state = makeState();
    const steps = makeSteps();

    expect(() =>
      createDelegation({ state, stepId: '99.1', childRunbookPath: 'child.md' }, steps),
    ).toThrow(/step not found/i);
  });

  it('throws DELEGATION_SUBSTEP_REQUIRED when bare step ID given for step with substeps', () => {
    const state = makeState();
    const steps = makeSteps();

    expect(() =>
      createDelegation({ state, stepId: '1', childRunbookPath: 'child.md' }, steps),
    ).toThrow(/substep.*required/i);
  });

  it('throws DELEGATION_STEP_NOT_CURRENT when step is not at frontier', () => {
    const state = makeState({ step: '2' });
    const steps = [...makeSteps('1'), { name: '2', description: 'Step 2' }] as readonly Step[];

    expect(() =>
      createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps),
    ).toThrow(/not at execution frontier/i);
  });

  it('throws DELEGATION_ALREADY_EXISTS for duplicate active delegation', () => {
    const existingDelegation = {
      tokenHash: 'sha256:' + 'a'.repeat(64),
      childRunbookPath: 'other-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const state = makeState({
      substepStates: [
        { id: '1', status: 'pending', delegation: existingDelegation },
        { id: '2', status: 'pending' },
      ],
    });
    const steps = makeSteps();

    expect(() =>
      createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps),
    ).toThrow(/active delegation exists/i);
  });

  it('allows re-delegation when previous delegation is cancelled', () => {
    const cancelledDelegation = {
      tokenHash: 'sha256:' + 'a'.repeat(64),
      childRunbookPath: 'other-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: '2026-02-27T11:00:00.000Z',
    };
    const state = makeState({
      substepStates: [
        { id: '1', status: 'pending', delegation: cancelledDelegation },
        { id: '2', status: 'pending' },
      ],
    });
    const steps = makeSteps();

    const result = createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps);

    expect(result.token).toBeDefined();
    // The updated substep should have the new delegation
    const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(updated?.delegation?.cancelledAt).toBeNull();
    expect(updated?.delegation?.childRunbookPath).toBe('child.md');
  });

  it('captures state.templateVars in context snapshot', () => {
    const state = makeState({ templateVars: { env: 'prod', version: '2.0' } });
    const steps = makeSteps();
    const result = createDelegation({ state, stepId: '1.1', childRunbookPath: 'child.md' }, steps);

    expect(result.delegation.contextSnapshot.vars).toEqual({
      env: 'prod',
      version: '2.0',
    });
  });

  it('includes provided ancestors in snapshot', () => {
    const ancestors: readonly AncestorSnapshot[] = [
      {
        runId: 'grandparent-1',
        runbook: 'grandparent.md',
        step: '1',
        substep: null,
        vars: { key: 'value' },
      },
    ];
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', ancestors },
      steps,
    );

    expect(result.delegation.contextSnapshot.ancestors).toHaveLength(1);
    expect(result.delegation.contextSnapshot.ancestors[0].runId).toBe('grandparent-1');
  });

  it('merges extra vars into snapshot vars', () => {
    const state = makeState({ templateVars: { env: 'staging' } });
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { version: '3.0', env: 'override' },
      },
      steps,
    );

    expect(result.delegation.contextSnapshot.vars).toEqual({
      env: 'override',
      version: '3.0',
    });
  });

  it('preserves existing substepStates when adding delegation', () => {
    const state = makeState({
      substepStates: [
        { id: '1', status: 'running', agentId: 'agent-a' },
        { id: '2', status: 'pending' },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation({ state, stepId: '1.2', childRunbookPath: 'child.md' }, steps);

    // Substep 1 should be untouched
    const ss1 = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(ss1?.agentId).toBe('agent-a');
    expect(ss1?.delegation).toBeUndefined();

    // Substep 2 should have delegation
    const ss2 = result.updatedSubstepStates.find((ss) => ss.id === '2');
    expect(ss2?.delegation).toBeDefined();
    expect(ss2?.delegation?.childRunbookPath).toBe('child.md');
  });

  it('works for simple step without substeps', () => {
    const state = makeState({
      substepStates: undefined,
    });
    const steps = makeSimpleSteps();
    const result = createDelegation({ state, stepId: '1', childRunbookPath: 'child.md' }, steps);

    expect(result.token).toBeDefined();
    // Should create a synthetic substep state entry
    expect(result.updatedSubstepStates).toHaveLength(1);
    expect(result.updatedSubstepStates[0].id).toBe('1');
    expect(result.updatedSubstepStates[0].delegation).toBeDefined();
  });
});
