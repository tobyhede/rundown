import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RetryHookResult, RetryHookSuccess, RetryHookError } from '../../src/runbook/index.js';
import type {
  ResolvedStepHavingSubsteps,
  ResolvedStep,
  StepDelegation,
  SubstepState,
} from '../../src/runbook/types.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';

// Mock delegation-service so we can force `retryDelegation` to throw a
// non-RundownError. The try/catch inside `runRetryHook` must convert that
// into a RETRY_ERROR routing variant with code RD-901.
jest.unstable_mockModule('../../src/runbook/delegation-service.js', () => ({
  retryDelegation: jest.fn(),
  // Re-export any other bindings the module graph under test imports.
  // retry-hook.ts only imports retryDelegation + its Result type — the type
  // is erased at runtime, so the function mock is sufficient.
}));

const { retryDelegation } = await import('../../src/runbook/delegation-service.js');
const { runRetryHook, asTemplateVars } = await import('../../src/runbook/retry-hook.js');

const mockedRetryDelegation = retryDelegation as jest.MockedFunction<typeof retryDelegation>;

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

describe('runRetryHook try/catch around retryDelegation', () => {
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

    const steps: ResolvedStep[] = [parentStep as unknown as ResolvedStep];

    const fixtureDelegation: StepDelegation = {
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
      parentRetryCount: 0,
      iterationRetryCount: 0,
      variables: {},
      forStack: [],
      substepCompletedCount: 0,
      templateVars: {},
      frontmatterOutputs: [],
      finalVars: {},
      lifecycle: 'running' as const,
      substepStates: originalSubstepStates,
      activeFrameKey: frameKey,
    } as unknown as RunbookContext;

    return { context, parentStep, steps, originalSubstepStates };
  }

  it('wraps a non-RundownError from retryDelegation as RD-901 RETRY_ERROR', () => {
    // When retryDelegation rethrows a programming-bug exception (e.g. TypeError
    // escaping from createDelegation), runRetryHook must convert it to the
    // RETRY_ERROR routing path. Without the try/catch the exception escapes the
    // XState assign callback and corrupts actor atomicity.
    const bug = new TypeError('simulated programming bug in createDelegation');
    mockedRetryDelegation.mockImplementation(() => {
      throw bug;
    });

    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const result = runRetryHook(context, parentStep, steps);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-901');
      expect(result.message).toBe('simulated programming bug in createDelegation');
      // Rollback discipline: original substepStates are returned, never a
      // partially-mutated variant.
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('wraps a thrown non-Error value from retryDelegation as RD-901 with stringified message', () => {
    // Defensive coverage: JS allows `throw 'string'` and similar. The hook
    // must stringify gracefully rather than crash on .message access. We
    // construct the non-Error throw via an indirect value so the lint rule
    // that forbids `throw <literal>` does not fire for a legitimate test
    // of the defensive path.
    const nonError: unknown = 'bare string throw';
    mockedRetryDelegation.mockImplementation(() => {
      throw nonError;
    });

    const { context, parentStep, steps } = buildInputs();
    const result = runRetryHook(context, parentStep, steps);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-901');
      expect(result.message).toBe('bare string throw');
    }
  });

  it('uses the canonical contextSnapshot.at when pushing a FOR-iteration frontier entry', () => {
    // Regression: the pre-fix code built the frontier id from
    // `${parentStep.name}.${substep.id}` — e.g. "1.1" — which erased the
    // FOR-iteration segment that `deriveExecutionAt` bakes into
    // `contextSnapshot.at`. For a retry on iteration 2 the correct frontier
    // id is "1.2.1", not "1.1".
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const delegation: StepDelegation = {
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
      delegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const result = runRetryHook(context, parentStep, steps);
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.frontier).toHaveLength(1);
      expect(result.frontier[0].id).toBe('1.2.1');
      expect(result.frontier[0].id).not.toBe('1.1');
    }
  });

  it('rolls back with RD-903 when retryDelegation returns not_current after delegation observed', () => {
    // The loop filters on `ss.delegation` being present and `activeFrameKey`
    // matching the context. Reaching `not_current` or `not_found` here means
    // the substep state and the delegation-service view have diverged — silent
    // skip would consume the retry transition without re-issuing a token.
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_current' as const,
      ownerStep: '2',
      currentStep: '1',
    }));

    const result = runRetryHook(context, parentStep, steps);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-903');
      expect(result.message).toMatch(/not_current.*substep "1"/);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('rolls back with RD-903 when retryDelegation returns not_found after delegation observed', () => {
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    mockedRetryDelegation.mockImplementation(() => ({
      status: 'not_found' as const,
    }));

    const result = runRetryHook(context, parentStep, steps);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-903');
      expect(result.message).toMatch(/not_found/);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });

  it('rolls back with RD-904 when fresh delegation has no canonical contextSnapshot.at', () => {
    // Hard-fail rather than silently degrade: deriveExecutionAt always populates
    // `at` for fresh delegations through the current path. A missing value here
    // is an upstream invariant violation; emitting `${parentStep.name}.${substep.id}`
    // would mis-target the re-entry frontier (e.g. "1.1" for an iteration-2 retry).
    const { context, parentStep, steps, originalSubstepStates } = buildInputs();
    const delegation: StepDelegation = {
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
      delegation,
      updatedSubstepStates: [...originalSubstepStates],
    }));

    const result = runRetryHook(context, parentStep, steps);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('RD-904');
      expect(result.message).toMatch(/no contextSnapshot\.at/);
      expect(result.substepStates).toBe(originalSubstepStates);
    }
  });
});
