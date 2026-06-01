import { describe, it, expect } from '@jest/globals';
import { createDelegation } from '../../src/runbook/delegation-service.js';
import type { DelegateOptions } from '../../src/runbook/delegation-service.js';
import {
  assertDelegationTokenHash,
  hashDelegationToken,
  TOKEN_PREFIX,
} from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { ResolvedStep, AncestorSnapshot, StepDelegation } from '../../src/runbook/types.js';
import {
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
} from '../../src/testing/effective-vars.js';
import {
  DEFAULT_TRANSITIONS,
  makeForSteps,
  makePromptedForSteps,
  makeSimpleSteps,
  makeState,
  makeSteps,
} from './delegation-service-fixtures.js';

const CLAIMED_RUN_ID = brandRunIdForTest(`rd_${'4'.repeat(32)}`);
const COMPLETED_RUN_ID = brandRunIdForTest(`rd_${'5'.repeat(32)}`);
const ANCESTOR_RUN_ID = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
const PARENT_RUN_ID = brandRunIdForTest(`rd_${'7'.repeat(32)}`);

describe('createDelegation', () => {
  it('succeeds on a step with substeps', () => {
    const state = makeState();
    const steps = makeSteps();
    const options: DelegateOptions = {
      state,
      stepId: '1.1',
      childRunbookPath: 'child.md',
      childRunbookRef: {
        source: 'plugin',
        path: 'planning/review/review-plan-risk-safety.runbook.md',
      },
      frameKey: buildFrameKey('1'),
    };

    const result = createDelegation(options, steps);

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.token).toBeDefined();
    expect(result.tokenHash).toBeDefined();
    expect(result.delegation).toBeDefined();
    expect(result.delegation.childRunbookRef).toEqual({
      source: 'plugin',
      path: 'planning/review/review-plan-risk-safety.runbook.md',
    });
    expect(result.updatedSubstepStates).toBeDefined();
  });

  it('returns a token with correct format', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
    // Body is 32 base32 chars: 20 random bytes × 8 bits / 5 bits-per-char
    // = 32 chars exactly (no padding). See delegation-token.ts encodeBase32.
    expect(result.token.length).toBe(TOKEN_PREFIX.length + 32);
  });

  it('returns hash that matches token', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.tokenHash).toBe(hashDelegationToken(result.token));
  });

  it('delegation has correct fields', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.delegation.childRunbookPath).toBe('child.md');
    expect(result.delegation.childRunId).toBeNull();
    expect(result.delegation.cancelledAt).toBeNull();
    expect(result.delegation.tokenHash).toBe(result.tokenHash);
    expect(result.delegation.createdAt).toBeDefined();
  });

  it('returns { status: "step_not_found" } for missing step', () => {
    const state = makeState();
    const steps = makeSteps();

    const result = createDelegation(
      {
        state,
        stepId: '99.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('step_not_found');
    if (result.status !== 'step_not_found') return;
    expect(result.step).toBe('99');
    expect(result.error.code).toBe('RD-801');
    expect(result.error.message).toMatch(/step not found/i);
  });

  it('returns { status: "substep_required" } when bare step ID given for step with substeps', () => {
    const state = makeState();
    const steps = makeSteps();

    const result = createDelegation(
      {
        state,
        stepId: '1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('substep_required');
    if (result.status !== 'substep_required') return;
    expect(result.step).toBe('1');
    expect(result.available).toEqual(['1', '2']);
    expect(result.error.code).toBe('RD-803');
    expect(result.error.message).toMatch(/substep id required/i);
  });

  it('returns { status: "step_not_current" } when step is not at frontier', () => {
    const state = makeState({ step: '2' });
    const steps: readonly ResolvedStep[] = [
      ...makeSteps('1'),
      {
        kind: 'base',
        name: '2',
        description: 'Step 2',
        transitions: DEFAULT_TRANSITIONS,
      },
    ];

    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('step_not_current');
    if (result.status !== 'step_not_current') return;
    expect(result.step).toBe('1');
    expect(result.current).toBe('2');
    expect(result.error.code).toBe('RD-802');
    expect(result.error.message).toMatch(/not at execution frontier/i);
  });

  it('returns { status: "delegation_exists" } for duplicate active delegation', () => {
    const existingDelegation: StepDelegation = {
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'other-child.md',
      childRunbookRef: { source: 'project', path: 'other-child.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
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

    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('delegation_exists');
    if (result.status !== 'delegation_exists') return;
    expect(result.step).toBe('1.1');
    expect(result.existingTokenHash).toBe(existingDelegation.tokenHash);
    expect(result.existingChildRunbookPath).toBe('other-child.md');
    expect(result.existingChildRunbookRef).toEqual({ source: 'project', path: 'other-child.md' });
    expect('token' in result).toBe(false);
    expect(result.error.code).toBe('RD-804');
    expect(result.error.message).toMatch(/active delegation exists/i);
  });

  it('allows re-delegation when previous delegation has childRunId set', () => {
    const claimedDelegation: StepDelegation = {
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'other-child.md',
      childRunbookRef: { source: 'project', path: 'other-child.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
      childRunId: CLAIMED_RUN_ID,
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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.token).toBeDefined();
    const updated = result.updatedSubstepStates.find((ss) => ss.id === '1');
    expect(updated?.delegation?.childRunbookPath).toBe('child.md');
    expect(updated?.delegation?.childRunId).toBeNull();
  });

  it('allows re-delegation when previous delegation is cancelled', () => {
    const cancelledDelegation: StepDelegation = {
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'other-child.md',
      childRunbookRef: { source: 'project', path: 'other-child.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.vars).toEqual({
      env: 'prod',
      version: '2.0',
    });
  });

  it('includes provided ancestors in snapshot', () => {
    const ancestors: readonly AncestorSnapshot[] = [
      {
        runId: ANCESTOR_RUN_ID,
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
        childRunbookRef: { source: 'project', path: 'child.md' },
        ancestors,
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.ancestors).toHaveLength(1);
    expect(result.delegation.contextSnapshot.ancestors[0].runId).toBe(ANCESTOR_RUN_ID);
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
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { version: '3.0', env: 'override' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.2',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.2',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 3),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.2',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // snapshot should reflect the delegation target (substep 2), not cursor (substep 1)
    expect(result.delegation.contextSnapshot.substep).toBe('2');
    expect(result.delegation.contextSnapshot.at).toBe('1.2');
  });

  it('omits index from snapshot when not in a FOR loop', () => {
    const state = makeState();
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.step).toBe('1');
    expect(result.delegation.contextSnapshot.index).toBeUndefined();
  });

  it('works for simple step without substeps', () => {
    const state = makeState({
      substepStates: undefined,
    });
    const steps = makeSimpleSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.token).toBeDefined();
    // Should create a synthetic substep state entry
    expect(result.updatedSubstepStates).toHaveLength(1);
    expect(result.updatedSubstepStates[0].id).toBe('1');
    expect(result.updatedSubstepStates[0].delegation).toBeDefined();
  });

  it('returns { status: "step_not_found" } for invalid step ID format (non-numeric)', () => {
    const state = makeState();
    const steps = makeSteps();

    const result = createDelegation(
      {
        state,
        stepId: 'invalid',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('step_not_found');
    if (result.status !== 'step_not_found') return;
    expect(result.step).toBe('invalid');
    expect(result.error.code).toBe('RD-801');
    expect(result.error.message).toMatch(/step not found/i);
  });

  it('returns { status: "step_not_found" } for three-level step ID on non-FOR step (kind: substeps)', () => {
    const state = makeState();
    const steps = makeSteps(); // kind: 'substeps'

    // Parses as step=1, at=2, substep=1. Substep '1' is valid, so 3b passes.
    // Branch 3c fires because kind !== 'for' and kind !== 'prompted-for'.
    const result = createDelegation(
      {
        state,
        stepId: '1.2.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('step_not_found');
    if (result.status !== 'step_not_found') return;
    expect(result.step).toBe('1.2.1');
    expect(result.error.code).toBe('RD-801');
    expect(result.error.message).toMatch(/step not found/i);
  });

  it('returns { status: "substep_not_found" } for three-level step ID when substep does not exist (e.g., 1.2.3)', () => {
    const state = makeState();
    const steps = makeSteps();

    // Parses as step=1, at=2, substep=3. Branch 3b fires because '3' is not in ['1','2'].
    const result = createDelegation(
      {
        state,
        stepId: '1.2.3',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('substep_not_found');
    if (result.status !== 'substep_not_found') return;
    expect(result.substep).toBe('3');
    expect(result.step).toBe('1');
    expect(result.available).toEqual(['1', '2']);
    expect(result.error.code).toBe('RD-806');
    expect(result.error.message).toMatch(/substep not found/i);
  });

  it('returns { status: "substep_not_found" } when substep specified but step has no substeps', () => {
    const state = makeState();
    const steps = makeSimpleSteps(); // kind: 'base', no substeps

    // Parses as step=1, substep=1. Branch 3b fires because step has no substeps at all.
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('substep_not_found');
    if (result.status !== 'substep_not_found') return;
    expect(result.substep).toBe('1');
    expect(result.step).toBe('1');
    expect(result.available).toEqual([]);
    expect(result.error.code).toBe('RD-806');
    expect(result.error.message).toMatch(/substep not found/i);
  });

  it('returns { status: "not_delegatable" } when target substep lacks DELEGATE', () => {
    const state = makeState();
    const steps: readonly ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Test step',
        transitions: DEFAULT_TRANSITIONS,
        substeps: [
          { id: '1', description: 'Substep 1', transitions: DEFAULT_TRANSITIONS },
          { id: '2', description: 'Substep 2', delegate: true, transitions: DEFAULT_TRANSITIONS },
        ],
      },
    ];

    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('not_delegatable');
    if (result.status !== 'not_delegatable') return;
    expect(result.step).toBe('1.1');
    expect(result.error.code).toBe('RD-813');
    expect(result.error.message).toMatch(/no delegatable substep/i);
  });

  it('allows three-level step ID on prompted-for step', () => {
    const state = makeState();
    const steps = makePromptedForSteps();

    // 1.2.1 → step=1, at=2, substep=1; prompted-for is allowed by 3c
    const delegation = createDelegation(
      {
        state,
        stepId: '1.2.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );
    expect(delegation.status).toBe('created');
    if (delegation.status !== 'created') return;
    expect(delegation).toBeDefined();
  });

  it('uses explicit iteration from three-level step ID in context snapshot', () => {
    const state = makeState({ forStack: undefined });
    const steps = makeForSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.2.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.3.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 3),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // parsed.at=3 should override forStack iteration=5
    expect(result.delegation.contextSnapshot.at).toBe('1.3.1');
    expect(result.delegation.contextSnapshot.index).toBe(3);
  });

  it('captures empty templateVars when state has none', () => {
    const state = makeState({ templateVars: undefined });
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.vars).toEqual({});
  });

  it('allows re-delegation after child run completes (childRunId set)', () => {
    const completedDelegation: StepDelegation = {
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'old-child.md',
      childRunbookRef: { source: 'project', path: 'old-child.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
      childRunId: COMPLETED_RUN_ID,
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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'new-child.md',
        childRunbookRef: { source: 'project', path: 'new-child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { env: 'production', tier: 'premium' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.2',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child1.md',
        childRunbookRef: { source: 'project', path: 'child1.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result1.status).toBe('created');
    if (result1.status !== 'created') return;

    // Create delegation on different substep
    const result2 = createDelegation(
      {
        state,
        stepId: '1.2',
        childRunbookPath: 'child2.md',
        childRunbookRef: { source: 'project', path: 'child2.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result2.status).toBe('created');
    if (result2.status !== 'created') return;

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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.index).toBe(5);
    expect(result.delegation.contextSnapshot.at).toBe('1.5.1');
  });

  it('omits index from snapshot when forStack is empty', () => {
    const state = makeState({ forStack: [] });
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.index).toBeUndefined();
  });

  it('snapshot substep reflects delegation target even when cursor has no substep', () => {
    const state = makeState({ substep: undefined });
    const steps = makeSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // snapshot should reflect the delegation target substep, not the cursor
    expect(result.delegation.contextSnapshot.substep).toBe('1');
  });

  it('handles ancestors with empty vars', () => {
    const ancestor: AncestorSnapshot = {
      runId: ANCESTOR_RUN_ID,
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
        childRunbookRef: { source: 'project', path: 'child.md' },
        ancestors: [ancestor],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.delegation.contextSnapshot.ancestors).toHaveLength(1);
    expect(result.delegation.contextSnapshot.ancestors[0].vars).toEqual({});
  });

  it('createdAt timestamp is recent and valid ISO format', () => {
    const state = makeState();
    const steps = makeSteps();
    const before = new Date();
    const result = createDelegation(
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const ss = result.updatedSubstepStates.find(
      (s) => s.id === '1' && s.frameKey === buildFrameKey('1', 2),
    );
    expect(ss?.frameKey).toBe(buildFrameKey('1', 2));
    expect(ss?.delegation).toBeDefined();
  });

  it('allows delegation on iteration 2 when iteration 1 has active delegation', () => {
    const delegation1: StepDelegation = {
      tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [] },
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
      {
        state,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    expect(result.token).toBeDefined();
    // Should append a new entry for iteration 2
    expect(result.updatedSubstepStates).toHaveLength(3);
    const iter2 = result.updatedSubstepStates.find(
      (ss) => ss.id === '1' && ss.frameKey === buildFrameKey('1', 2),
    );
    expect(iter2?.delegation?.childRunbookPath).toBe('child.md');
    expect(iter2?.delegation?.childRunId).toBeNull();
  });

  it('creates synthetic substep entry with provided frameKey', () => {
    const state = makeState({ substepStates: undefined });
    const steps = makeSimpleSteps();
    const result = createDelegation(
      {
        state,
        stepId: '1',
        childRunbookPath: 'child.md',
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1', 3),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { items: ['a', 'b', 'c'] },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

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
        childRunbookRef: { source: 'project', path: 'child.md' },
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
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
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: { environment: 'staging', port: 3000 },
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
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
        childRunbookRef: { source: 'project', path: 'child.md' },
        extraVars: undefined,
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      steps,
    );

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.delegation.extraVars).toBeUndefined();
  });

  describe('single-level delegation invariant', () => {
    it('returns { status: "parent_is_delegated" } when state has delegation linkage', () => {
      // Single-level delegation invariant: a claimed (delegated) child runbook
      // may not issue further delegations. Guard fires before any other
      // validation, so even an otherwise-valid (1.1, frontier-current) request
      // is rejected.
      const state = makeState({
        parentLinkage: {
          kind: 'delegation',
          parentRunId: PARENT_RUN_ID,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
        },
      });
      const steps = makeSteps();

      const result = createDelegation(
        {
          state,
          stepId: '1.1',
          childRunbookPath: 'child.md',
          childRunbookRef: { source: 'project', path: 'child.md' },
          frameKey: buildFrameKey('1'),
        },
        steps,
      );

      expect(result.status).toBe('parent_is_delegated');
      if (result.status !== 'parent_is_delegated') return;
      expect(result.parentRunId).toBe(PARENT_RUN_ID);
      expect(result.error.code).toBe('RD-819');
      expect(result.error.message).toMatch(/nested delegation forbidden/i);
    });

    it('does not block a runbook with no parentLinkage', () => {
      const state = makeState();
      const steps = makeSteps();

      const result = createDelegation(
        {
          state,
          stepId: '1.1',
          childRunbookPath: 'child.md',
          childRunbookRef: { source: 'project', path: 'child.md' },
          frameKey: buildFrameKey('1'),
        },
        steps,
      );

      expect(result.status).toBe('created');
    });

    it('does not block a runbook whose parentLinkage is inline (rd run --step)', () => {
      // The discriminant is `kind === 'delegation'`, not "has any parent
      // linkage". Inline children (`rd run --step`) execute in the same agent
      // process and may freely delegate; only delegation-linked children are
      // gated.
      const state = makeState({
        parentLinkage: {
          kind: 'inline',
          parentRunId: PARENT_RUN_ID,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });
      const steps = makeSteps();

      const result = createDelegation(
        {
          state,
          stepId: '1.1',
          childRunbookPath: 'child.md',
          childRunbookRef: { source: 'project', path: 'child.md' },
          frameKey: buildFrameKey('1'),
        },
        steps,
      );

      expect(result.status).toBe('created');
    });
  });
});
