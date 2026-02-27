import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  parseRunbookDocument: jest.fn(),
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveExecutionAt: jest.fn(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
  ),
  getActiveForContext: jest.fn().mockReturnValue(null),
  parseStepIdFromString: jest.fn(),
  STATE_DIR: '.claude/rundown/runs',
  DELEGATION_TOKEN_PREFIX: 'rdtk_',
  DelegationScanService: jest.fn(),
  DelegationLock: jest.fn(),
  reconstituteContextVars: jest.fn().mockReturnValue({}),
  hashDelegationToken: jest.fn().mockReturnValue('sha256:mock'),
  ErrorCodes: {
    INVALID_TOKEN: { code: 'RD-807' },
    TOKEN_NOT_FOUND: { code: 'RD-808' },
    TOKEN_CANCELLED: { code: 'RD-809' },
    DELEGATION_LOCK_TIMEOUT: { code: 'RD-810' },
  },
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  isSourced: jest.fn(),
}));

// Mock resolve-runbook
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: jest.fn(),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  buildStepVariables: jest.fn().mockReturnValue({ Step: '1.1' }),
  runExecutionLoop: jest.fn().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn().mockReturnValue({ emit: jest.fn() }),
}));

// Mock variable-discovery
jest.unstable_mockModule('../../src/services/variable-discovery', () => ({
  extractVarsFromMarkdown: jest.fn().mockReturnValue({}),
  resolveVariables: jest.fn().mockResolvedValue({ vars: {}, sources: {} }),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  expandForClauseVariables: jest.fn((content: string) => content),
  expandLoopVariables: jest.fn((text: string) => text),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS: CONTINUE'),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');

/** Create a minimal RunPipelineContext with mock OutputEmitter. */
function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    output: {
      error: jest.fn(),
      status: jest.fn(),
      action: jest.fn(),
      detail: jest.fn(),
      flush: jest.fn(),
    },
    manager: {
      load: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    actorService: {},
    sessionService: {},
    lifecycleService: {},
    cwd: '/tmp/test',
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Restore defaults after reset
  (core.hashDelegationToken as jest.Mock).mockReturnValue('sha256:mock');
  (core.reconstituteContextVars as jest.Mock).mockReturnValue({});
});

describe('claimAndLaunch', () => {
  it('returns INVALID_TOKEN for bad token format', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, 'bad-token', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-807');
      expect(result.error).toMatch(/invalid token format/i);
      // Token should be truncated, not raw
      expect(result.details?.token).toMatch(/\.\.\./);
    }
  });

  it('returns TOKEN_NOT_FOUND when scan finds no match', async () => {
    const ctx = makeCtx();

    // Mock scan returning null
    const mockFindByToken = jest.fn<any>().mockResolvedValue(null);
    (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
      findByToken: mockFindByToken,
    }));

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
    }
  });

  it('returns DELEGATION_LOCK_TIMEOUT when lock acquisition fails', async () => {
    const ctx = makeCtx();

    // Mock scan returning a result
    const mockFindByToken = jest.fn<any>().mockResolvedValue({
      parentState: { id: 'run-1', substepStates: [] },
      stepId: '1',
      substepId: '1',
      delegation: { tokenHash: 'sha256:mock', childRunbookPath: 'child.md' },
    });
    (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
      findByToken: mockFindByToken,
    }));

    // Mock lock acquisition failure
    const mockAcquire = jest.fn<any>().mockRejectedValue(new Error('lock timeout'));
    const mockRelease = jest.fn<any>().mockResolvedValue(undefined);
    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: mockAcquire,
      release: mockRelease,
    }));

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-810');
    }
  });

  it('returns TOKEN_CANCELLED when delegation is cancelled', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: 'run-1',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:mock',
            childRunbookPath: 'child.md',
            childRunId: null,
            cancelledAt: '2026-02-28T00:00:00.000Z',
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with cancelled delegation
    (ctx.manager.load as jest.Mock).mockResolvedValue(parentState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-809');
      expect(result.error).toMatch(/cancelled/i);
    }
  });

  it('returns idempotent success when childRunId already set', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: 'run-1',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:mock',
            childRunbookPath: 'child.md',
            childRunId: 'existing-child-run',
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with already-claimed delegation
    (ctx.manager.load as jest.Mock).mockResolvedValue(parentState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('existing-child-run');
      expect(result.parentRunId).toBe('run-1');
    }
  });
});
