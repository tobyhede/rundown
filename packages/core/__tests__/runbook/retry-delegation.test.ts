import { describe, it, expect } from '@jest/globals';
import {
  abortDelegation,
  createDelegation,
  retryDelegation,
} from '../../src/runbook/delegation-service.js';
import { TOKEN_PREFIX } from '../../src/runbook/delegation-token.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import {
  makeForSteps,
  makeMultiStepSteps,
  makeSimpleSteps,
  makeState,
  makeSteps,
} from './delegation-service-fixtures.js';

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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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
    const multiStepSteps = makeMultiStepSteps();
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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
    if (result.status !== 'not_current') return;
    expect(result.ownerStep).toBe('1');
    expect(result.currentStep).toBe('2');
    // Mirrors CreateDelegationStepNotCurrentResult — `error` is RD-802.
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('RD-802');
  });

  it('returns { status: "error" } when createDelegation surfaces a RundownError variant', () => {
    // Force createDelegation to surface an error variant by pointing state.step
    // at a step that exists but removing the substep from the steps array on
    // retry.
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    // Steps no longer contain substep "1" — createDelegation returns substep_not_found.
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
    // Inner createDelegation path: trimming substep '1' from the available
    // list at trimmedSteps causes the substep-validation block to fire
    // `Errors.delegationSubstepNotFound` (RD-806). Pinning the code makes
    // a future change to the inner failure path produce a hard test
    // failure rather than silently passing under the regex.
    expect(result.error.code).toBe('RD-806');
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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
    // Belt-and-braces: `index` and `substep` are duplicate consistency
    // checks of the canonical `at` snapshot — pinning all three guards
    // against silent drift between the canonical form and the legacy
    // structured fields.
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

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
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

  it('retries a bare-step delegation under a FOR loop with implicit iteration recovery', () => {
    // ownerHasSubsteps=false branch in retryDelegation's stepIdForCreate
    // reconstruction: when the bare step lives inside a FOR-iterating frame,
    // stepIdForCreate falls back to the 1-level `state.step` and the FOR
    // iteration is recovered implicitly via forStack inside
    // `buildContextSnapshot` (see `delegation-context.ts` getActiveForContext).
    // This pins the implicit-recovery path so a regression that drops it
    // (e.g. by switching to an explicit-only `${step}.${iteration}` form)
    // produces a hard failure rather than a silent FOR-iteration drop.
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
      // Bare step: substepStates is empty/undefined; the delegation will be
      // recorded under id === step.name === '1' per createDelegation step 5.
      substepStates: undefined,
    });
    const steps = makeSimpleSteps();

    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1', 2),
      },
      steps,
    );

    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
    // Initial delegation records the FOR iteration index in the snapshot.
    expect(initial.delegation.contextSnapshot.index).toBe(2);

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
    // Implicit iteration recovery preserves the FOR iteration on the re-issued
    // delegation — same iteration as the parent frame.
    expect(result.delegation.contextSnapshot.index).toBe(2);
    expect(result.tokenHash).not.toBe(initial.tokenHash);
    const replaced = result.updatedSubstepStates.find(
      (ss) => ss.id === '1' && ss.frameKey === buildFrameKey('1', 2),
    );
    expect(replaced?.delegation?.tokenHash).toBe(result.tokenHash);
    expect(replaced?.delegation?.cancelledAt).toBeNull();
  });

  it('returns { status: "error" } with RD-818 when retried owner step has lost its substeps', () => {
    // Schema-drift scenario: a persisted delegation originally targeted
    // substep `1.1`. The runbook is later edited so step `1` no longer
    // declares any substeps. Without the RD-818 guard, retryDelegation
    // would silently fall back to a bare-step `stepIdForCreate` and
    // overwrite the wrong persisted entry. Surface as a typed error so
    // the operator can detect the drift and restart cleanly.
    const baseState = makeState();
    const seedSteps = makeSteps('1', ['1', '2']);
    const initial = createDelegation(
      {
        state: baseState,
        stepId: '1.1',
        childRunbookPath: 'child.md',
        ancestors: [],
        frameKey: buildFrameKey('1'),
      },
      seedSteps,
    );
    expect(initial.status).toBe('created');
    if (initial.status !== 'created') return;
    const stateWithDelegation = { ...baseState, substepStates: initial.updatedSubstepStates };

    // Edit: step '1' loses its substeps (now a bare step).
    const editedSteps = makeSimpleSteps();

    const result = retryDelegation(
      {
        state: stateWithDelegation,
        substepId: '1',
        frameKey: buildFrameKey('1'),
      },
      editedSteps,
    );

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('RD-818');
  });
});
