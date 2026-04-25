import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import { brandFrameKeyForTest } from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const { isJsonArrayStream: realIsJsonArrayStream } = await import('@rundown-org/core');

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
  getActiveForContext: mockFn<() => unknown>().mockReturnValue(null),
  buildFrameKey: jest.fn(
    (step: string, iteration?: number) =>
      `${step}|${iteration !== undefined ? String(iteration) : ''}`,
  ),
  parseStepIdFromString: jest.fn(),
  RUNS_DIR: '.rundown/runs',
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
  DelegationScanService: mockFn<() => { findByToken: jest.Mock }>().mockImplementation(() => ({
    findByToken: mockFn<() => Promise<unknown>>().mockResolvedValue(null),
  })),
  DelegationLock: jest.fn(),
  DelegationLockTimeoutError: class DelegationLockTimeoutError extends Error {
    readonly parentRunId: string;
    readonly lockFile: string;
    constructor(parentRunId: string, lockFile = '/tmp/test.lock') {
      super(`Delegation lock timeout for run ${parentRunId}: ${lockFile}.`);
      this.name = 'DelegationLockTimeoutError';
      this.parentRunId = parentRunId;
      this.lockFile = lockFile;
    }
  },
  FileLockTimeoutError: class FileLockTimeoutError extends Error {
    readonly lockFile: string;
    constructor(lockFile = '/tmp/test.lock') {
      super(`File lock timeout: ${lockFile}.`);
      this.name = 'FileLockTimeoutError';
      this.lockFile = lockFile;
    }
  },
  reconstituteContextVars: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
  extractInheritedUserVars: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
  hashDelegationToken: mockFn<() => string>().mockReturnValue('sha256:mock'),
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
    LAUNCH_FAILED: { code: 'RD-816' },
  },
  isJsonArray: jest.fn((v: unknown) => Array.isArray(v)),
  isJsonArrayStream: jest.fn(realIsJsonArrayStream),
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  ...mockErrorHelpers,
}));

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  parseRunbookDocument: jest.fn(),
  isSourced: jest.fn(),
  isResolvedForClause: mockFn<() => boolean>().mockReturnValue(true),
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
  buildStepVariables: mockFn<() => Record<string, unknown>>().mockReturnValue({ Step: '1.1' }),
  runExecutionLoop:
    mockFn<
      (...args: unknown[]) => Promise<'done' | 'stopped' | 'waiting'>
    >().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<() => { emit: jest.Mock }>().mockReturnValue({ emit: jest.fn() }),
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
  resolveVariables: jest
    .fn<any>()
    .mockResolvedValue({ vars: {}, sources: {}, warnings: [], providedKeys: new Set() }),
  RUNTIME_RESERVED_VARIABLES: new Set(['Date', 'DateTime', 'Year', 'Month', 'Day', 'WorkPath']),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  resolveForBounds: jest.fn((runbook: unknown) => ({ runbook, warnings: [] })),
  expandLoopVariables: jest.fn((text: string) => text),
  warnUnresolvedRunbookVariables: mockFn<() => string[]>().mockReturnValue([]),
  collectUnresolvedRunbookVariables: mockFn<() => Set<string>>().mockReturnValue(new Set()),
}));

// Mock validate-frontmatter-vars
jest.unstable_mockModule('../../src/helpers/validate-frontmatter-vars', () => ({
  validateFrontmatterVars: mockFn<() => string[]>().mockReturnValue([]),
  validateRequiredVars: mockFn<() => string[]>().mockReturnValue([]),
  validateOutputsDeclarations: mockFn<() => string[]>().mockReturnValue([]),
}));

// Mock node:fs/promises
const actualFsPromises = await import('node:fs/promises');
jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsPromises,
  readFile: mockFn<() => Promise<string>>().mockResolvedValue(
    '# Test\n\n## 1. Step\n- PASS CONTINUE',
  ),
  mkdir: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook.js');
const { resolveVariables } = await import('../../src/services/variable-discovery.js');
const { substituteRunbookVariables, resolveForBounds, collectUnresolvedRunbookVariables } =
  await import('../../src/services/template-renderer.js');
const { validateFrontmatterVars, validateRequiredVars, validateOutputsDeclarations } = await import(
  '../../src/helpers/validate-frontmatter-vars.js'
);
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { runExecutionLoop } = await import('../../src/services/execution.js');
const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');

/**
 * Create a minimal RunPipelineContext with mock OutputEmitter.
 *
 * Returns a structurally-compatible test double cast through `unknown` —
 * production `RunPipelineContext` requires full service classes; tests
 * only stub the methods exercised by the code under test.
 */
function makeCtx(overrides: Record<string, unknown> = {}): RunPipelineContext {
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
      list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    actorService: {},
    sessionService: {},
    lifecycleService: {},
    cwd: '/tmp/test',
    ...overrides,
  } as unknown as RunPipelineContext;
}

beforeEach(() => {
  jest.resetAllMocks();
  // Restore defaults after reset
  jest.mocked(core.hashDelegationToken).mockReturnValue('sha256:mock');
  jest.mocked(core.truncateDelegationToken).mockImplementation((token: string) => {
    const prefix = 'rdtk_';
    const body = token.startsWith(prefix) ? token.slice(prefix.length) : token;
    if (body.length <= 7) return token;
    return `${prefix}${body.slice(0, 3)}...${body.slice(-4)}`;
  });
  // Partial mock: production code only consults `findByToken` here.
  jest.mocked(core.DelegationScanService).mockImplementation(
    () =>
      ({
        findByToken: mockFn<() => Promise<unknown>>().mockResolvedValue(null),
      }) as unknown as jest.MockedObject<InstanceType<typeof core.DelegationScanService>>,
  );
  jest.mocked(core.reconstituteContextVars).mockReturnValue({});
  jest.mocked(core.deriveActiveFrame).mockReturnValue({
    step: '1',
    iteration: undefined,
    frameKey: brandFrameKeyForTest('1'),
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: mockFindByToken,
    }));

    // Mock lock acquisition failure with a real DelegationLockTimeoutError
    // (the production code now branches on `instanceof`, not on the message string).
    const mockAcquire = mockFn<() => Promise<void>>();
    // `core` is the mocked module; the constructor is the mock-installed
    // class, not the real export. Cast through unknown to surface the
    // runtime constructor signature.
    mockAcquire.mockRejectedValue(
      new (
        core as unknown as {
          DelegationLockTimeoutError: new (id: string, lock: string) => Error;
        }
      ).DelegationLockTimeoutError('run-1', '/tmp/test.lock'),
    );
    const mockRelease = mockFn<() => Promise<void>>();
    mockRelease.mockResolvedValue(undefined);
    // Partial mock is intentional: tests only exercise acquire/release;
    // cwd/lockDir/lockPath fields aren't read by the code under test.
    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({ acquire: mockAcquire, release: mockRelease }) as unknown as jest.MockedObject<
          InstanceType<typeof core.DelegationLock>
        >,
    );

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
      variables: {},
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with cancelled delegation
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue(parentState);

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
      variables: {},
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with already-claimed delegation
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue(parentState);

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
      variables: {},
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(orphanState),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning fresh state with unclaimed delegation
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue(parentState);

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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: mockFindByToken,
    }));

    // Mock lock throwing a non-timeout error (e.g. permission denied)
    const permissionError = new Error('EACCES: permission denied');
    const mockAcquire = jest.fn<any>().mockRejectedValue(permissionError);
    const mockRelease = jest.fn<any>().mockResolvedValue(undefined);
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning null (state was deleted)
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue(null);

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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning state without delegation
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue({
      id: 'run-1',
      variables: {},
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // Mock manager.load returning state with different hash
    (ctx.manager.load as jest.Mock<any>).mockResolvedValue({
      id: 'run-1',
      variables: {},
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
    (core.hashDelegationToken as jest.Mock<any>).mockReturnValue('sha256:original');

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
    if (result.ok) throw new Error('expected failure');
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

  it('uses delegation frameKey for linkage, not parent current frame', async () => {
    // Parent state: delegation on iteration 3 (frameKey '1|3'), parent now on iteration 5
    const parentState = {
      id: 'run-1',
      step: '1',
      variables: {},
      substepStates: [
        {
          id: '1',
          frameKey: '1|3', // Delegation was created on iteration 3
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
    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    }));

    // Mock lock
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    // deriveActiveFrame returns the WRONG frame (parent has advanced to iteration 5)
    (core.deriveActiveFrame as jest.Mock<any>).mockReturnValue({
      step: '1',
      substep: undefined,
      iteration: 5,
      frameKey: '1|5',
    });

    // Set up prepareRunbook mocks (resetAllMocks clears these)
    (resolveRunbookFile as jest.Mock<any>).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as any);
    (validateFrontmatterVars as jest.Mock<any>).mockReturnValue([]);
    (validateRequiredVars as jest.Mock<any>).mockReturnValue([]);
    (validateOutputsDeclarations as jest.Mock<any>).mockReturnValue([]);
    (resolveVariables as jest.Mock<any>).mockResolvedValue({
      vars: {},

      warnings: [],
      providedKeys: new Set(),
    });
    (resolveForBounds as jest.Mock<any>).mockImplementation((runbook: unknown) => ({
      runbook,
      warnings: [],
    }));
    (substituteRunbookVariables as jest.Mock<any>).mockImplementation(
      (runbook: unknown) => runbook,
    );
    (collectUnresolvedRunbookVariables as jest.Mock<any>).mockReturnValue(new Set());
    (createBridgedEmitter as jest.Mock<any>).mockReturnValue({ emit: jest.fn() });
    (runExecutionLoop as jest.Mock<any>).mockResolvedValue('waiting');

    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'new-child-id',
      title: 'Child',
    });

    const ctx = makeCtx({
      manager: {
        load: jest.fn<any>().mockResolvedValue(parentState),
        create: mockCreate,
        update: jest.fn<any>().mockResolvedValue(undefined),
        list: jest.fn<any>().mockResolvedValue([]),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      },
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) },
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) },
      lifecycleService: {
        ensureActiveEntry: jest.fn<any>().mockResolvedValue({
          state: { activeEntry: 1, activeFrameKey: '1|5' },
          frameKey: '1|5',
          entry: 1,
        }),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);

    // Critical assertion: delegation linkage should use the delegation's stored
    // frameKey ('1|3'), NOT the parent's current frame ('1|5')
    expect(mockCreate).toHaveBeenCalledWith(
      'child.md',
      expect.anything(),
      expect.objectContaining({
        parentLinkage: expect.objectContaining({
          kind: 'delegation',
          parentFrameKey: '1|3',
        }),
      }),
    );
  });

  it('returns LAUNCH_FAILED (RD-816) when manager.create throws and releases the lock', async () => {
    const parentState = {
      id: 'run-1',
      step: '1',
      variables: {},
      substepStates: [
        {
          id: '1',
          frameKey: '1|0',
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

    (core.DelegationScanService as jest.Mock<any>).mockImplementation(() => ({
      findByToken: jest.fn<any>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    }));

    const mockRelease = jest.fn<any>().mockResolvedValue(undefined);
    (core.DelegationLock as jest.Mock<any>).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: mockRelease,
    }));

    (resolveRunbookFile as jest.Mock<any>).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as any);
    (validateFrontmatterVars as jest.Mock<any>).mockReturnValue([]);
    (validateRequiredVars as jest.Mock<any>).mockReturnValue([]);
    (validateOutputsDeclarations as jest.Mock<any>).mockReturnValue([]);
    (resolveVariables as jest.Mock<any>).mockResolvedValue({
      vars: {},
      warnings: [],
      providedKeys: new Set(),
    });
    (resolveForBounds as jest.Mock<any>).mockImplementation((runbook: unknown) => ({
      runbook,
      warnings: [],
    }));
    (substituteRunbookVariables as jest.Mock<any>).mockImplementation(
      (runbook: unknown) => runbook,
    );
    (collectUnresolvedRunbookVariables as jest.Mock<any>).mockReturnValue(new Set());

    // Critical: manager.create throws — exercises the new launchRunbook
    // try/catch and the previously-dead failure branch in claimAndLaunch.
    const initError = new Error('disk full while writing run state');
    const ctx = makeCtx({
      manager: {
        load: jest.fn<any>().mockResolvedValue(parentState),
        create: jest.fn<any>().mockRejectedValue(initError),
        update: jest.fn<any>().mockResolvedValue(undefined),
        list: jest.fn<any>().mockResolvedValue([]),
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      },
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) },
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) },
      lifecycleService: {
        ensureActiveEntry: jest.fn<any>().mockResolvedValue({
          state: { activeEntry: 1, activeFrameKey: '1|0' },
          frameKey: '1|0',
          entry: 1,
        }),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-816');
      expect(result.error).toContain('disk full');
    }
    // Lock must be released even on init failure
    expect(mockRelease).toHaveBeenCalledWith('run-1');
  });
});
