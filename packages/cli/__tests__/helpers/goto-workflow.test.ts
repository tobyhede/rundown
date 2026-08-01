import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ResolvedStep, Substep, ForClause, Transitions } from '@rundown-org/parser';
import type {
  ClaimId,
  RunbookLifecycleCommandService,
  RunbookState,
  RunbookStateManager,
  StepId,
} from '@rundown-org/core';
import { makeClaimRecord } from '@rundown-org/core/testing/claim-fixtures';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
} from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

const DEFAULT_RUNBOOK_ID = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
const PARENT_RUNBOOK_ID = brandRunIdForTest(`rd_${'7'.repeat(32)}`);
const CLAIMED_RUNBOOK_ID = brandRunIdForTest(`rd_${'8'.repeat(32)}`);
// Branded by cast rather than assertClaimId: core is mocked in this suite, so
// the real validator is unavailable and only the value's identity matters here.
const CLAIM_ID = 'rdclm_abcdefghijklmnopqrstu1' as unknown as ClaimId;

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  SessionService: jest.fn(),
  // Statically imported by delegation-completion.js (pulled in via executeGoto's
  // propagateDrivenRunTerminal call); the ESM link check needs the names, but the
  // executeGoto tests below make `manager.load` return null so propagation
  // short-circuits `skipped` without invoking any of these.
  ExecutionLifecycleService: jest.fn(),
  RunbookCompletionService: jest.fn(),
  projectDelegationTerminalOutcome: jest.fn(),
  parseStepIdFromString: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveGotoActionBlock: jest.fn(({ target }: { target: { step: string; substep?: string } }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  })),
  // Runtime-only validator with no service dependencies; pass-through preserves
  // structural mocking — every static import from @rundown-org/core resolves
  // through the factory rather than leaking the real module.
  assertClaimId: jest.fn((s: string) => s),
  claimKeyFromBearer: jest.fn((s: string) => `key:${s}`),
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
  // Statically imported by refusal-renderers.js, which goto-workflow.js pulls in
  // for renderNavigationRefusal. Only the terminal-claim renderers call it, and
  // navigation has no such arm — but the ESM link check needs the name present.
  redactClaimId: jest.fn((claimId: string) => claimId),
  ...mockErrorHelpers,
}));

// Mock the lifecycle seam factory: buildGotoContext dispatches into the core
// navigation seam through it (not exercised by these unit tests); mocking the
// factory keeps this suite off the seam's core-service import graph.
jest.unstable_mockModule('../../src/helpers/lifecycle-seam-factory', () => ({
  buildNonDelegatingLifecycleSeam: jest.fn(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  runExecutionLoop:
    mockFn<(...args: unknown[]) => Promise<'done' | 'stopped' | 'waiting'>>().mockResolvedValue(
      'done',
    ),
}));

// Mock runbook-loader
jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => readonly ResolvedStep[]>().mockReturnValue([]),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Delegation completion still imports this factory transitively; keep that
// collaborator structural even though GotoContext no longer carries it.
jest.unstable_mockModule('../../src/helpers/actor-service-factory', () => ({
  createCliRunbookActorService: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { runExecutionLoop } = await import('../../src/services/execution.js');
const {
  validateGotoTarget,
  executeGoto,
  resolveTerminalReleaseModeForRunbook,
  gotoResultRequiresFailureExit,
  renderNavigationRefusal,
  buildGotoContext,
} = await import('../../src/helpers/goto-workflow.js');
const { buildNonDelegatingLifecycleSeam } = await import(
  '../../src/helpers/lifecycle-seam-factory.js'
);

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

interface MakeStepOverrides {
  name?: string;
  description?: string;
  transitions?: Transitions;
  substeps?: readonly Substep[];
  forClause?: ForClause;
  command?: { code: string; lang?: string };
  kind?: ResolvedStep['kind'];
}

function makeStep(overrides: MakeStepOverrides = {}): ResolvedStep {
  const base = {
    name: overrides.name ?? '1',
    description: overrides.description ?? 'Test Step',
    transitions: overrides.transitions ?? DEFAULT_TRANSITIONS,
  };
  const explicitKind = overrides.kind;
  if (explicitKind === 'prompted-for' && overrides.substeps) {
    return {
      kind: 'prompted-for',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.forClause !== undefined) {
    return {
      kind: 'for',
      ...base,
      forClause: overrides.forClause,
      substeps: overrides.substeps ?? [],
    };
  }
  if (Array.isArray(overrides.substeps) && overrides.substeps.length > 0) {
    return {
      kind: 'substeps',
      ...base,
      substeps: overrides.substeps,
    };
  }
  if (overrides.command !== undefined) {
    return {
      kind: 'command',
      ...base,
      command: overrides.command,
    };
  }
  return {
    kind: 'base',
    ...base,
  };
}

function makeSubstep(id: string, description: string): Substep {
  return { id, description, transitions: DEFAULT_TRANSITIONS };
}

function makeNumericFor(start: number, end: number, variable = 'x'): ForClause {
  return { variable, start, end };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  jest
    .mocked(core.stepIdToString)
    .mockImplementation((id) => (id.substep ? `${id.step}.${id.substep}` : id.step));
  jest.mocked(core.deriveGotoActionBlock).mockImplementation(({ target }) => ({
    action: `GOTO ${target.substep ? `${target.step}.${target.substep}` : target.step}`,
    from: '1',
    at: target.step,
  }));
  jest.mocked(runExecutionLoop).mockResolvedValue('done');
});

describe('buildGotoContext claim-target coupling (#613)', () => {
  /**
   * Pin that goto derives caller evidence and the target selector from the SAME
   * `--claim-id`.
   *
   * `docs/reference/cli.md` and `docs/internal/architecture.md` both state that
   * `CLAIM_BEARER_MISMATCH` is unreachable from the CLI. That claim rests
   * entirely on this coupling: the seam refuses a divergence, so a frontend
   * sourcing the two fields independently would refuse every claim-targeted
   * goto at runtime AND silently falsify both docs. Nothing else fails if the
   * coupling breaks, so it is pinned here, where drift would originate.
   *
   * `readLifecycleCallerEvidence` is deliberately NOT mocked in this suite, so
   * this exercises the real derivation rather than a stand-in.
   */
  it('derives caller evidence and target selector from one --claim-id', async () => {
    const captured: unknown[] = [];
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      seam: {
        resolveRunNavigation: async (input: unknown) => {
          captured.push(input);
          // `none` short-circuits buildGotoContext before it assembles context,
          // which keeps this test about input construction only.
          return { kind: 'none' } as never;
        },
      } as never,
    } as never);
    const output = { noActiveRunbook: () => {} } as unknown as OutputEmitter;

    await buildGotoContext(output, '/cwd', { claimId: CLAIM_ID });

    expect(captured).toHaveLength(1);
    const input = captured[0] as {
      callerEvidence: { kind: string; claimId?: unknown };
      targetSelector: { kind: string; claimId?: unknown };
    };
    expect(input.callerEvidence).toEqual({ kind: 'claim_bearer', claimId: CLAIM_ID });
    expect(input.targetSelector).toEqual({ kind: 'claim', claimId: CLAIM_ID });
    // The invariant, stated as the seam's own gate states it: same id on both.
    expect(input.callerEvidence.claimId).toBe(input.targetSelector.claimId);
  });

  it('presents no bearer when no --claim-id is supplied, so the gate cannot fire', async () => {
    const captured: unknown[] = [];
    jest.mocked(buildNonDelegatingLifecycleSeam).mockReturnValue({
      manager: {} as never,
      seam: {
        resolveRunNavigation: async (input: unknown) => {
          captured.push(input);
          return { kind: 'none' } as never;
        },
      } as never,
    } as never);
    const output = { noActiveRunbook: () => {} } as unknown as OutputEmitter;

    await buildGotoContext(output, '/cwd', {});

    const input = captured[0] as {
      callerEvidence: { kind: string };
      targetSelector: { kind: string };
    };
    // Anti-vacuity for the case above: without `--claim-id` neither field is
    // claim-shaped, so the reconciliation is a no-op rather than a refusal.
    expect(input.callerEvidence).toEqual({ kind: 'direct_cli' });
    expect(input.targetSelector.kind).not.toBe('claim');
  });
});

describe('renderNavigationRefusal', () => {
  /** Recording OutputEmitter double capturing the rendered envelope. */
  function refusalEmitter(): {
    output: OutputEmitter;
    errors: readonly unknown[][];
    noActive: readonly unknown[][];
  } {
    const errors: unknown[][] = [];
    const noActive: unknown[][] = [];
    const output = {
      error: (...args: unknown[]) => errors.push(args),
      noActiveRunbook: (...args: unknown[]) => noActive.push(args),
    } as unknown as OutputEmitter;
    return { output, errors, noActive };
  }

  it('reports `none` as a no-op, not a failure', () => {
    const { output, errors, noActive } = refusalEmitter();

    // The empty-stack case is the one non-`ready` result that exits 0 — the
    // caller maps this polarity to process.exitCode.
    expect(renderNavigationRefusal(output, { kind: 'none' })).toBe(false);
    expect(noActive).toEqual([['goto']]);
    expect(errors).toEqual([]);
  });

  it('renders stale_claim under the code core assigned to the refusal', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'stale_claim',
      claimId: CLAIM_ID,
      message: 'superseded by the parent',
      code: 'DELEGATION_SUPERSEDED',
    });

    expect(exitError).toBe(true);
    // The code travels with the refusal — it is not hard-coded per arm.
    expect(errors).toEqual([['superseded by the parent', 'DELEGATION_SUPERSEDED']]);
  });

  it('renders terminal_claim as CLAIMED_RUNBOOK_UNAVAILABLE', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'terminal_claim',
      claimId: CLAIM_ID,
      lifecycle: 'completed',
      message: 'child already completed',
    });

    expect(exitError).toBe(true);
    expect(errors).toEqual([['child already completed', 'CLAIMED_RUNBOOK_UNAVAILABLE']]);
  });

  it('renders unknown_run as RUN_TARGET_UNAVAILABLE', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, {
      kind: 'unknown_run',
      runId: DEFAULT_RUNBOOK_ID,
      message: 'not a member of this session stack',
    });

    expect(exitError).toBe(true);
    expect(errors).toEqual([['not a member of this session stack', 'RUN_TARGET_UNAVAILABLE']]);
  });

  it('renders actor_context_required naming goto and echoing no run id', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, { kind: 'actor_context_required' });

    expect(exitError).toBe(true);
    expect(errors[0]?.[1]).toBe('ACTOR_CONTEXT_REQUIRED');
    expect(errors[0]?.[0]).toContain('rundown goto');
    expect(errors[0]?.[0]).toContain('--claim-id');
    // Accident barrier: no details object, and no run id anywhere.
    expect(errors[0]?.[2]).toBeUndefined();
    expect(JSON.stringify(errors[0])).not.toContain(DEFAULT_RUNBOOK_ID);
  });

  it('renders claim_bearer_mismatch under its own code, naming goto (#613)', () => {
    const { output, errors } = refusalEmitter();

    const exitError = renderNavigationRefusal(output, { kind: 'claim_bearer_mismatch' });

    expect(exitError).toBe(true);
    expect(errors[0]?.[1]).toBe('CLAIM_BEARER_MISMATCH');
    expect(errors[0]?.[1]).not.toBe('ACTOR_CONTEXT_REQUIRED');
    // Names this command, so the message cannot be command-agnostic boilerplate.
    expect(errors[0]?.[0]).toContain('rundown goto');
    // The caller DID present a claim id, so the bare-form advice would misdiagnose.
    expect(errors[0]?.[0]).not.toContain('Pass `--claim-id');
    expect(errors[0]?.[2]).toBeUndefined();
  });

  it('fails closed on an unrecognized kind rather than exiting zero', () => {
    const { output, errors, noActive } = refusalEmitter();

    // Unreachable through the typed API — the union is exhausted above. Reachable
    // from an untyped frontend, or from a core version that adds a refusal this
    // build does not know. The exhaustiveness guard's runtime consequence is what
    // matters: the caller must still exit non-zero. A guard that fell through
    // would return undefined and silently succeed, turning an unknown refusal
    // into a successful goto.
    const exitError = renderNavigationRefusal(output, {
      kind: 'unrecognized_future_refusal',
    } as unknown as Parameters<typeof renderNavigationRefusal>[1]);

    // `toBe(true)`, not `toBeTruthy()`: the signature promises a boolean, so the
    // unreachable arm must honour it too. A truthiness assertion would also pass
    // for an arm that returned the refusal object, leaving a `=== true` call
    // site free to break on it.
    expect(exitError).toBe(true);
    // Nothing is rendered for a kind we cannot describe — no guessed envelope.
    expect(errors).toEqual([]);
    expect(noActive).toEqual([]);
  });

  it('distinguishes the two claim-authority refusals from each other', () => {
    const bare = refusalEmitter();
    const mismatch = refusalEmitter();

    renderNavigationRefusal(bare.output, { kind: 'actor_context_required' });
    renderNavigationRefusal(mismatch.output, { kind: 'claim_bearer_mismatch' });

    // Same command, same exit polarity, different diagnosis — the whole point
    // of splitting the code rather than reusing ACTOR_CONTEXT_REQUIRED (#613).
    expect(bare.errors[0]?.[1]).not.toBe(mismatch.errors[0]?.[1]);
    expect(bare.errors[0]?.[0]).not.toBe(mismatch.errors[0]?.[0]);
  });
});

describe('validateGotoTarget', () => {
  it('rejects invalid format', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue(null);

    const result = validateGotoTarget('abc', [makeStep()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_SYNTAX');
      expect(result.details).toEqual({ provided: 'abc' });
    }
  });

  it('rejects missing step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '99' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('99', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('rejects AT on non-FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1' })]; // No forClause
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts AT on FOR step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
  });

  it('rejects substep on step without substeps', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [makeStep({ name: '1' })]; // No substeps
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
    }
  });

  it('rejects nonexistent substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '3' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.3', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('STEP_NOT_FOUND');
      expect(result.details?.available).toEqual(['1', '2']);
    }
  });

  it('accepts substep target on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '1' });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '1' });
    }
  });

  it('rejects AT on prompted-for step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

    const steps = [
      makeStep({
        name: '1',
        kind: 'prompted-for',
        substeps: [makeSubstep('1', 'Sub 1')],
      }),
    ];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_AT_TARGET');
    }
  });

  it('accepts valid step', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '2' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '2' });
    }
  });

  it('accepts self-referencing GOTO as valid target', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

    const steps = [makeStep({ name: '1' }), makeStep({ name: '2' })];
    const result = validateGotoTarget('1', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1' });
    }
  });

  it('accepts valid substep', () => {
    jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', substep: '2' });

    const steps = [
      makeStep({
        name: '1',
        substeps: [makeSubstep('1', 'Sub 1'), makeSubstep('2', 'Sub 2')],
      }),
    ];
    const result = validateGotoTarget('1.2', steps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ step: '1', substep: '2' });
    }
  });

  describe('--index option', () => {
    it('sets target.at from --index on FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects --index on non-FOR step', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1' })]; // No forClause
      const result = validateGotoTarget('1', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_AT_TARGET');
      }
    });

    it('rejects conflicting --index and AT', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 5 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 10) })];
      const result = validateGotoTarget('1 AT 5', steps, '3');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('CONFLICTING_INDEX');
      }
    });

    it('accepts matching --index and AT (idempotent)', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1', at: 3 });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1 AT 3', steps, '3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.target.at).toBe(3);
      }
    });

    it('rejects invalid --index value', () => {
      jest.mocked(core.parseStepIdFromString).mockReturnValue({ step: '1' });

      const steps = [makeStep({ name: '1', forClause: makeNumericFor(1, 5) })];
      const result = validateGotoTarget('1', steps, 'abc');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_SYNTAX');
      }
    });
  });
});

describe('executeGoto', () => {
  // Build a state for the goto context. Includes the minimum required RunbookState
  // fields; tests exercise only the specific fields each path consults.
  function makeState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: DEFAULT_RUNBOOK_ID,
      runbook: { source: 'project', path: 'test.md' },
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Step 1',
      retryCount: 0,
      variables: {} as RunbookState['variables'],
      steps: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      prompted: false,
      ...overrides,
    };
  }

  // Every refusal the fenced navigation mutation can return, each mapped to its
  // own symbolic code. The codes are the branch an agent acts on — re-claim,
  // re-read, wait, recover, or give up — so the table asserts the message is
  // forwarded verbatim alongside the code, not merely that the goto failed.
  it.each([
    {
      label: 'a vanished run target',
      kind: 'missing' as const,
      message: 'run disappeared',
      code: 'RUN_TARGET_UNAVAILABLE',
    },
    {
      label: 'a superseded claim',
      kind: 'claim_superseded' as const,
      message: 'A newer claim controls this run.',
      code: 'STALE_CLAIM',
    },
    {
      label: 'a concurrent state change',
      kind: 'concurrent_modification' as const,
      message: 'The run changed while this goto was deciding.',
      code: 'CONCURRENT_MODIFICATION',
    },
    {
      label: 'an in-flight execution',
      kind: 'execution_in_progress' as const,
      message: 'Another actor owns this run.',
      code: 'EXECUTION_IN_PROGRESS',
    },
    {
      label: 'an interrupted execution',
      kind: 'recovery_required' as const,
      message: 'The execution outcome is unknown and requires recovery.',
      code: 'RECOVERY_REQUIRED',
    },
  ])('returns $code when the fenced core mutation refuses with $label', async (refusal) => {
    const update = mockFn<RunbookStateManager['update']>();
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue({
      kind: refusal.kind,
      runId: DEFAULT_RUNBOOK_ID,
      epoch: 4,
      message: refusal.message,
    } as unknown as Awaited<ReturnType<RunbookLifecycleCommandService['runNavigationMutation']>>);

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep()],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(refusal.code);
      expect(result.error).toBe(refusal.message);
    }
    // A refused navigation must not write: the fence owns the commit, so a CLI
    // fallback write would be the shadow persistence path the fence replaced.
    expect(update).not.toHaveBeenCalled();
  });

  it('returns ok with loop result on success', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue({
      kind: 'applied',
      runId: DEFAULT_RUNBOOK_ID,
      previousState: makeState(),
      updatedState: makeState({ step: '2' }),
      snapshot: {},
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      terminalReleaseMode: 'stack-pop',
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const action = jest.fn();
    const ctx = {
      output: {
        action,
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const target: StepId = { step: '2' };
    const result = await executeGoto(ctx, target);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
      // manager.load resolves null, so propagateDrivenRunTerminal short-circuits
      // `skipped` without touching the (unmocked) delegation services.
      expect(result.propagation).toEqual({ kind: 'skipped' });
    }
    expect(action).toHaveBeenCalled();
    expect(runNavigationMutation).toHaveBeenCalledTimes(1);
    // The seam decides authority, target, and release policy from this input
    // alone — the CLI performs no navigation write of its own — so an input that
    // silently lost a field would hand the fence a different mutation.
    expect(runNavigationMutation).toHaveBeenCalledWith({
      runId: DEFAULT_RUNBOOK_ID,
      callerEvidence: { kind: 'direct_cli' },
      steps: ctx.steps,
      target,
      terminalReleaseMode: 'stack-pop',
    });
    expect(update).not.toHaveBeenCalledWith(
      DEFAULT_RUNBOOK_ID,
      expect.objectContaining({ lastAction: expect.anything() }),
    );
  });

  it('does not call clearLastResult after core GOTO synchronization', async () => {
    const clearLastResult = jest.fn(async () => undefined);
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue({
      kind: 'applied',
      runId: DEFAULT_RUNBOOK_ID,
      previousState: makeState(),
      updatedState: makeState({ step: '2' }),
      snapshot: {},
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      terminalReleaseMode: 'stack-pop',
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const outputAction = jest.fn();
    const output = {
      action: outputAction,
      flush: jest.fn(),
    } as unknown as OutputEmitter;
    const ctx = {
      output,
      manager: {
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // manager.load resolves null → propagation short-circuits `skipped`.
      expect(result.propagation).toEqual({ kind: 'skipped' });
    }
    expect(clearLastResult).not.toHaveBeenCalled();
    expect(outputAction).toHaveBeenCalledWith({
      action: 'GOTO 2',
      from: '1',
      at: '2',
    });
  });

  it('returns stopped when execution loop stops', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const runNavigationMutation = mockFn<RunbookLifecycleCommandService['runNavigationMutation']>();
    runNavigationMutation.mockResolvedValue({
      kind: 'applied',
      runId: DEFAULT_RUNBOOK_ID,
      previousState: makeState(),
      updatedState: makeState({ step: '2' }),
      snapshot: {},
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      terminalReleaseMode: 'stack-pop',
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('stopped');

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: {
        update,
        load: mockFn<RunbookStateManager['load']>().mockResolvedValue(null),
      } as unknown as RunbookStateManager,
      seam: { runNavigationMutation } as unknown as RunbookLifecycleCommandService,
      callerEvidence: { kind: 'direct_cli' as const },
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('stopped');
      // The loop stopped locally; propagation still short-circuits `skipped`
      // because manager.load resolves null (no parent linkage to report to).
      expect(result.propagation).toEqual({ kind: 'skipped' });
    }
  });
});

describe('gotoResultRequiresFailureExit', () => {
  // Pure predicate — the load-bearing half of #553: a successful goto must still
  // exit non-zero when the run stopped locally OR its terminal propagated to a
  // parent that stopped/blocked. `manager.load → null` in the executeGoto tests
  // keeps `propagation` at `skipped`, so these cases pin the non-skipped arm the
  // integration path never forced.
  type OkResult = Parameters<typeof gotoResultRequiresFailureExit>[0];

  it('requires failure exit when the loop stopped locally (no propagation)', () => {
    const result: OkResult = { ok: true, loopResult: 'stopped' };
    expect(gotoResultRequiresFailureExit(result)).toBe(true);
  });

  it('does not require failure exit when the run is still waiting with no propagation', () => {
    const result: OkResult = { ok: true, loopResult: 'waiting' };
    expect(gotoResultRequiresFailureExit(result)).toBe(false);
  });

  it('does not require failure exit when propagation was skipped', () => {
    const result: OkResult = { ok: true, loopResult: 'done', propagation: { kind: 'skipped' } };
    expect(gotoResultRequiresFailureExit(result)).toBe(false);
  });

  it('requires failure exit when an inline-advanced propagation stopped the parent', () => {
    const result: OkResult = {
      ok: true,
      loopResult: 'done',
      propagation: { kind: 'inline-advanced', result: 'stopped' },
    };
    expect(gotoResultRequiresFailureExit(result)).toBe(true);
  });

  it('requires failure exit when an inline-advanced propagation blocked the parent', () => {
    const result: OkResult = {
      ok: true,
      loopResult: 'done',
      propagation: { kind: 'inline-advanced', result: 'blocked' },
    };
    expect(gotoResultRequiresFailureExit(result)).toBe(true);
  });

  it('does not require failure exit when an inline-advanced propagation was handled', () => {
    const result: OkResult = {
      ok: true,
      loopResult: 'done',
      propagation: { kind: 'inline-advanced', result: 'handled' },
    };
    expect(gotoResultRequiresFailureExit(result)).toBe(false);
  });
});

describe('resolveTerminalReleaseModeForRunbook', () => {
  it('uses stack-pop for default-stack runbooks', async () => {
    const loadSession = mockFn<RunbookStateManager['loadSession']>();
    loadSession.mockResolvedValue({
      defaultStack: [DEFAULT_RUNBOOK_ID],
      claims: {},
    });

    const mode = await resolveTerminalReleaseModeForRunbook(
      { loadSession } as unknown as RunbookStateManager,
      DEFAULT_RUNBOOK_ID,
    );

    expect(mode).toBe('stack-pop');
  });

  it('uses release-runbook for claim-targeted runbooks', async () => {
    const loadSession = mockFn<RunbookStateManager['loadSession']>();
    loadSession.mockResolvedValue({
      defaultStack: [PARENT_RUNBOOK_ID],
      claims: {
        rdclm_abcdefghijklmnopqrstu1: makeClaimRecord({
          controlledRunId: CLAIMED_RUNBOOK_ID,
          delegation: {
            childRunId: CLAIMED_RUNBOOK_ID,
            parentRunId: PARENT_RUNBOOK_ID,
            parentStepId: '1.1',
            parentStep: '1',
            parentFrameKey: brandFrameKeyForTest('1'),
            parentEntry: 1,
            tokenHash: brandDelegationTokenHashForTest(
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ),
          },
          grants: [],
        }),
      },
    });

    const mode = await resolveTerminalReleaseModeForRunbook(
      { loadSession } as unknown as RunbookStateManager,
      CLAIMED_RUNBOOK_ID,
    );

    expect(mode).toBe('release-runbook');
  });
});
