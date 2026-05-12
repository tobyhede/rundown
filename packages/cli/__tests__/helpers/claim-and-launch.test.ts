import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ClaimId,
  ClaimRecord,
  ClaimRunbookResult,
  DelegationLinkage,
  RunbookRef,
  RunId,
  RunbookState,
  SessionService,
  StepDelegation,
  TokenScanResult,
} from '@rundown-org/core';
import type { RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import type * as VariableDiscoveryModule from '../../src/services/variable-discovery.js';
import { assertVariant } from './assert-variant.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
} from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { mockFn } from './typed-mocks.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const { isJsonArrayStream: realIsJsonArrayStream } = await import('@rundown-org/core');

const MOCK_TOKEN_HASH = brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`);
const DIFFERENT_TOKEN_HASH = brandDelegationTokenHashForTest(`sha256:${'b'.repeat(64)}`);
const ORIGINAL_TOKEN_HASH = brandDelegationTokenHashForTest(`sha256:${'c'.repeat(64)}`);
const TEST_CLAIM_ID = 'rdclm_abcdefghijklmnopqrstu1' as ClaimId;
const RUN_ID = brandRunIdForTest('rd_11111111111111111111111111111111');
const DIFFERENT_RUN_ID = brandRunIdForTest('rd_22222222222222222222222222222222');
const EXISTING_CHILD_RUN_ID = brandRunIdForTest('rd_33333333333333333333333333333333');
const ORPHAN_RUN_ID = brandRunIdForTest('rd_44444444444444444444444444444444');
const EXISTING_SESSION_CHILD_ID = brandRunIdForTest('rd_55555555555555555555555555555555');
const NEW_CHILD_ID = brandRunIdForTest('rd_66666666666666666666666666666666');

function claimRecord(childRunId: RunId, overrides: Partial<ClaimRecord> = {}): ClaimRecord {
  return {
    kind: 'claim-record',
    claimId: TEST_CLAIM_ID,
    childRunId,
    tokenHash: MOCK_TOKEN_HASH,
    parentRunId: RUN_ID,
    parentStepId: '1',
    claimedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  };
}

function claimedRunbookResult(
  childRunId: RunId,
  overrides: Partial<ClaimRecord> = {},
): ClaimRunbookResult {
  return { status: 'claimed', claim: claimRecord(childRunId, overrides) };
}

function mockClaimRunbookSuccess(): jest.Mock<SessionService['claimRunbook']> {
  return mockFn<SessionService['claimRunbook']>().mockImplementation(
    async (childRunId: RunId, linkage: DelegationLinkage) =>
      claimedRunbookResult(childRunId, {
        tokenHash: linkage.tokenHash,
        parentRunId: linkage.parentRunId,
        parentStepId: linkage.parentStepId,
        parentStep: linkage.parentStep,
        parentFrameKey: linkage.parentFrameKey,
        parentEntry: linkage.parentEntry,
      }),
  );
}

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
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
  RunbookRefSchema: {
    parse: jest.fn((ref: unknown) => ref),
  },
  generateRunId: jest.fn(() => `rd_${'a'.repeat(32)}`),
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
    findByToken: mockFn<() => Promise<TokenScanResult | null>>().mockResolvedValue(null),
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
  hashDelegationToken: mockFn<() => string>().mockReturnValue(MOCK_TOKEN_HASH),
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
    CLAIM_INVARIANT_VIOLATED: { code: 'RD-820' },
  },
  isJsonArray: jest.fn((v: unknown) => Array.isArray(v)),
  isJsonArrayStream: jest.fn(realIsJsonArrayStream),
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  ...mockErrorHelpers,
}));

const actualResolveRunbook = await import('../../src/helpers/resolve-runbook.js');

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  parseRunbookDocument: jest.fn(),
  isSourced: jest.fn(),
  isResolvedForClause: mockFn<() => boolean>().mockReturnValue(true),
  stepHasSubsteps: (step: { kind: string }) => step.kind === 'substeps' || step.kind === 'for',
  resolvedStepHasSubsteps: (step: { kind: string }) =>
    step.kind === 'substeps' || step.kind === 'for' || step.kind === 'prompted-for',
}));

// Mock resolve-runbook discovery while delegating runbook-ref derivation to
// the production implementation by default. Individual tests can still
// override buildRunbookRef for error/mismatch cases.
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  ...actualResolveRunbook,
  resolveRunbookFile: jest.fn(),
  resolveRunbookRef: jest.fn((_cwd: string, ref: RunbookRef) =>
    Promise.resolve({
      ok: true,
      resolved: {
        path: `/tmp/test/${ref.path}`,
        source: ref.source,
        sourceRoot: '/tmp/test',
      },
    }),
  ),
  buildRunbookRef: jest.fn(actualResolveRunbook.buildRunbookRef),
}));

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  buildStepVariables: mockFn<() => Record<string, unknown>>().mockReturnValue({ Step: '1.1' }),
  runExecutionLoop:
    mockFn<(...args: unknown[]) => Promise<'done' | 'stopped' | 'waiting'>>().mockResolvedValue(
      'done',
    ),
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
  resolveVariables: mockFn<typeof VariableDiscoveryModule.resolveVariables>().mockResolvedValue({
    vars: {},
    warnings: [],
    providedKeys: new Set(),
  }),
  RUNTIME_RESERVED_VARIABLES: new Set(['Date', 'DateTime', 'Year', 'Month', 'Day', 'WorkPath']),
  BUILTIN_VARIABLES: {
    Date: 'Date',
    DateTime: 'DateTime',
    Year: 'Year',
    Month: 'Month',
    Day: 'Day',
    Branch: 'Branch',
    WorkPath: 'WorkPath',
    ContextId: 'ContextId',
    Step: 'Step',
    Index: 'Index',
    RunbookRef: 'RunbookRef',
    RunId: 'RunId',
  },
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
const { resolveRunbookFile, resolveRunbookRef, buildRunbookRef } = await import(
  '../../src/helpers/resolve-runbook.js'
);
const { resolveVariables } = await import('../../src/services/variable-discovery.js');
const { substituteRunbookVariables, resolveForBounds, collectUnresolvedRunbookVariables } =
  await import('../../src/services/template-renderer.js');
const { validateOutputsDeclarations } = await import(
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
    sessionService: {
      claimRunbook: mockClaimRunbookSuccess(),
      findClaimForDelegation:
        mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
    },
    lifecycleService: {},
    cwd: '/tmp/test',
    ...overrides,
  } as unknown as RunPipelineContext;
}

/**
 * Configure `core.DelegationScanService` so that `findByToken` resolves to
 * `result` and (optionally) `findOrphanedChild` resolves to `orphan`.
 *
 * Partial mock is intentional: tests only exercise these two methods.
 * The cast through unknown surfaces the constructor's instance shape
 * without forcing every internal field onto the literal.
 */
type DelegationScanServiceInstance = InstanceType<typeof core.DelegationScanService>;
type FindByTokenResult = Awaited<ReturnType<DelegationScanServiceInstance['findByToken']>>;
type FindOrphanedChildResult = Awaited<
  ReturnType<DelegationScanServiceInstance['findOrphanedChild']>
>;

function scanResult(fields: {
  parentState: unknown;
  stepId: string;
  substepId?: string;
  delegation: unknown;
  frameKey?: TokenScanResult['frameKey'];
}): TokenScanResult {
  const result: TokenScanResult = {
    parentState: fields.parentState as RunbookState,
    stepId: fields.stepId,
    frameKey: fields.frameKey ?? brandFrameKeyForTest(fields.stepId),
    delegation: fields.delegation as StepDelegation,
  };
  if (fields.substepId !== undefined) {
    return { ...result, substepId: fields.substepId };
  }
  return result;
}

function mockScanService(result: FindByTokenResult, orphan?: FindOrphanedChildResult): void {
  jest.mocked(core.DelegationScanService).mockImplementation(
    () =>
      ({
        findByToken:
          mockFn<DelegationScanServiceInstance['findByToken']>().mockResolvedValue(result),
        findOrphanedChild: mockFn<
          DelegationScanServiceInstance['findOrphanedChild']
        >().mockResolvedValue(orphan ?? null),
      }) as unknown as jest.MockedObject<InstanceType<typeof core.DelegationScanService>>,
  );
}

/**
 * Configure `core.DelegationLock` with the given acquire/release mocks.
 *
 * Partial mock is intentional: production code only invokes `acquire` and
 * `release`. The cast surfaces the full instance shape without forcing
 * `cwd` / `lockDir` / `lockPath` fields onto the literal.
 *
 * `release` accepts an optional `runId` argument in production (the lock
 * scopes per-parent-run) — the mock signature mirrors that so
 * `toHaveBeenCalledWith(RUN_ID)` type-checks.
 */
function mockDelegationLock(
  acquire: jest.Mock<(...args: unknown[]) => Promise<void>>,
  release: jest.Mock<(...args: unknown[]) => Promise<void>>,
): void {
  jest
    .mocked(core.DelegationLock)
    .mockImplementation(
      () =>
        ({ acquire, release }) as unknown as jest.MockedObject<
          InstanceType<typeof core.DelegationLock>
        >,
    );
}

/** Convenience: build a default acquire/release pair that always succeeds. */
function mockHappyDelegationLock(): {
  acquire: jest.Mock<(...args: unknown[]) => Promise<void>>;
  release: jest.Mock<(...args: unknown[]) => Promise<void>>;
} {
  const acquire = mockFn<(...args: unknown[]) => Promise<void>>();
  acquire.mockResolvedValue(undefined);
  const release = mockFn<(...args: unknown[]) => Promise<void>>();
  release.mockResolvedValue(undefined);
  mockDelegationLock(acquire, release);
  return { acquire, release };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Restore defaults after reset
  jest.mocked(core.runbooksDir).mockImplementation((cwd: string) => `${cwd}/.rundown/runbooks`);
  const runbookRefSchemaMock = core.RunbookRefSchema as unknown as {
    parse: jest.MockedFunction<(ref: unknown) => RunbookRef>;
  };
  runbookRefSchemaMock.parse.mockImplementation((ref: unknown) => ref as RunbookRef);
  jest.mocked(core.hashDelegationToken).mockReturnValue(MOCK_TOKEN_HASH);
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
        findByToken: mockFn<DelegationScanServiceInstance['findByToken']>().mockResolvedValue(null),
      }) as unknown as jest.MockedObject<InstanceType<typeof core.DelegationScanService>>,
  );
  jest.mocked(core.reconstituteContextVars).mockReturnValue({});
  jest.mocked(core.deriveActiveFrame).mockReturnValue({
    step: '1',
    iteration: undefined,
    frameKey: brandFrameKeyForTest('1'),
  });
  jest.mocked(resolveRunbookRef).mockImplementation((_cwd: string, ref: RunbookRef) =>
    Promise.resolve({
      ok: true,
      resolved: {
        path: `/tmp/test/${ref.path}`,
        source: ref.source,
        sourceRoot: '/tmp/test',
      },
    }),
  );
  jest.mocked(buildRunbookRef).mockImplementation(actualResolveRunbook.buildRunbookRef);
  jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
});

describe('claimAndLaunch', () => {
  it('returns INVALID_TOKEN for bad token format', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, 'bad-token', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'invalid-token');
      // Token should be truncated, not raw
      expect(result.token).toMatch(/\.\.\./);
    }
  });

  it('returns TOKEN_NOT_FOUND when scan finds no match', async () => {
    const ctx = makeCtx();

    // Mock scan returning null
    mockScanService(null);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'token-not-found');
    }
  });

  it('returns DELEGATION_LOCK_TIMEOUT when lock acquisition fails', async () => {
    const ctx = makeCtx();

    // Mock scan returning a result
    mockScanService(
      scanResult({
        parentState: { id: RUN_ID, substepStates: [] },
        stepId: '1',
        substepId: '1',
        delegation: { tokenHash: MOCK_TOKEN_HASH, childRunbookPath: 'child.md' },
      }),
    );

    // Mock lock acquisition failure with a real DelegationLockTimeoutError
    // (the production code now branches on `instanceof`, not on the message string).
    const mockAcquire = mockFn<(...args: unknown[]) => Promise<void>>();
    // `core` is the mocked module; the constructor is the mock-installed
    // class, not the real export. Cast through unknown to surface the
    // runtime constructor signature.
    mockAcquire.mockRejectedValue(
      new (
        core as unknown as {
          DelegationLockTimeoutError: new (id: string, lock: string) => Error;
        }
      ).DelegationLockTimeoutError(RUN_ID, '/tmp/test.lock'),
    );
    const mockRelease = mockFn<(...args: unknown[]) => Promise<void>>();
    mockRelease.mockResolvedValue(undefined);
    mockDelegationLock(mockAcquire, mockRelease);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'lock-timeout');
      expect(result.parentRunId).toBe(RUN_ID);
    }
  });

  it('returns TOKEN_CANCELLED when delegation is cancelled', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: '2026-02-28T00:00:00.000Z',
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      null,
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning fresh state with cancelled delegation
    // (cast through unknown: tests use minimal fixtures rather than full RunbookState)
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'delegation-cancelled');
      expect(result.cancelledAt).toBe('2026-02-28T00:00:00.000Z');
    }
  });

  it('returns idempotent success when childRunId already set', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: EXISTING_CHILD_RUN_ID,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning fresh state with already-claimed delegation
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe(EXISTING_CHILD_RUN_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }
  });

  it('adopts orphaned child run when findOrphanedChild returns a match', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    const orphanState = {
      id: ORPHAN_RUN_ID,
      delegation: { parentRunId: RUN_ID, parentStepId: '1', tokenHash: MOCK_TOKEN_HASH },
    };

    // Mock scan — findByToken returns parent, findOrphanedChild returns orphan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
      orphanState as unknown as RunbookState,
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning fresh state with unclaimed delegation
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe(ORPHAN_RUN_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }

    // Verify update wrote the orphan's childRunId onto the parent delegation
    const { update: updateMock } = ctx.manager as unknown as { update: jest.Mock };
    expect(updateMock).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        substepStates: expect.arrayContaining([
          expect.objectContaining({
            id: '1',
            delegation: expect.objectContaining({ childRunId: ORPHAN_RUN_ID }),
          }),
        ]),
      }),
    );
  });

  it('returns existing session claim when delegation has no linked child', async () => {
    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          frameKey: brandFrameKeyForTest('1'),
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };
    const existingChildState = { id: EXISTING_SESSION_CHILD_ID, lifecycle: 'running' };
    const findClaimForDelegation = mockFn<
      SessionService['findClaimForDelegation']
    >().mockResolvedValue(
      claimRecord(EXISTING_SESSION_CHILD_ID, {
        parentRunId: RUN_ID,
        parentStepId: '1',
      }),
    );
    const claimRunbook = mockClaimRunbookSuccess();
    const update = mockFn<() => Promise<void>>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      manager: {
        load: mockFn<(id: string) => Promise<unknown>>().mockImplementation(async (id) =>
          id === EXISTING_SESSION_CHILD_ID ? existingChildState : parentState,
        ),
        update,
      },
      sessionService: {
        claimRunbook,
        findClaimForDelegation,
      },
    });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1'),
      }),
      null,
    );
    mockHappyDelegationLock();

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe(EXISTING_SESSION_CHILD_ID);
      expect(result.loopResult).toBe('waiting');
    }
    expect(findClaimForDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: RUN_ID,
        parentStepId: '1',
        tokenHash: MOCK_TOKEN_HASH,
      }),
    );
    expect(claimRunbook).toHaveBeenCalledWith(
      EXISTING_SESSION_CHILD_ID,
      expect.objectContaining({
        parentRunId: RUN_ID,
        parentStepId: '1',
        tokenHash: MOCK_TOKEN_HASH,
      }),
    );
    expect(update).toHaveBeenCalled();
  });

  it('surfaces linkage-mismatch when existing session claim child linkage diverges', async () => {
    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          frameKey: brandFrameKeyForTest('1'),
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };
    const existingChildState = { id: EXISTING_SESSION_CHILD_ID, lifecycle: 'running' };
    const findClaimForDelegation = mockFn<
      SessionService['findClaimForDelegation']
    >().mockResolvedValue(
      claimRecord(EXISTING_SESSION_CHILD_ID, {
        parentRunId: RUN_ID,
        parentStepId: '1',
      }),
    );
    const incoming: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: RUN_ID,
      parentStepId: '1',
      tokenHash: MOCK_TOKEN_HASH,
    };
    const persisted: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: DIFFERENT_RUN_ID,
      parentStepId: '1',
      tokenHash: MOCK_TOKEN_HASH,
    };
    const claimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue({
      status: 'linkage-mismatch',
      childRunId: EXISTING_SESSION_CHILD_ID,
      incoming,
      persisted,
    });
    const update = mockFn<() => Promise<void>>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      manager: {
        load: mockFn<(id: string) => Promise<unknown>>().mockImplementation(async (id) =>
          id === EXISTING_SESSION_CHILD_ID ? existingChildState : parentState,
        ),
        update,
      },
      sessionService: {
        claimRunbook,
        findClaimForDelegation,
      },
    });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1'),
      }),
      null,
    );
    mockHappyDelegationLock();

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'linkage-mismatch');
      expect(result.childRunId).toBe(EXISTING_SESSION_CHILD_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }
    expect(claimRunbook).toHaveBeenCalledWith(
      EXISTING_SESSION_CHILD_ID,
      expect.objectContaining({
        parentRunId: RUN_ID,
        parentStepId: '1',
        tokenHash: MOCK_TOKEN_HASH,
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('surfaces child-missing when claimRunbook reports the child state is gone', async () => {
    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: EXISTING_CHILD_RUN_ID,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    const mockClaimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue({
      status: 'missing-child',
      childRunId: EXISTING_CHILD_RUN_ID,
    });

    const ctx = makeCtx({
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbook,
      },
    });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );
    mockHappyDelegationLock();
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'child-missing');
      expect(result.childRunId).toBe(EXISTING_CHILD_RUN_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }
    expect(mockClaimRunbook).toHaveBeenCalled();
  });

  it('surfaces linkage-mismatch when claimRunbook reports persisted linkage divergence', async () => {
    const parentState = {
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: EXISTING_CHILD_RUN_ID,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    const incoming: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: RUN_ID,
      parentStepId: '1',
      tokenHash: MOCK_TOKEN_HASH,
    };
    const persisted: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: RUN_ID,
      parentStepId: '1',
      tokenHash: DIFFERENT_TOKEN_HASH,
    };
    const mockClaimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue({
      status: 'linkage-mismatch',
      childRunId: EXISTING_CHILD_RUN_ID,
      incoming,
      persisted,
    });

    const ctx = makeCtx({
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbook,
      },
    });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );
    mockHappyDelegationLock();
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'linkage-mismatch');
      expect(result.childRunId).toBe(EXISTING_CHILD_RUN_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }
    expect(mockClaimRunbook).toHaveBeenCalled();
  });

  it('re-throws non-timeout lock errors instead of masking them', async () => {
    const ctx = makeCtx();

    // Mock scan returning a result
    mockScanService(
      scanResult({
        parentState: { id: RUN_ID, substepStates: [] },
        stepId: '1',
        substepId: '1',
        delegation: { tokenHash: MOCK_TOKEN_HASH, childRunbookPath: 'child.md' },
      }),
    );

    // Mock lock throwing a non-timeout error (e.g. permission denied)
    const permissionError = new Error('EACCES: permission denied');
    const mockAcquire = mockFn<(...args: unknown[]) => Promise<void>>();
    mockAcquire.mockRejectedValue(permissionError);
    const mockRelease = mockFn<(...args: unknown[]) => Promise<void>>();
    mockRelease.mockResolvedValue(undefined);
    mockDelegationLock(mockAcquire, mockRelease);

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
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning null (state was deleted)
    jest.mocked(ctx.manager).load.mockResolvedValue(null);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'parent-missing');
      expect(result.parentRunId).toBe('run-deleted');
    }
  });

  it.each([
    'completed',
    'stopped',
  ] as const)('returns parent-ended when parent is %s after lock', async (lifecycle) => {
    const ctx = makeCtx();
    const parentState = {
      id: `run-${lifecycle}`,
      lifecycle: 'running',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );
    mockHappyDelegationLock();
    jest.mocked(ctx.manager).load.mockResolvedValue({
      ...parentState,
      lifecycle,
    } as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'parent-ended');
      expect(result.parentRunId).toBe(`run-${lifecycle}`);
      expect(result.lifecycle).toBe(lifecycle);
    }
  });

  it('returns TOKEN_NOT_FOUND when delegation disappears after lock', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning state without delegation
    jest.mocked(ctx.manager).load.mockResolvedValue({
      id: RUN_ID,
      variables: {},
      substepStates: [{ id: '1', status: 'pending' }],
    } as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'delegation-removed');
      expect(result.parentRunId).toBe(RUN_ID);
      expect(result.stepId).toBe('1');
    }
  });

  it('returns TOKEN_NOT_FOUND when token hash mismatches after reload', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: ORIGINAL_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan returning original hash
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
      }),
    );

    // Mock lock
    mockHappyDelegationLock();

    // Mock manager.load returning state with different hash
    jest.mocked(ctx.manager).load.mockResolvedValue({
      id: RUN_ID,
      variables: {},
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: DIFFERENT_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    } as unknown as RunbookState);

    // hashDelegationToken should return the original mock hash
    jest.mocked(core.hashDelegationToken).mockReturnValue(ORIGINAL_TOKEN_HASH);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'delegation-removed');
      expect(result.parentRunId).toBe(RUN_ID);
      expect(result.stepId).toBe('1');
    }
  });

  it('handles empty token string', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, '', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'invalid-token');
    }
  });

  it('handles token with correct prefix but wrong length', async () => {
    const ctx = makeCtx();
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_SHORT', {});

    // Should validate format - scanner may return null or validation may catch it
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(['invalid-token', 'token-not-found']).toContain(result.reason);
  });

  it('truncates token in error details for invalid format', async () => {
    const ctx = makeCtx();
    const result = await claimAndLaunch(ctx, 'invalid-very-long-token-string-here', {});

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'invalid-token') {
      // Should contain ellipsis for truncation
      expect(result.token).toMatch(/\.\.\./);
    }
  });

  it('uses delegation frameKey for linkage, not parent current frame', async () => {
    // Parent state: delegation on iteration 3 (frameKey '1|3'), parent now on iteration 5
    const parentState = {
      id: RUN_ID,
      step: '1',
      variables: {},
      substepStates: [
        {
          id: '1',
          frameKey: '1|3', // Delegation was created on iteration 3
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    // Mock scan
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 3),
      }),
      null,
    );

    // Mock lock
    mockHappyDelegationLock();

    // deriveActiveFrame returns the WRONG frame (parent has advanced to iteration 5)
    jest.mocked(core.deriveActiveFrame).mockReturnValue({
      step: '1',
      iteration: 5,
      frameKey: brandFrameKeyForTest('1', 5),
    });

    // Set up prepareRunbook mocks (resetAllMocks clears these)
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
    // Cast through unknown: the parser fixture is a minimal stand-in
    // (real Runbook type carries many more fields than this test reads).
    jest.mocked(parser.parseRunbookDocument).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as unknown as ReturnType<typeof parser.parseRunbookDocument>);
    jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
    // Cast through unknown: ResolvedVariables uses a branded vars map
    // and tracks more fields than this fixture provides.
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: [],
      providedKeys: new Set(),
    } as unknown as Awaited<ReturnType<typeof resolveVariables>>);
    // Cast through unknown: test impl identity-passes the AST, but
    // resolveForBounds returns a `ResolvedRunbook` (post-FOR-resolution
    // brand) while the input is a plain `Runbook`. Production fixtures
    // would resolve FOR bounds; the test sidesteps that branch.
    jest
      .mocked(resolveForBounds)
      .mockImplementation(
        (runbook) => ({ runbook, warnings: [] }) as unknown as ReturnType<typeof resolveForBounds>,
      );
    jest.mocked(substituteRunbookVariables).mockImplementation((runbook) => runbook);
    jest.mocked(collectUnresolvedRunbookVariables).mockReturnValue(new Set());
    // Cast through unknown: the bridged emitter exposes more methods than
    // emit(); the test doesn't exercise them so a partial stub suffices.
    jest
      .mocked(createBridgedEmitter)
      .mockReturnValue({ emit: jest.fn() } as unknown as ReturnType<typeof createBridgedEmitter>);
    jest.mocked(runExecutionLoop).mockResolvedValue('waiting');

    const mockCreate = mockFn<(...args: unknown[]) => Promise<{ id: RunId; title: string }>>();
    mockCreate.mockResolvedValue({
      id: NEW_CHILD_ID,
      title: 'Child',
    });

    const mockClaimRunbook = mockClaimRunbookSuccess();

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockCreate,
        update: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
        initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          step: '1',
        } as unknown as RunbookState),
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbook,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
      lifecycleService: {
        ensureActiveEntry: mockFn<
          () => Promise<{
            state: { activeEntry: number; activeFrameKey: string };
            frameKey: string;
            entry: number;
          }>
        >().mockResolvedValue({
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
      { source: 'project', path: 'child.md' },
      expect.anything(),
      expect.objectContaining({
        parentLinkage: expect.objectContaining({
          kind: 'delegation',
          parentFrameKey: '1|3',
        }),
      }),
    );

    // Result surfaces the claim id returned by claimRunbook, and claimRunbook
    // is called with the freshly built linkage (not stale persisted data).
    if (result.ok) {
      // cspell:disable-next-line
      expect(result.claimId).toBe('rdclm_abcdefghijklmnopqrstu1');
      expect(result.childRunId).toBe(NEW_CHILD_ID);
    }
    expect(mockClaimRunbook).toHaveBeenCalledWith(
      NEW_CHILD_ID,
      expect.objectContaining({
        kind: 'delegation',
        parentFrameKey: '1|3',
      }),
    );
  });

  it('returns LAUNCH_FAILED (RD-816) when manager.create throws and releases the lock', async () => {
    const parentState = {
      id: RUN_ID,
      step: '1',
      variables: {},
      substepStates: [
        {
          id: '1',
          frameKey: '1|0',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
      null,
    );

    const { release: mockRelease } = mockHappyDelegationLock();

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
    // Cast through unknown: minimal parser fixture (see frameKey linkage test).
    jest.mocked(parser.parseRunbookDocument).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as unknown as ReturnType<typeof parser.parseRunbookDocument>);
    jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: [],
      providedKeys: new Set(),
    } as unknown as Awaited<ReturnType<typeof resolveVariables>>);
    jest
      .mocked(resolveForBounds)
      .mockImplementation(
        (runbook) => ({ runbook, warnings: [] }) as unknown as ReturnType<typeof resolveForBounds>,
      );
    jest.mocked(substituteRunbookVariables).mockImplementation((runbook) => runbook);
    jest.mocked(collectUnresolvedRunbookVariables).mockReturnValue(new Set());

    // Critical: manager.create throws — exercises the new launchRunbook
    // try/catch and the previously-dead failure branch in claimAndLaunch.
    const initError = new Error('disk full while writing run state');
    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create:
          mockFn<(...args: unknown[]) => Promise<RunbookState>>().mockRejectedValue(initError),
        update: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
        initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      actorService: {
        initializeState: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
      lifecycleService: {
        ensureActiveEntry: mockFn<
          () => Promise<{
            state: { activeEntry: number; activeFrameKey: string };
            frameKey: string;
            entry: number;
          }>
        >().mockResolvedValue({
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
      assertVariant(result, 'reason', 'launch-failed');
      expect(result.code).toBe('RD-816');
      expect(result.cause).toContain('disk full');
    }
    // Lock must be released even on init failure
    expect(mockRelease).toHaveBeenCalledWith(RUN_ID);
  });

  it('returns CLAIM_INVARIANT_VIOLATED (RD-820) when claimChildForPipeline fails after fresh launch and does not execute the loop', async () => {
    const parentState = {
      id: RUN_ID,
      step: '1',
      variables: {},
      substepStates: [
        {
          id: '1',
          frameKey: '1|0',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
      null,
    );

    const { release: mockRelease } = mockHappyDelegationLock();

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
    // Cast through unknown: minimal parser fixture (see frameKey linkage test).
    jest.mocked(parser.parseRunbookDocument).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as unknown as ReturnType<typeof parser.parseRunbookDocument>);
    jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: [],
      providedKeys: new Set(),
    } as unknown as Awaited<ReturnType<typeof resolveVariables>>);
    jest
      .mocked(resolveForBounds)
      .mockImplementation(
        (runbook) => ({ runbook, warnings: [] }) as unknown as ReturnType<typeof resolveForBounds>,
      );
    jest.mocked(substituteRunbookVariables).mockImplementation((runbook) => runbook);
    jest.mocked(collectUnresolvedRunbookVariables).mockReturnValue(new Set());

    // claimRunbook returns missing-child — simulates claimChildForPipeline failure
    const mockClaimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue({
      status: 'missing-child',
      childRunId: NEW_CHILD_ID,
    });

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockFn<
          (...args: unknown[]) => Promise<{ id: RunId; title: string }>
        >().mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' }),
        update: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
        initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          step: '1',
        } as unknown as RunbookState),
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbook,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
      lifecycleService: {
        ensureActiveEntry: mockFn<
          () => Promise<{
            state: { activeEntry: number; activeFrameKey: string };
            frameKey: string;
            entry: number;
          }>
        >().mockResolvedValue({
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
      assertVariant(result, 'reason', 'launch-failed');
      expect(result.code).toBe('RD-820');
      expect(result.cause).toContain(NEW_CHILD_ID);
    }
    // Execution loop must not have run — the throw aborted launchRunbook before it
    expect(runExecutionLoop).not.toHaveBeenCalled();
    // Lock must be released even on claim failure
    expect(mockRelease).toHaveBeenCalledWith(RUN_ID);
  });
});
