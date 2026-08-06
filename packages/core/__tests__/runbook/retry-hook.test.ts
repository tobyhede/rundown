import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RetryHookResult, RetryHookSuccess, RetryHookError } from '../../src/runbook/index.js';
import type {
  ResolvedStepHavingSubsteps,
  ResolvedStep,
  StepDelegation,
  SubstepState,
} from '../../src/runbook/types.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandEffectiveVarsForTest, brandRunIdForTest } from '../../src/testing/effective-vars.js';
import {
  makeDelegationCredentialDescriptor,
  makeDelegationCredentialIssuer,
} from '../../src/testing/delegation-fixtures.js';
import { Errors } from '../../src/errors/factory.js';

// Mock delegation-service so we can drive `retryDelegation` to specific
// Result variants — `retried`, `not_current`, `not_found`, `error` — and
// verify `runRetryHook`'s routing decisions for each.
jest.unstable_mockModule('../../src/runbook/delegation-service.js', () => ({
  retryDelegation: jest.fn(),
  // Re-export any other bindings the module graph under test imports.
  // retry-hook.ts only imports retryDelegation + its Result type — the type
  // is erased at runtime, so the function mock is sufficient.
}));

const { retryDelegation } = await import('../../src/runbook/delegation-service.js');
const { runRetryHook } = await import('../../src/runbook/retry-hook.js');
const { asTemplateVars } = await import('../../src/runbook/template-vars.js');

const mockedRetryDelegation = retryDelegation as jest.MockedFunction<typeof retryDelegation>;
const HASH_TEST = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
const HASH_NEW = assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`);
const HASH_STALE = assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`);
const HASH_ORPHAN = assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`);
const HASH_NO_AT = assertDelegationTokenHash(`sha256:${'e'.repeat(64)}`);
const issueCredential = makeDelegationCredentialIssuer();
/** Run id of the run the hook is executing inside. */
const CURRENT_RUN_ID = brandRunIdForTest(`rd_${'1'.repeat(32)}`);
/** Run id baked into the persisted descriptor by `makeDelegationCredentialDescriptor`. */
const DESCRIPTOR_RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);

describe('asTemplateVars', () => {
  it('passes through strings, numbers, arrays, and objects unchanged', () => {
    const input = {
      s: 'hello',
      n: 42,
      arr: ['a', 'b'],
      obj: { host: 'x' },
    };
    const result = asTemplateVars(input);
    expect(result).toEqual(input);
  });

  it('filters out boolean values with a warning path', () => {
    const input = { kept: 'yes', dropped: true };
    const result = asTemplateVars(input);
    expect(result).toEqual({ kept: 'yes' });
    expect(Object.hasOwn(result, 'dropped')).toBe(false);
  });

  it('filters out null values', () => {
    const input = { kept: 'yes', nulled: null };
    const result = asTemplateVars(input);
    expect(result).toEqual({ kept: 'yes' });
    expect(Object.hasOwn(result, 'nulled')).toBe(false);
  });

  it('returns an empty object for an empty input', () => {
    expect(asTemplateVars({})).toEqual({});
  });
});

describe('RetryHookResult exports', () => {
  it('is a discriminated union addressable from the runbook index', () => {
    // Type-level check — the test body exercises the compile-time import path.
    const ok: RetryHookSuccess = {
      status: 'success',
      frontier: [],
      substepStates: [],
    };
    const err: RetryHookError = {
      status: 'error',
      code: 'RD-TEST',
      message: 'unit',
      substepStates: [],
    };
    const union: RetryHookResult[] = [ok, err];
    expect(union).toHaveLength(2);
    expect(union[0].status).toBe('success');
    expect(union[1].status).toBe('error');
  });
});

describe('runRetryHook routing on retryDelegation Result variants', () => {
  beforeEach(() => {
    mockedRetryDelegation.mockReset();
  });

  /**
   * Build the minimal inputs needed to drive `runRetryHook` into the
   * per-substep loop that calls `retryDelegation`. The substep state carries
   * a delegation record under the active frame key so the hook does not
   * short-circuit on the "no delegation" branch.
   */
  function buildInputs(): {
    context: RunbookContext;
    parentStep: ResolvedStepHavingSubsteps;
    steps: readonly ResolvedStep[];
    originalSubstepStates: readonly SubstepState[];
  } {
    const frameKey = buildFrameKey('1');
    const substepTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
    };
    const parentTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
    };

    const parentStep: ResolvedStepHavingSubsteps = {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: parentTransitions,
      aggregation: { strategy: 'ALL' as const },
      substeps: [
        {
          kind: 'base',
          id: '1',
          description: 'Sub 1',
          transitions: substepTransitions,
        },
      ],
    } as unknown as ResolvedStepHavingSubsteps;

    const steps: ResolvedStep[] = [parentStep];

    const fixtureDelegation: StepDelegation = {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: HASH_TEST,
      childRunbookPath: 'child-1.md',
      childRunbookRef: { source: 'project', path: 'child-1.md' },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({}),
        ancestors: [],
        step: '1',
        substep: '1',
        at: '1.1',
      },
    };
    const originalSubstepStates: readonly SubstepState[] = [
      {
        id: '1',
        frameKey,
        status: 'done',
        result: 'fail',
        delegation: fixtureDelegation,
      },
    ];

    const context: RunbookContext = {
      retryCount: 0,
      selfGotoCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      variables: {},
      forStack: [],
      substepCompletedCount: 0,
      templateVars: { RunId: CURRENT_RUN_ID },
      frontmatterOutputs: [],
      finalVars: {},
      lifecycle: 'running' as const,
      substepStates: originalSubstepStates,
    };

    return { context, parentStep, steps, originalSubstepStates };
  }

  /** Drive `retryDelegation` to its `retried` variant with a canonical `at`. */
  function mockRetried(originalSubstepStates: readonly SubstepState[]): void {
    mockedRetryDelegation.mockReturnValue({
      status: 'retried',
      token: 'rdtk_new_token',
      tokenHash: HASH_NEW,
      delegation: {
        credential: makeDelegationCredentialDescriptor(),
        tokenHash: HASH_NEW,
        childRunbookPath: 'child-1.md',
        childRunbookRef: { source: 'project', path: 'child-1.md' },
        childRunId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        cancelledAt: null,
        contextSnapshot: {
          vars: brandEffectiveVarsForTest({}),
          ancestors: [],
          step: '1',
          substep: '1',
          at: '1.1',
        },
      },
      updatedSubstepStates: [...originalSubstepStates],
    });
  }

  it('refuses an active delegation retry when verified claim authority is absent', () => {
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();

    const result = runRetryHook(context, parentStep, steps);

    expect(result).toEqual({
      status: 'error',
      code: 'ACTOR_CONTEXT_REQUIRED',
      message: 'Delegation retry requires verified claim authority',
      substepStates: originalSubstepStates,
    });
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('forwards the verified credential issuer to delegation retry', () => {
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const issuer = makeDelegationCredentialIssuer();
    const delegation = originalSubstepStates[0]?.delegation;
    if (delegation === undefined) throw new Error('Expected delegated retry fixture');
    mockedRetryDelegation.mockReturnValue({
      status: 'retried',
      token: 'rdtk_new_token',
      tokenHash: HASH_NEW,
      delegation,
      updatedSubstepStates: [...originalSubstepStates],
    });

    const result = runRetryHook(context, parentStep, steps, issuer);

    expect(result.status).toBe('success');
    expect(mockedRetryDelegation).toHaveBeenCalledTimes(1);
    expect(mockedRetryDelegation.mock.calls[0]?.[0].issueCredential).toBe(issuer);
  });

  it('uses the canonical contextSnapshot.at when pushing a FOR-iteration frontier entry', () => {
    // Regression: the pre-fix code built the frontier id from
    // `${parentStep.name}.${substep.id}` — e.g. "1.1" — which erased the
    // FOR-iteration segment that `deriveExecutionAt` bakes into
    // `contextSnapshot.at`. For a retry on iteration 2 the correct frontier
    // id is "1.2.1", not "1.1".
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const delegation: StepDelegation = {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: HASH_NEW,
      childRunbookPath: 'child-1.md',
      childRunbookRef: { source: 'project', path: 'child-1.md' },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({}),
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
      tokenHash: HASH_NEW,
      delegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const result = runRetryHook(context, parentStep, steps, issueCredential);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.frontier).toHaveLength(1);
      expect(result.frontier[0].id).toBe('1.2.1');
      expect(result.frontier[0].id).not.toBe('1.1');
    }
  });

  it('rolls back with the inner RundownError code/message when retryDelegation returns not_current after delegation observed', () => {
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const inner = Errors.delegationStepNotCurrent('2', '1');
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_current' as const,
      ownerStep: '2',
      currentStep: '1',
      error: inner,
    }));

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(inner.code);
      expect(result.message).toBe(inner.message);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('rolls back with the inner RundownError code/message when retryDelegation returns not_found after delegation observed', () => {
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const inner = Errors.delegationStepNotFound('1');
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_found' as const,
      substepId: '1',
      error: inner,
    }));

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      // Hook surfaces the inner RundownError code/message verbatim.
      expect(result.code).toBe(inner.code);
      expect(result.message).toBe(inner.message);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('propagates retryDelegation error variant as RetryHookError with verbatim code/message', () => {
    // The two tests deleted in 63bf886e (RD-901 try/catch removal) incidentally
    // exercised this propagation arm: when retryDelegation returns
    // `{ status: 'error', error }`, runRetryHook must surface the inner
    // RundownError's code and message verbatim and roll back substepStates.
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const inner = Errors.delegationRunbookNotFound('child-1.md');
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'error' as const,
      error: inner,
    }));

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe(inner.code);
      expect(result.message).toBe(inner.message);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('returns RD-902 when all delegations are under stale frameKeys (no active-frame delegations)', () => {
    // Finding 6 regression: activeFrameKey is set, but every delegation record
    // in substepStates is under a stale frameKey (e.g. from a previous FOR
    // iteration or post-GOTO state). The per-substep loop filters by the
    // active frameKey via findSubstepState, so it produces an empty frontier
    // and the pre-fix code silently returned `{ status: 'success', frontier: [] }`.
    // That consumed the retry budget without re-issuing any delegation — the
    // same class of bug the original DELEGATE + RETRY path had. The fix routes
    // through RETRY_ERROR with RD-902.
    const activeFrameKey = buildFrameKey('1', 2);
    const staleFrameKey = buildFrameKey('1', 1);
    const substepTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
    };
    const parentTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
    };
    const parentStep: ResolvedStepHavingSubsteps = {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: parentTransitions,
      aggregation: { strategy: 'ALL' as const },
      substeps: [
        {
          kind: 'base',
          id: '1',
          description: 'Sub 1',
          transitions: substepTransitions,
        },
      ],
    } as unknown as ResolvedStepHavingSubsteps;
    const steps: ResolvedStep[] = [parentStep];

    const staleDelegation: StepDelegation = {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: HASH_STALE,
      childRunbookPath: 'child-1.md',
      childRunbookRef: { source: 'project', path: 'child-1.md' },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({}),
        ancestors: [],
        step: '1',
        substep: '1',
        at: '1.1.1',
        index: 1,
      },
    };
    const originalSubstepStates: readonly SubstepState[] = [
      {
        id: '1',
        frameKey: staleFrameKey,
        status: 'done',
        result: 'fail',
        delegation: staleDelegation,
      },
    ];
    const context: RunbookContext = {
      retryCount: 0,
      selfGotoCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      variables: {},
      forStack: [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 2,
          implicit: false,
          source: { kind: 'range' as const },
        },
      ],
      substepCompletedCount: 0,
      templateVars: { RunId: CURRENT_RUN_ID },
      frontmatterOutputs: [],
      finalVars: {},
      lifecycle: 'running' as const,
      substepStates: originalSubstepStates,
    };
    void activeFrameKey;

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-902');
      expect(result.message).toMatch(/stale frame keys/);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
    // retryDelegation must NOT be called — the stale-frame substep never
    // matches findSubstepState(..., activeFrameKey), so the loop skips it.
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('rolls back with RD-905 when an active-frame delegation targets an undeclared substep', () => {
    // Schema-drift scenario: persisted state holds an active-frame
    // delegation whose `id` (here: "99") is NOT declared on the current
    // parentStep.substeps. The per-substep loop walks parentStep.substeps
    // only, so the orphan would be silently missed and runRetryHook would
    // fall through to its post-loop success guard, consuming the retry
    // transition without re-issuing any token. The pre-loop guard surfaces
    // this as a typed error so the operator can detect the drift.
    const activeFrameKey = buildFrameKey('1');
    const substepTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'DEFER' as const } },
      fail: { kind: 'fail' as const, retry: 0, action: { type: 'DEFER' as const } },
    };
    const parentTransitions = {
      pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
      fail: { kind: 'fail' as const, retry: 1, action: { type: 'STOP' as const } },
    };
    const parentStep: ResolvedStepHavingSubsteps = {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      transitions: parentTransitions,
      aggregation: { strategy: 'ALL' as const },
      substeps: [
        {
          kind: 'base',
          id: '1',
          description: 'Sub 1',
          transitions: substepTransitions,
        },
      ],
    } as unknown as ResolvedStepHavingSubsteps;
    const steps: ResolvedStep[] = [parentStep];

    const orphanDelegation: StepDelegation = {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: HASH_ORPHAN,
      childRunbookPath: 'child-99.md',
      childRunbookRef: { source: 'project', path: 'child-99.md' },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({}),
        ancestors: [],
        step: '1',
        substep: '99',
        at: '1.99',
      },
    };
    const originalSubstepStates: readonly SubstepState[] = [
      {
        id: '99',
        frameKey: activeFrameKey,
        status: 'done',
        result: 'fail',
        delegation: orphanDelegation,
      },
    ];
    const context: RunbookContext = {
      retryCount: 0,
      selfGotoCount: 0,
      parentRetryCount: 0,
      iterationRetryCount: 0,
      variables: {},
      forStack: [],
      substepCompletedCount: 0,
      templateVars: { RunId: CURRENT_RUN_ID },
      frontmatterOutputs: [],
      finalVars: {},
      lifecycle: 'running' as const,
      substepStates: originalSubstepStates,
    };
    void activeFrameKey;

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-905');
      expect(result.substepStates).toBe(originalSubstepStates);
    }
    // retryDelegation must NOT be called — the guard fires before the loop.
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('rolls back with RD-904 when fresh delegation has no canonical contextSnapshot.at', () => {
    // Hard-fail rather than silently degrade: deriveExecutionAt always populates
    // `at` for fresh delegations through the current path. A missing value here
    // is an upstream invariant violation; emitting `${parentStep.name}.${substep.id}`
    // would mis-target the re-entry frontier (e.g. "1.1" for an iteration-2 retry).
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const delegation: StepDelegation = {
      credential: makeDelegationCredentialDescriptor(),
      tokenHash: HASH_NO_AT,
      childRunbookPath: 'child-1.md',
      childRunbookRef: { source: 'project', path: 'child-1.md' },
      childRunId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      cancelledAt: null,
      contextSnapshot: {
        vars: brandEffectiveVarsForTest({}),
        ancestors: [],
        step: '1',
        substep: '1',
        // at intentionally omitted
      },
    };
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'retried' as const,
      token: 'rdtk_new_token',
      tokenHash: HASH_NO_AT,
      delegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-904');
      expect(result.message).toMatch(/no contextSnapshot\.at/);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('refuses an active delegation retry (RD-903) when the run id is absent', () => {
    const base = buildInputs();
    const context = { ...base.context, templateVars: {} };

    const result = runRetryHook(context, base.parentStep, base.steps, issueCredential);

    expect(result).toEqual({
      status: 'error',
      code: 'RD-903',
      message: expect.stringContaining('Retry hook has no current run id'),
      substepStates: base.originalSubstepStates,
    });
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('refuses an active delegation retry (RD-903) when the run id is malformed', () => {
    const base = buildInputs();
    const context = { ...base.context, templateVars: { RunId: 'not-a-run-id' } };

    const result = runRetryHook(context, base.parentStep, base.steps, issueCredential);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-903');
      expect(result.substepStates).toBe(base.originalSubstepStates);
    }
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('retries a frame with no delegation even without a run id (RETRY is universal)', () => {
    const base = buildInputs();
    const context = {
      ...base.context,
      templateVars: {},
      substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'done' as const }],
    };

    const result = runRetryHook(context, base.parentStep, base.steps);

    expect(result.status).toBe('success');
    expect(mockedRetryDelegation).not.toHaveBeenCalled();
  });

  it('re-issues against the current run id, not the persisted descriptor run id', () => {
    // `parentRunId` is HMAC derivation input. Reading it out of the delegation
    // record being replaced re-derives the replacement against whatever run the
    // stale descriptor names instead of the run actually executing the retry.
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    expect(originalSubstepStates[0]?.delegation?.credential.parentRunId).toBe(DESCRIPTOR_RUN_ID);
    mockRetried(originalSubstepStates);

    const result = runRetryHook(context, parentStep, steps, issueCredential);

    expect(result.status).toBe('success');
    expect(mockedRetryDelegation.mock.calls[0]?.[0].state.id).toBe(CURRENT_RUN_ID);
  });

  it('threads the mirrored frame entry into the replacement issuance', () => {
    const base = buildInputs();
    const frameKey = buildFrameKey('1');
    // Extra property on a non-fresh object: the context mirror this hook must
    // read is the same one the actor service writes at bootstrap.
    const context = {
      ...base.context,
      frameEntry: {
        activeFrameKey: frameKey,
        activeEntry: 4,
        frameEntryCounts: { [frameKey]: 4 },
      },
    };
    mockRetried(base.originalSubstepStates);

    const result = runRetryHook(context, base.parentStep, base.steps, issueCredential);

    expect(result.status).toBe('success');
    const passedState = mockedRetryDelegation.mock.calls[0]?.[0].state;
    expect(inferFrameEntryFromState(passedState, frameKey)).toBe(4);
  });

  it('attributes the entry to the retried frame, not to another active frame', () => {
    const base = buildInputs();
    const frameKey = buildFrameKey('1');
    const otherFrame = buildFrameKey('9');
    const context = {
      ...base.context,
      frameEntry: {
        activeFrameKey: otherFrame,
        activeEntry: 7,
        frameEntryCounts: { [otherFrame]: 7, [frameKey]: 3 },
      },
    };
    mockRetried(base.originalSubstepStates);

    const result = runRetryHook(context, base.parentStep, base.steps, issueCredential);

    expect(result.status).toBe('success');
    const passedState = mockedRetryDelegation.mock.calls[0]?.[0].state;
    expect(inferFrameEntryFromState(passedState, frameKey)).toBe(3);
  });
});
