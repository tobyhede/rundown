import { describe, it, expect } from '@jest/globals';
import { createDelegation } from '../../src/runbook/delegation-service.js';
import type { DelegateOptions } from '../../src/runbook/delegation-service.js';
import { hashDelegationToken, TOKEN_PREFIX } from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
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
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    substepStates: [
      { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
      { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
    ],
    templateVars: { env: 'staging' },
    ...overrides,
  } as RunbookState;
}

/** Helper: create minimal Step[] for testing. */
function makeSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly Step[] {
  return [
    {
      kind: 'substeps',
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
      kind: 'base',
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
      frameKey: buildFrameKey('1'),
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
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(result.token.length).toBe(37);
  });

  it('returns hash that matches token', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.tokenHash).toBe(hashDelegationToken(result.token));
  });

  it('delegation has correct fields', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

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
      createDelegation(
        { state, stepId: '99.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/step not found/i);
  });

  it('throws DELEGATION_SUBSTEP_REQUIRED when bare step ID given for step with substeps', () => {
    const state = makeState();
    const steps = makeSteps();

    expect(() =>
      createDelegation(
        { state, stepId: '1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/substep.*required/i);
  });

  it('throws DELEGATION_STEP_NOT_CURRENT when step is not at frontier', () => {
    const state = makeState({ step: '2' });
    const steps = [
      ...makeSteps('1'),
      { kind: 'base' as const, name: '2', description: 'Step 2' },
    ] as readonly Step[];

    expect(() =>
      createDelegation(
        { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/not at execution frontier/i);
  });

  it('throws DELEGATION_ALREADY_EXISTS for duplicate active delegation', () => {
    const existingDelegation = {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const state = makeState({
      substepStates: [
        {
          id: '1',
          frameKey: buildFrameKey('1'),
          status: 'pending',
          delegation: existingDelegation,
        },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    expect(() =>
      createDelegation(
        { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/active delegation exists/i);
  });

  it('allows re-delegation when previous delegation has childRunId set', () => {
    const claimedDelegation = {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'run_123',
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'pending', delegation: claimedDelegation },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.token).toBeDefined();
    const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(updated?.delegation?.childRunbookPath).toBe('child.md');
    expect(updated?.delegation?.childRunId).toBeNull();
  });

  it('allows re-delegation when previous delegation is cancelled', () => {
    const cancelledDelegation = {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: '2026-02-27T11:00:00.000Z',
    };
    const state = makeState({
      substepStates: [
        {
          id: '1',
          frameKey: buildFrameKey('1'),
          status: 'pending',
          delegation: cancelledDelegation,
        },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.token).toBeDefined();
    // The updated substep should have the new delegation
    const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(updated?.delegation?.cancelledAt).toBeNull();
    expect(updated?.delegation?.childRunbookPath).toBe('child.md');
  });

  it('captures state.templateVars in context snapshot', () => {
    const state = makeState({ templateVars: { env: 'prod', version: '2.0' } });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors,
        frameKey: buildFrameKey('1'),
      },
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
        frameKey: buildFrameKey('1'),
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
        { id: '1', frameKey: buildFrameKey('1'), status: 'running' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.2', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    // Substep 1 should be untouched
    const ss1 = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(ss1?.delegation).toBeUndefined();

    // Substep 2 should have delegation
    const ss2 = result.updatedSubstepStates.find((ss) => ss.id === '2');
    expect(ss2?.delegation).toBeDefined();
    expect(ss2?.delegation?.childRunbookPath).toBe('child.md');
  });

  it('captures step, substep, at, and index in context snapshot', () => {
    const state = makeState({
      step: '1',
      substep: '2',
      forStack: [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.2', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 3) },
      steps,
    );

    expect(result.delegation.contextSnapshot.step).toBe('1');
    expect(result.delegation.contextSnapshot.substep).toBe('2');
    expect(result.delegation.contextSnapshot.at).toBe('1.3.2');
    expect(result.delegation.contextSnapshot.index).toBe(3);
  });

  it('omits index from snapshot when not in a FOR loop', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.delegation.contextSnapshot.step).toBe('1');
    expect(result.delegation.contextSnapshot.index).toBeUndefined();
  });

  it('works for simple step without substeps', () => {
    const state = makeState({
      substepStates: undefined,
    });
    const steps = makeSimpleSteps();
    const result = createDelegation(
      { state, stepId: '1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.token).toBeDefined();
    // Should create a synthetic substep state entry
    expect(result.updatedSubstepStates).toHaveLength(1);
    expect(result.updatedSubstepStates[0].id).toBe('1');
    expect(result.updatedSubstepStates[0].delegation).toBeDefined();
  });

  it('throws for invalid step ID format (non-numeric)', () => {
    const state = makeState();
    const steps = makeSteps();

    expect(() =>
      createDelegation(
        { state, stepId: 'invalid', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/step not found/i);
  });

  it('throws for step ID with too many parts (e.g., 1.2.3)', () => {
    const state = makeState();
    const steps = makeSteps();

    // parseStepIdFromString should reject this format
    expect(() =>
      createDelegation(
        { state, stepId: '1.2.3', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/step not found/i);
  });

  it('captures empty templateVars when state has none', () => {
    const state = makeState({ templateVars: undefined });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.delegation.contextSnapshot.vars).toEqual({});
  });

  it('allows re-delegation after child run completes (childRunId set)', () => {
    const completedDelegation = {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'old-child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'completed-run-123',
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', delegation: completedDelegation },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'new-child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.token).toBeDefined();
    const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(updated?.delegation?.childRunbookPath).toBe('new-child.md');
    expect(updated?.delegation?.childRunId).toBeNull();
    expect(updated?.delegation?.tokenHash).not.toBe(completedDelegation.tokenHash);
  });

  it('includes extraVars with higher precedence than templateVars', () => {
    const state = makeState({ templateVars: { env: 'staging', region: 'us-west' } });
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { env: 'production', tier: 'premium' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    // extraVars should override templateVars
    expect(result.delegation.contextSnapshot.vars.env).toBe('production');
    expect(result.delegation.contextSnapshot.vars.region).toBe('us-west');
    expect(result.delegation.contextSnapshot.vars.tier).toBe('premium');
  });

  it('preserves all existing substep properties when adding delegation', () => {
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'running' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.2', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    const ss1 = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(ss1?.status).toBe('running');
    expect(ss1?.delegation).toBeUndefined();

    const ss2 = result.updatedSubstepStates.find((ss) => ss.id === '2');
    expect(ss2?.delegation).toBeDefined();
  });

  it('tokens are unique across multiple delegations', () => {
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    const result1 = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child1.md', frameKey: buildFrameKey('1') },
      steps,
    );

    // Create delegation on different substep
    const result2 = createDelegation(
      { state, stepId: '1.2', childRunbookPath: 'child2.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result1.token).not.toBe(result2.token);
    expect(result1.tokenHash).not.toBe(result2.tokenHash);
  });

  it('handles state with forStack for iteration context', () => {
    const state = makeState({
      step: '1',
      substep: '1',
      forStack: [
        {
          stepId: '1',
          iteration: 5,
          start: 1,
          end: 10,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.delegation.contextSnapshot.index).toBe(5);
    expect(result.delegation.contextSnapshot.at).toBe('1.5.1');
  });

  it('omits index from snapshot when forStack is empty', () => {
    const state = makeState({ forStack: [] });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.delegation.contextSnapshot.index).toBeUndefined();
  });

  it('handles null substep in state', () => {
    const state = makeState({ substep: undefined });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    expect(result.delegation.contextSnapshot.substep).toBeUndefined();
  });

  it('handles ancestors with empty vars', () => {
    const ancestor: AncestorSnapshot = {
      runId: 'anc-1',
      runbook: 'ancestor.md',
      step: '2',
      substep: null,
      vars: {},
    };
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [ancestor],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.delegation.contextSnapshot.ancestors).toHaveLength(1);
    expect(result.delegation.contextSnapshot.ancestors[0].vars).toEqual({});
  });

  it('createdAt timestamp is recent and valid ISO format', () => {
    const state = makeState();
    const steps = makeSteps();
    const before = new Date();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );
    const after = new Date();

    const createdAt = new Date(result.delegation.createdAt);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(result.delegation.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('sets frameKey on created substep states when frameKey is provided', () => {
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 2), status: 'pending' },
        { id: '2', frameKey: buildFrameKey('1', 2), status: 'pending' },
      ],
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 2) },
      steps,
    );

    const ss = result.updatedSubstepStates.find(
      (s) => s.id === '1' && s.frameKey === buildFrameKey('1', 2),
    );
    expect(ss?.frameKey).toBe(buildFrameKey('1', 2));
    expect(ss?.delegation).toBeDefined();
  });

  it('allows delegation on iteration 2 when iteration 1 has active delegation', () => {
    const delegation1 = {
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: '2026-02-27T10:00:00.000Z',
      cancelledAt: null,
    };
    const state = makeState({
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 1), status: 'pending', delegation: delegation1 },
        { id: '2', frameKey: buildFrameKey('1', 1), status: 'pending' },
      ],
    });
    const steps = makeSteps();

    // Delegate on iteration 2 — should succeed even though iteration 1 has active delegation
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 2) },
      steps,
    );

    expect(result.token).toBeDefined();
    // Should append a new entry for iteration 2
    expect(result.updatedSubstepStates).toHaveLength(3);
    const iter2 = result.updatedSubstepStates.find(
      (ss) => ss.id === '1' && ss.frameKey === buildFrameKey('1', 2),
    );
    expect(iter2?.delegation?.childRunbookPath).toBe('child.md');
    expect(iter2?.delegation?.childRunId).toBeNull();
  });

  it('appends new entry for synthetic step when frameKey is provided', () => {
    const state = makeState({ substepStates: undefined });
    const steps = makeSimpleSteps();
    const result = createDelegation(
      { state, stepId: '1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 3) },
      steps,
    );

    expect(result.updatedSubstepStates).toHaveLength(1);
    expect(result.updatedSubstepStates[0].frameKey).toBe(buildFrameKey('1', 3));
  });
});
