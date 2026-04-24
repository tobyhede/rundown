import { describe, it, expect } from '@jest/globals';
import {
  abortDelegation,
  createDelegation,
  retryDelegation,
} from '../../src/runbook/delegation-service.js';
import type {
  AbortDelegationResult,
  CreateDelegationResult,
  DelegateOptions,
} from '../../src/runbook/delegation-service.js';
import { Errors } from '../../src/errors/factory.js';
import { hashDelegationToken, TOKEN_PREFIX } from '../../src/runbook/delegation-token.js';
import { brandEffectiveVars } from '../../src/runbook/effective-vars.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookState, ResolvedStep, AncestorSnapshot } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';
import {
  makeBaseStep,
  makeResolvedStepWithSubsteps,
  makeResolvedStepWithFor,
  makeResolvedStepWithPromptedFor,
  makeSubstep,
  makeStepDelegation,
} from '../helpers/step-factories.js';

describe('Result types', () => {
  describe('CreateDelegationResult type', () => {
    it('narrows to the created variant on status match', () => {
      const result: CreateDelegationResult = {
        status: 'created',
        token: 'dlg_test',
        tokenHash: 'sha256:x',
        delegation: {
          tokenHash: 'sha256:x',
          childRunbookPath: 'child.md',
          contextSnapshot: { vars: brandEffectiveVars({}), ancestors: [] },
          childRunId: null,
          createdAt: '2026-04-23T00:00:00.000Z',
          cancelledAt: null,
        },
        updatedSubstepStates: [],
      };
      if (result.status === 'created') {
        expect(result.token).toBe('dlg_test');
      }
    });
  });

  describe('AbortDelegationResult type', () => {
    it('narrows to the not_found variant', () => {
      const result: AbortDelegationResult = {
        status: 'not_found',
        substepId: '1.1',
        error: Errors.delegationStepNotFound('1.1'),
      };
      expect(result.status).toBe('not_found');
    });
  });
});

/** Helper: create minimal RunbookState for testing. */
function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id: 'run-1',
    runbook: 'parent.md',
    runbookPath: 'parent.md',
    step: '1',
    stepName: 'Main step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    substepStates: [
      { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
      { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
    ],
    templateVars: brandInitialTemplateVarsForTest({ env: 'staging' }),
    ...overrides,
  } as RunbookState;
}

/** Helper: create minimal ResolvedStep[] for testing. */
function makeSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly ResolvedStep[] {
  return [
    makeResolvedStepWithSubsteps({
      name: stepName,
      description: 'Test step',
      substeps: substepIds.map((id) => makeSubstep({ id, description: `Substep ${id}` })),
    }),
  ];
}

/** Helper: create steps without substeps. */
function makeSimpleSteps(stepName = '1'): readonly ResolvedStep[] {
  return [makeBaseStep({ name: stepName, description: 'Simple step' })];
}

/** Helper: create FOR steps with substeps (supports three-level step IDs). */
function makeForSteps(stepName = '1', substepIds: string[] = ['1', '2']): readonly ResolvedStep[] {
  return [
    makeResolvedStepWithFor({
      name: stepName,
      description: 'FOR step',
      forClause: { variable: 'i', start: 1, end: 10 },
      substeps: substepIds.map((id) => makeSubstep({ id, description: `Substep ${id}` })),
    }),
  ];
}

/** Helper: create prompted-for steps with substeps (supports three-level step IDs). */
function makePromptedForSteps(
  stepName = '1',
  substepIds: string[] = ['1', '2'],
): readonly ResolvedStep[] {
  return [
    makeResolvedStepWithPromptedFor({
      name: stepName,
      description: 'Prompted-FOR step',
      substeps: substepIds.map((id) => makeSubstep({ id, description: `Substep ${id}` })),
    }),
  ];
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
    const steps: readonly ResolvedStep[] = [
      ...makeSteps('1'),
      makeBaseStep({ name: '2', description: 'Step 2' }),
    ];

    expect(() =>
      createDelegation(
        { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/not at execution frontier/i);
  });

  it('throws DELEGATION_ALREADY_EXISTS for duplicate active delegation', () => {
    const existingDelegation = makeStepDelegation({
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
    });
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
    const claimedDelegation = makeStepDelegation({
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
      childRunId: 'run_123',
    });
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
    const cancelledDelegation = makeStepDelegation({
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'other-child.md',
      cancelledAt: '2026-02-27T11:00:00.000Z',
    });
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
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ env: 'prod', version: '2.0' }),
    });
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
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ env: 'staging' }),
    });
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

  it('snapshot uses delegation target substep, not cursor', () => {
    const state = makeState({
      step: '1',
      substep: '1', // cursor is on substep 1
    });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.2', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    // snapshot should reflect the delegation target (substep 2), not cursor (substep 1)
    expect(result.delegation.contextSnapshot.substep).toBe('2');
    expect(result.delegation.contextSnapshot.at).toBe('1.2');
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

  it('throws for three-level step ID on non-FOR step (kind: substeps)', () => {
    const state = makeState();
    const steps = makeSteps(); // kind: 'substeps'

    expect(() =>
      createDelegation(
        { state, stepId: '1.2.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 2) },
        steps,
      ),
    ).toThrow(/step not found/i);
  });

  it('throws for three-level step ID when substep does not exist (e.g., 1.2.3)', () => {
    const state = makeState();
    const steps = makeSteps();

    // Parses as step=1, at=2, substep=3 — throws because substep '3' is not in the step.
    // Note: 3c (non-FOR/prompted-for step) would also reject this, but 3b fires first.
    expect(() =>
      createDelegation(
        { state, stepId: '1.2.3', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
        steps,
      ),
    ).toThrow(/step not found/i);
  });

  it('allows three-level step ID on prompted-for step', () => {
    const state = makeState();
    const steps = makePromptedForSteps();

    // 1.2.1 → step=1, at=2, substep=1; prompted-for is allowed by 3c
    const delegation = createDelegation(
      { state, stepId: '1.2.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 2) },
      steps,
    );
    expect(delegation).toBeDefined();
  });

  it('uses explicit iteration from three-level step ID in context snapshot', () => {
    const state = makeState({ forStack: undefined });
    const steps = makeForSteps();
    const result = createDelegation(
      { state, stepId: '1.2.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 2) },
      steps,
    );

    expect(result.delegation.contextSnapshot.at).toBe('1.2.1');
    expect(result.delegation.contextSnapshot.index).toBe(2);
    expect(result.delegation.contextSnapshot.substep).toBe('1');
  });

  it('three-level step ID iteration overrides forStack iteration in context snapshot', () => {
    const state = makeState({
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
    const steps = makeForSteps();
    const result = createDelegation(
      { state, stepId: '1.3.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1', 3) },
      steps,
    );

    // parsed.at=3 should override forStack iteration=5
    expect(result.delegation.contextSnapshot.at).toBe('1.3.1');
    expect(result.delegation.contextSnapshot.index).toBe(3);
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
    const completedDelegation = makeStepDelegation({
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'old-child.md',
      childRunId: 'completed-run-123',
    });
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
    const state = makeState({
      templateVars: brandInitialTemplateVarsForTest({ env: 'staging', region: 'us-west' }),
    });
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

  it('snapshot substep reflects delegation target even when cursor has no substep', () => {
    const state = makeState({ substep: undefined });
    const steps = makeSteps();
    const result = createDelegation(
      { state, stepId: '1.1', childRunbookPath: 'child.md', frameKey: buildFrameKey('1') },
      steps,
    );

    // snapshot should reflect the delegation target substep, not the cursor
    expect(result.delegation.contextSnapshot.substep).toBe('1');
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
    const delegation1 = makeStepDelegation({
      tokenHash: `sha256:${'a'.repeat(64)}`,
      childRunbookPath: 'child.md',
    });
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

  it('extraVars appear in contextSnapshot.vars (unified model, no extraSources)', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { items: ['a', 'b', 'c'] },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.delegation.contextSnapshot.vars.items).toEqual(['a', 'b', 'c']);
  });

  it('snapshot without sources omits the field', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    expect(result.delegation.contextSnapshot).not.toHaveProperty('sources');
  });

  it('persists extraVars on the StepDelegation record', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { environment: 'staging', port: 3000 },
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    expect(result.delegation.extraVars).toEqual({ environment: 'staging', port: 3000 });
  });

  it('omits extraVars on the StepDelegation record when none provided', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: undefined,
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    expect(result.delegation.extraVars).toBeUndefined();
  });
});

describe('retryDelegation', () => {
  it('returns { status: "retried" } with a fresh token on success', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.tokenHash).not.toBe(initial.tokenHash);
    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);

    const replaced = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(replaced?.delegation?.tokenHash).toBe(result.tokenHash);
    expect(replaced?.delegation?.cancelledAt).toBeNull();
  });

  it('inherits extraVars from the prior delegation when no overrides given', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { environment: 'staging' },
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.updatedSubstepStates.find((ss) => ss.id === '1')?.delegation?.extraVars).toEqual({
      environment: 'staging',
    });
  });

  it('merges overrides over inherited extraVars', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        extraVars: { environment: 'staging', port: 3000 },
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
        overrides: { environment: 'production' },
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.updatedSubstepStates.find((ss) => ss.id === '1')?.delegation?.extraVars).toEqual({
      environment: 'production',
      port: 3000,
    });
  });

  it('returns { status: "retried" } when the existing delegation is claimed (force-style)', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const claimedSubsteps = initial.updatedSubstepStates.map((ss) =>
      ss.id === '1' && ss.delegation
        ? {
            ...ss,
            status: 'done' as const,
            result: 'fail' as const,
            delegation: { ...ss.delegation, childRunId: 'child-run-1' },
          }
        : ss,
    );
    const stateWithClaimed = { ...baseState, substepStates: claimedSubsteps };

    const result = retryDelegation(
      {
        state: stateWithClaimed,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('retried');
  });

  it('returns { status: "not_found" } when the substep has no delegation', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const result = retryDelegation(
      {
        state: baseState,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    expect(result.status).toBe('not_found');
  });

  it('returns { status: "not_current" } when the step is not at the execution frontier', () => {
    const baseState = makeState({ step: '2' });
    const multiStepSteps: readonly ResolvedStep[] = [
      ...makeSteps('1'),
      makeBaseStep({ name: '2', description: 'Other step' }),
    ];
    // Seed a delegation on step 1's substep, then attempt retry when state.step === '2'.
    const initial = createDelegation(
      {
        state: { ...baseState, step: '1' },
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      makeSteps('1'),
    );
    const driftedState = {
      ...baseState,
      step: '2',
      substepStates: initial.updatedSubstepStates,
    };

    const result = retryDelegation(
      {
        state: driftedState,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      multiStepSteps,
    );

    expect(result.status).toBe('not_current');
  });

  it('returns { status: "error" } when createDelegation throws (wraps the RundownError)', () => {
    // Force createDelegation to throw by pointing state.step at a step that exists
    // but removing the substep from the steps array on retry.
    const baseState = makeState();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      makeSteps('1', ['1', '2']),
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    // Steps no longer contain substep "1" — createDelegation will throw.
    const trimmedSteps = makeSteps('1', ['2']);

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      trimmedSteps,
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error).toBeDefined();
    // The wrapped RundownError surfaces the underlying code for callers.
    expect(result.error.code).toMatch(/^RD-\d+/);
  });

  it('successfully retries a bare-step delegation (step without substeps)', () => {
    const baseState = makeState({ substepStates: undefined });
    const steps = makeSimpleSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.tokenHash).not.toBe(initial.tokenHash);
    const replaced = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(replaced?.delegation?.tokenHash).toBe(result.tokenHash);
    expect(replaced?.delegation?.cancelledAt).toBeNull();
  });

  it('preserves the FOR iteration index on the re-issued delegation', () => {
    const baseState = makeState({
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
    });
    const steps = makeForSteps('1', ['1', '2']);
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.delegation.contextSnapshot.index).toBe(2);
    const replaced = result.updatedSubstepStates.find(
      (ss) => ss.id === '1' && ss.frameKey === buildFrameKey('1', 2),
    );
    expect(replaced?.delegation?.tokenHash).toBe(result.tokenHash);
  });

  it('successfully retries when the existing delegation was already cancelled', () => {
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    const aborted = abortDelegation({
      parentState: { ...baseState, substepStates: initial.updatedSubstepStates },
      substepId: '1',
      frameKey: buildFrameKey('1'),
    });
    if (aborted.status !== 'cancelled') throw new Error('precondition');
    const stateAfterAbort = { ...baseState, substepStates: aborted.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateAfterAbort,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    const newDelegation = result.updatedSubstepStates.find((ss) => ss.id === '1')?.delegation;
    expect(newDelegation?.cancelledAt).toBeNull();
    expect(newDelegation?.tokenHash).not.toBe(initial.tokenHash);
  });

  it('preserves the FOR iteration on the re-issued delegation snapshot', () => {
    // Regression: retryDelegation was building `stepIdForCreate` as
    // `${state.step}.${substepId}` regardless of frameKey, dropping the FOR
    // iteration segment. createDelegation then parsed it as 2-level and fell
    // back to `activeFor.iteration`, which can diverge from the frame's
    // iteration during per-iteration retry. The re-issued delegation's
    // contextSnapshot.at must match the frame (e.g. "1.2.1" at iteration 2),
    // not the concatenated "1.1".
    const baseState = makeState({
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
      substepStates: [
        { id: '1', frameKey: buildFrameKey('1', 2), status: 'pending' },
        { id: '2', frameKey: buildFrameKey('1', 2), status: 'pending' },
      ],
    });
    const steps = makeForSteps();

    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.2.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );
    expect(initial.delegation.contextSnapshot.at).toBe('1.2.1');

    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('retried');
    if (result.status !== 'retried') return;
    expect(result.delegation.contextSnapshot.at).toBe('1.2.1');
    expect(result.delegation.contextSnapshot.index).toBe(2);
    expect(result.delegation.contextSnapshot.substep).toBe('1');
  });

  it('returns { status: "error" } when the persisted snapshot omits the owner step', () => {
    // Regression: the previous `?? state.step` fallback masked stale-state
    // detection for delegations whose contextSnapshot predates the step
    // guarantee. Such delegations cannot be safely retried — the currency
    // check degrades to always-true — so retry must reject with a stale-state
    // error rather than silently proceeding.
    const baseState = makeState();
    const steps = makeSteps();
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );
    // Strip the step field from the persisted snapshot to simulate older state.
    const staleSubstepStates = initial.updatedSubstepStates.map((ss) =>
      ss.id === '1' && ss.delegation
        ? {
            ...ss,
            delegation: {
              ...ss.delegation,
              contextSnapshot: { ...ss.delegation.contextSnapshot, step: undefined },
            },
          }
        : ss,
    );
    const stateWithStale = { ...baseState, substepStates: staleSubstepStates };

    const result = retryDelegation(
      {
        state: stateWithStale,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('RD-817');
  });
});
