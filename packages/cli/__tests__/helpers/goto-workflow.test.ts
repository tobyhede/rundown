import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ResolvedStep, Substep, ForClause, Transitions } from '@rundown-org/parser';
import type {
  ActorSyncResult,
  RunbookActorService,
  RunbookState,
  RunbookStateManager,
  SessionService,
  StepId,
} from '@rundown-org/core';
import { assertClaimId } from '@rundown-org/core';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { brandDelegationTokenHashForTest, brandRunIdForTest } from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

const DEFAULT_RUNBOOK_ID = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
const PARENT_RUNBOOK_ID = brandRunIdForTest(`rd_${'7'.repeat(32)}`);
const CLAIMED_RUNBOOK_ID = brandRunIdForTest(`rd_${'8'.repeat(32)}`);

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookStateManager: jest.fn(),
  RunbookActorService: jest.fn(),
  SessionService: jest.fn(),
  parseStepIdFromString: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  buildStepPosition: jest.fn((current: string, total: number, substep?: string) => ({
    current,
    total,
    ...(substep ? { substep } : {}),
  })),
  derivePositionAt: jest.fn(
    (pos: { current: string; substep?: string; for?: { index: number } }) =>
      `${pos.current}${pos.for?.index != null ? `.${String(pos.for.index)}` : ''}${pos.substep ? `.${pos.substep}` : ''}`,
  ),
  countNumberedSteps: mockFn<(steps: readonly { name: string }[]) => number>().mockReturnValue(3),
  // Runtime-only validator with no service dependencies; pass-through preserves
  // structural mocking — every static import from @rundown-org/core resolves
  // through the factory rather than leaking the real module.
  assertClaimId: jest.fn((s: string) => s),
  ...mockErrorHelpers,
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

// Import after mocking
const core = await import('@rundown-org/core');
const { runExecutionLoop } = await import('../../src/services/execution.js');
const { validateGotoTarget, executeGoto, resolveTerminalReleaseModeForRunbook } = await import(
  '../../src/helpers/goto-workflow.js'
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
  jest.mocked(core.buildStepPosition).mockImplementation((current, total, substep) => ({
    current,
    total,
    ...(substep ? { substep } : {}),
  }));
  jest
    .mocked(core.derivePositionAt)
    .mockImplementation(
      (pos) =>
        `${pos.current}${pos.for?.index != null ? `.${String(pos.for.index)}` : ''}${pos.substep ? `.${pos.substep}` : ''}`,
    );
  jest.mocked(core.countNumberedSteps).mockReturnValue(3);
  jest.mocked(runExecutionLoop).mockResolvedValue('done');
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
      id: 'test-id' as RunbookState['id'],
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

  it('returns error when sendAndSync fails', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    const sendAndSync = mockFn<RunbookActorService['sendAndSync']>();
    sendAndSync.mockResolvedValue(null);

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: { update } as unknown as RunbookStateManager,
      actorService: { sendAndSync } as unknown as RunbookActorService,
      sessionService: {} as SessionService,
      state: makeState(),
      steps: [makeStep()],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ENGINE_INIT_FAILED');
    }
  });

  it('returns ok with loop result on success', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const sendAndSync = mockFn<RunbookActorService['sendAndSync']>();
    const syncResult: ActorSyncResult = {
      state: makeState({ step: '2' }),
      snapshot: {},
    };
    sendAndSync.mockResolvedValue(syncResult);
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const action = jest.fn();
    const ctx = {
      output: {
        action,
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: { update } as unknown as RunbookStateManager,
      actorService: { sendAndSync } as unknown as RunbookActorService,
      sessionService: {} as SessionService,
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
    }
    expect(action).toHaveBeenCalled();
    const updateArg = update.mock.calls[0][1];
    expect(updateArg).toHaveProperty('lastResult', undefined);
    expect(updateArg).toHaveProperty('lastAction', { type: 'GOTO', target: '2' });
  });

  it('returns stopped when execution loop stops', async () => {
    const update = mockFn<RunbookStateManager['update']>();
    update.mockImplementation(async (_id, _patch) => makeState({ step: '2' }));
    const sendAndSync = mockFn<RunbookActorService['sendAndSync']>();
    const syncResult: ActorSyncResult = {
      state: makeState({ step: '2' }),
      snapshot: {},
    };
    sendAndSync.mockResolvedValue(syncResult);
    jest.mocked(runExecutionLoop).mockResolvedValue('stopped');

    const ctx = {
      output: {
        action: jest.fn(),
        flush: jest.fn(),
      } as unknown as OutputEmitter,
      manager: { update } as unknown as RunbookStateManager,
      actorService: { sendAndSync } as unknown as RunbookActorService,
      sessionService: {} as SessionService,
      state: makeState(),
      steps: [makeStep({ name: '1' }), makeStep({ name: '2' })],
      cwd: '/test',
      terminalReleaseMode: 'stack-pop' as const,
    };

    const result = await executeGoto(ctx, { step: '2' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('stopped');
    }
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
        rdclm_abcdefghijklmnopqrstu1: {
          kind: 'claim-record',
          claimId: assertClaimId('rdclm_abcdefghijklmnopqrstu1'),
          childRunId: CLAIMED_RUNBOOK_ID,
          parentRunId: PARENT_RUNBOOK_ID,
          parentStepId: '1.1',
          tokenHash: brandDelegationTokenHashForTest(
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          ),
          claimedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const mode = await resolveTerminalReleaseModeForRunbook(
      { loadSession } as unknown as RunbookStateManager,
      CLAIMED_RUNBOOK_ID,
    );

    expect(mode).toBe('release-runbook');
  });
});
