import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers';

// Mock @rundown-org/core
jest.unstable_mockModule('@rundown-org/core', () => ({
  stepIdToString: jest.fn((id: { step: string; substep?: string }) =>
    id.substep ? `${id.step}.${id.substep}` : id.step,
  ),
  deriveExecutionAt: jest.fn(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
  ),
  deriveActiveFrame: jest
    .fn()
    .mockReturnValue({ step: '1', substep: undefined, iteration: undefined, frameKey: '1|' }),
  getActiveForContext: jest.fn().mockReturnValue(null),
  buildFrameKey: jest.fn(
    (step: string, iteration?: number) =>
      `${step}|${iteration !== undefined ? String(iteration) : ''}`,
  ),
  parseStepIdFromString: jest.fn(),
  STATE_DIR: '.claude/rundown/runs',
  DELEGATION_TOKEN_PREFIX: 'rdtk_',
  DEFAULT_POLICY: {
    version: 1,
    default: {
      mode: 'prompted',
      run: { allow: [], deny: [] },
      read: { allow: [], deny: [] },
      write: { allow: [], deny: [] },
      env: { allow: [], deny: [] },
    },
    overrides: [],
    grants: [],
  },
  PolicyEvaluator: jest.fn(),
  PolicyPrompter: jest.fn(),
  loadPolicy: jest.fn(),
  DelegationScanService: jest.fn().mockImplementation(() => ({
    findByToken: jest.fn().mockResolvedValue(null),
  })),
  DelegationLock: jest.fn(),
  reconstituteContextVars: jest.fn().mockReturnValue({}),
  hashDelegationToken: jest.fn().mockReturnValue('sha256:mock'),
  truncateDelegationToken: jest.fn((token: string) => {
    const prefix = 'rdtk_';
    const body = token.startsWith(prefix) ? token.slice(prefix.length) : token;
    if (body.length <= 7) return token;
    return `${prefix}${body.slice(0, 3)}...${body.slice(-4)}`;
  }),
  ErrorCodes: {
    INVALID_TOKEN: { code: 'RD-807' },
    TOKEN_NOT_FOUND: { code: 'RD-808' },
    TOKEN_CANCELLED: { code: 'RD-809' },
    DELEGATION_LOCK_TIMEOUT: { code: 'RD-810' },
  },
  ...mockErrorHelpers,
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  parseRunbookDocument: jest.fn(),
  isSourced: jest.fn(),
  isResolvedForClause: jest.fn().mockReturnValue(true),
  stepHasSubsteps: (step: { kind: string }) => step.kind === 'substeps' || step.kind === 'for',
  resolvedStepHasSubsteps: (step: { kind: string }) =>
    step.kind === 'substeps' || step.kind === 'for' || step.kind === 'prompted-for',
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
  FileSourcePolicyError: class FileSourcePolicyError extends Error {
    readonly code = 'POLICY_DENIED';
    readonly variable: string;
    readonly filePath: string;
    readonly reason: string;

    constructor(variable: string, filePath: string, reason: string) {
      super(`File source "${variable}" blocked by policy: ${reason}`);
      this.variable = variable;
      this.filePath = filePath;
      this.reason = reason;
    }
  },
  resolveVariables: jest.fn().mockResolvedValue({ vars: {}, sources: {}, warnings: [] }),
  RUNTIME_RESERVED_VARIABLES: new Set(['Date', 'DateTime', 'Year', 'Month', 'Day', 'WorkPath']),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  resolveForBounds: jest.fn((runbook: unknown) => ({ runbook, warnings: [] })),
  expandLoopVariables: jest.fn((text: string) => text),
  warnUnresolvedRunbookVariables: jest.fn().mockReturnValue([]),
  collectUnresolvedRunbookVariables: jest.fn().mockReturnValue(new Set()),
}));

// Mock validate-frontmatter-vars
jest.unstable_mockModule('../../src/helpers/validate-frontmatter-vars', () => ({
  validateFrontmatterVars: jest.fn().mockReturnValue([]),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE'),
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
  (core.truncateDelegationToken as jest.Mock).mockImplementation((token: string) => {
    const prefix = 'rdtk_';
    const body = token.startsWith(prefix) ? token.slice(prefix.length) : token;
    if (body.length <= 7) return token;
    return `${prefix}${body.slice(0, 3)}...${body.slice(-4)}`;
  });
  (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
    findByToken: jest.fn().mockResolvedValue(null),
  }));
  (core.reconstituteContextVars as jest.Mock).mockReturnValue({});
  (core.deriveActiveFrame as jest.Mock).mockReturnValue({
    step: '1',
    substep: undefined,
    iteration: undefined,
    frameKey: '1|',
  });
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

    // Mock lock acquisition failure with the actual timeout error message format
    const mockAcquire = jest
      .fn<any>()
      .mockRejectedValue(
        new Error('Delegation lock timeout for run run-1. Another operation may be in progress.'),
      );
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

  it('adopts orphaned child run when findOrphanedChild returns a match', async () => {
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
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    const orphanState = {
      id: 'orphan-run-id',
      delegation: { parentRunId: 'run-1', parentStepId: '1', tokenHash: 'sha256:mock' },
    };

    // Mock scan — findByToken returns parent, findOrphanedChild returns orphan
    (core.DelegationScanService as jest.Mock).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(orphanState),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with unclaimed delegation
    (ctx.manager.load as jest.Mock).mockResolvedValue(parentState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('orphan-run-id');
      expect(result.parentRunId).toBe('run-1');
    }

    // Verify update wrote the orphan's childRunId onto the parent delegation
    expect(ctx.manager.update).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        substepStates: expect.arrayContaining([
          expect.objectContaining({
            id: '1',
            delegation: expect.objectContaining({ childRunId: 'orphan-run-id' }),
          }),
        ]),
      }),
    );
  });

  it('re-throws non-timeout lock errors instead of masking them', async () => {
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

    // Mock lock throwing a non-timeout error (e.g. permission denied)
    const permissionError = new Error('EACCES: permission denied');
    const mockAcquire = jest.fn<any>().mockRejectedValue(permissionError);
    const mockRelease = jest.fn<any>().mockResolvedValue(undefined);
    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: mockAcquire,
      release: mockRelease,
    }));

    // cspell:disable-next-line
    await expect(claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {})).rejects.toThrow(
      'EACCES: permission denied',
    );
  });

  it('returns TOKEN_NOT_FOUND when parent state no longer exists after lock', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: 'run-deleted',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:mock',
            childRunbookPath: 'child.md',
            childRunId: null,
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

    // Mock manager.load returning null (state was deleted)
    (ctx.manager.load as jest.Mock).mockResolvedValue(null);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
      expect(result.error).toContain('no longer exists');
    }
  });

  it('returns TOKEN_NOT_FOUND when delegation disappears after lock', async () => {
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

    // Mock manager.load returning state without delegation
    (ctx.manager.load as jest.Mock).mockResolvedValue({
      id: 'run-1',
      substepStates: [{ id: '1', status: 'pending' }],
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
      expect(result.error).toContain('no longer exists');
    }
  });

  it('returns TOKEN_NOT_FOUND when token hash mismatches after reload', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: 'run-1',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:original',
            childRunbookPath: 'child.md',
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan returning original hash
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

    // Mock manager.load returning state with different hash
    (ctx.manager.load as jest.Mock).mockResolvedValue({
      id: 'run-1',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: 'sha256:different',
            childRunbookPath: 'child.md',
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    });

    // hashDelegationToken should return the original mock hash
    (core.hashDelegationToken as jest.Mock).mockReturnValue('sha256:original');

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
      expect(result.error).toContain('no longer exists');
    }
  });

  it('handles empty token string', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, '', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-807');
      expect(result.error).toMatch(/invalid token format/i);
    }
  });

  it('handles token with correct prefix but wrong length', async () => {
    const ctx = makeCtx();
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_SHORT', {});

    // Should validate format - scanner may return null or validation may catch it
    expect(result.ok).toBe(false);
    expect([core.ErrorCodes.INVALID_TOKEN.code, core.ErrorCodes.TOKEN_NOT_FOUND.code]).toContain(
      result.code,
    );
  });

  it('truncates token in error details for invalid format', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, 'invalid-very-long-token-string-here', {});

    expect(result.ok).toBe(false);
    if (!result.ok && result.details?.token) {
      // Should contain ellipsis for truncation
      expect(String(result.details.token)).toMatch(/\.\.\./);
    }
  });
});
