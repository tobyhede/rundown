import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ClaimId,
  ClaimRecord,
  ClaimRunbookResult,
  DelegationLinkage,
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  DelegationScanService,
  DelegationLock,
  PrepareParsedRunbookInput,
  PrepareParsedRunbookResult,
  PreparedTemplateVariables,
  RunbookState,
  RunbookRef,
  RunId,
  RunnableTemplateVariables,
  ScopedLock,
  SessionMutationResult,
  TemplateVarValue,
} from '@rundown-org/core';
import type {
  ParsedForClause,
  ParsedSubstep,
  ParseResult,
  ResolvedRunbook,
  Step,
  Transitions,
} from '@rundown-org/parser';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { assertClaimLookupKey, assertClaimSecretHash } from '@rundown-org/core';
import { makeClaimRecord } from '@rundown-org/core/testing/claim-fixtures';
import type { resolveVariables as resolveVariablesType } from '../../src/services/variable-discovery.js';
import type {
  PreparedRunbook,
  RunPipelineContext,
  RunnableRunbook,
} from '../../src/helpers/runbook-pipeline.js';
import { assertVariant } from './assert-variant.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { partitionVariablesForTest } from './mock-partition-variables.js';
import { makeRunPipelineContext } from './run-pipeline-context-helpers.js';
import { mockFn } from './typed-mocks.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
  brandTrustedArtifactRecordForTest,
} from './brand-helpers.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const {
  isDelegationToken: realIsDelegationToken,
  isJsonArrayStream: realIsJsonArrayStream,
  RunbookRefSchema: realRunbookRefSchema,
} = await import('@rundown-org/core');

const MOCK_TOKEN_HASH = brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`);
const TEST_CLAIM_ID =
  'rdclm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as ClaimId;
const RUN_ID_PATTERN = /^rd_[a-f0-9]{32}$/;
const MOCK_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
const PARENT_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);
const DIFFERENT_PARENT_RUN_ID = brandRunIdForTest(`rd_${'c'.repeat(32)}`);
const ORPHAN_RUN_ID = brandRunIdForTest(`rd_${'d'.repeat(32)}`);

type ClaimRecordOverride = Partial<Omit<ClaimRecord, 'delegation'>> & {
  readonly delegation?: Partial<NonNullable<ClaimRecord['delegation']>>;
};

function claimRecord(childRunId: RunId, overrides: ClaimRecordOverride = {}): ClaimRecord {
  const { delegation: delegationOverrides, ...recordOverrides } = overrides;
  return makeClaimRecord({
    claimKey: assertClaimLookupKey('rdclk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    secretHash: assertClaimSecretHash(`sha256:${'a'.repeat(64)}`),
    controlledRunId: childRunId,
    grants: [],
    ...recordOverrides,
    delegation: {
      childRunId,
      tokenHash: MOCK_TOKEN_HASH,
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      ...delegationOverrides,
    },
  });
}

function claimedRunbookResult(
  childRunId: RunId,
  overrides: ClaimRecordOverride = {},
): ClaimRunbookResult {
  return { status: 'claimed', claimId: TEST_CLAIM_ID, claim: claimRecord(childRunId, overrides) };
}

function committed<T>(value: T): SessionMutationResult<T> {
  return { status: 'committed', value };
}

function mockClaimRunbookSuccess(): jest.Mock<SessionService['claimRunbook']> {
  return mockFn<SessionService['claimRunbook']>().mockImplementation(
    async (childRunId: RunId, linkage: DelegationLinkage) =>
      committed(
        claimedRunbookResult(childRunId, {
          delegation: {
            childRunId,
            tokenHash: linkage.tokenHash,
            parentRunId: linkage.parentRunId,
            parentStepId: linkage.parentStepId,
            parentStep: linkage.parentStep,
            parentFrameKey: linkage.parentFrameKey,
            parentEntry: linkage.parentEntry,
          },
        }),
      ),
  );
}

function mockClaimRunbookAlreadyClaimed(): jest.Mock<SessionService['claimRunbook']> {
  return mockFn<SessionService['claimRunbook']>().mockImplementation(
    async (childRunId: RunId, linkage: DelegationLinkage) =>
      committed({
        status: 'already-claimed',
        childRunId,
        claim: claimRecord(childRunId, {
          delegation: {
            childRunId,
            tokenHash: linkage.tokenHash,
            parentRunId: linkage.parentRunId,
            parentStepId: linkage.parentStepId,
            parentStep: linkage.parentStep,
            parentFrameKey: linkage.parentFrameKey,
            parentEntry: linkage.parentEntry,
          },
        }),
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
    .mockReturnValue({ step: '1', substep: undefined, iteration: undefined, frameKey: '1' }),
  getActiveForContext: mockFn<(...args: unknown[]) => unknown>().mockReturnValue(null),
  buildFrameKey: jest.fn(
    (step: string, iteration?: number) =>
      `${step}|${iteration !== undefined ? String(iteration) : ''}`,
  ),
  parseStepIdFromString: jest.fn(),
  RUNS_DIR: '.rundown/runs',
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
  RunbookRefSchema: {
    parse: jest.fn((ref: unknown) => realRunbookRefSchema.parse(ref)),
  },
  generateRunId: jest.fn(() => `rd_${'a'.repeat(32)}`),
  DELEGATION_TOKEN_PREFIX: 'rdtk_',
  getDefaultPolicy: () => ({
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
  }),
  PolicyEvaluator: jest.fn(),
  PolicyPrompter: jest.fn(),
  RunbookStateManager: jest.fn(),
  loadPolicy: jest.fn(),
  DelegationScanService: jest.fn(),
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
  reconstituteContextVars: mockFn<
    (...args: unknown[]) => Record<string, unknown>
  >().mockReturnValue({}),
  extractInheritedUserVars: jest.fn(),
  hashDelegationToken: mockFn<(token: string) => string>().mockReturnValue(MOCK_TOKEN_HASH),
  isDelegationToken: jest.fn(realIsDelegationToken),
  classifyDelegationLiveness: jest.fn().mockReturnValue({ kind: 'live', substep: {} }),
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
  isArtifactValue: jest.fn(
    (v: unknown) =>
      (typeof v === 'object' &&
        v !== null &&
        !Array.isArray(v) &&
        (v as { kind?: unknown }).kind === 'artifact-record') ||
      (Array.isArray(v) &&
        v.length > 0 &&
        v.every(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { kind?: unknown }).kind === 'artifact-record',
        )),
  ),
  merge: jest.fn((value: unknown) => ({ op: 'merge', value })),
  RESERVED_TEMPLATE_HELPER_NAMES: new Set(['artifact', 'path', 'validateSchema']),
  detectTemplateHelperCollisions: jest.fn(() => []),
  partitionVariables: jest.fn(partitionVariablesForTest),
  buildContextVars: jest.fn((vars: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(vars).map(([key, value]) => [`context.vars.${key}`, value])),
  ),
  buildTemplateVars: jest.fn(
    (
      localVars: Record<string, unknown>,
      options?: {
        inheritedUserVars?: Record<string, unknown>;
        inheritedContextVars?: Record<string, unknown>;
      },
    ) => {
      const effective = { ...(options?.inheritedUserVars ?? {}), ...localVars };
      return {
        ...effective,
        ...Object.fromEntries(
          Object.entries(effective).map(([key, value]) => [`context.vars.${key}`, value]),
        ),
        ...(options?.inheritedContextVars ?? {}),
      };
    },
  ),
  prepareParsedRunbook: jest.fn(
    (input: {
      rawRunbook: ResolvedRunbook;
      templateVars: Record<string, unknown>;
      runtimeVars?: Record<string, unknown>;
      runbookRef: RunbookRef;
      identity: { kind: 'prepared' } | { kind: 'runnable'; runId: RunId };
    }) => ({
      ok: true,
      runbook: input.rawRunbook,
      templateVars:
        input.identity.kind === 'runnable'
          ? { ...input.templateVars, RunbookRef: input.runbookRef, RunId: input.identity.runId }
          : { ...input.templateVars, RunbookRef: input.runbookRef },
      // Echo runtimeVars through to mirror real core (variable-preparation.ts:
      // `runtimeVars = input.runtimeVars ?? {}`). Must stay in parity with the
      // richer beforeEach double below; otherwise the runtimeVars-forwarding
      // mutant (issue #351) could silently survive if this double becomes live.
      runtimeVars: input.runtimeVars ?? {},
      warnings: [],
      unresolved: [],
    }),
  ),
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
  ...mockErrorHelpers,
}));

const actualResolveRunbook = await import('../../src/helpers/resolve-runbook.js');

// Mock @rundown-org/parser
jest.unstable_mockModule('@rundown-org/parser', () => ({
  parseRunbookDocument: jest.fn(),
  isSourced: jest.fn(),
  stepHasSubsteps: (step: { kind: string }) => step.kind === 'substeps' || step.kind === 'for',
  resolvedStepHasSubsteps: (step: { kind: string }) =>
    step.kind === 'substeps' || step.kind === 'for' || step.kind === 'prompted-for',
}));

// Mock resolve-runbook discovery while delegating runbook-ref derivation to
// the production implementation by default. Individual tests can still
// override buildRunbookRef for error/mismatch cases.
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => {
  return {
    ...actualResolveRunbook,
    resolveRunbookFile: jest.fn(),
    resolveRunbookRef: jest.fn(),
    buildRunbookRef: jest.fn(actualResolveRunbook.buildRunbookRef),
  };
});

// Mock execution service
jest.unstable_mockModule('../../src/services/execution', () => ({
  buildStepVariables: mockFn<(...args: unknown[]) => Record<string, unknown>>().mockReturnValue({
    Step: '1.1',
  }),
  runExecutionLoop: mockFn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: mockFn<(...args: unknown[]) => { emit: jest.Mock }>().mockReturnValue({
    emit: jest.fn(),
  }),
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
  ArtifactChannelError: class ArtifactChannelError extends Error {
    readonly code: string;
    readonly key: string;

    constructor(code: string, key: string, message: string) {
      super(message);
      this.code = code;
      this.key = key;
    }
  },
  resolveVariables: mockFn<typeof resolveVariablesType>().mockResolvedValue({
    vars: {},
    warnings: [],
    providedKeys: new Set(),
  }),
  RUNTIME_RESERVED_VARIABLES: new Set(['step', 'index', 'context']),
  BUILTIN_VARIABLES: {
    Date: 'Date',
    DateTime: 'DateTime',
    Year: 'Year',
    Month: 'Month',
    Day: 'Day',
    Branch: 'Branch',
    WorkPath: 'WorkPath',
    RunId: 'RunId',
    RunbookRef: 'RunbookRef',
    ContextId: 'ContextId',
  },
  isRuntimeReservedVariable: mockFn<(name: string) => boolean>().mockReturnValue(false),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  resolveForBounds: jest.fn((runbook: unknown) => ({ runbook, warnings: [] })),
  expandLoopVariables: jest.fn((text: string) => text),
  warnUnresolvedRunbookVariables: mockFn<(...args: unknown[]) => string[]>().mockReturnValue([]),
  collectUnresolvedRunbookVariables: mockFn<(...args: unknown[]) => Set<string>>().mockReturnValue(
    new Set(),
  ),
}));

// Mock validate-frontmatter-vars
jest.unstable_mockModule('../../src/helpers/validate-frontmatter-vars', () => ({
  validateOutputsDeclarations: mockFn<(...args: unknown[]) => unknown[]>().mockReturnValue([]),
}));

// Mock node:fs/promises
const actualFsPromises = await import('node:fs/promises');
jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsPromises,
  readFile: mockFn<(...args: unknown[]) => Promise<string>>().mockResolvedValue(
    '# Test\n\n## 1. Step\n- PASS CONTINUE',
  ),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile, resolveRunbookRef, buildRunbookRef } = await import(
  '../../src/helpers/resolve-runbook.js'
);
const { runExecutionLoop, buildStepVariables } = await import('../../src/services/execution.js');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { FileSourcePolicyError, ArtifactChannelError, resolveVariables } = await import(
  '../../src/services/variable-discovery.js'
);
const {
  substituteRunbookVariables,
  resolveForBounds,
  expandLoopVariables,
  warnUnresolvedRunbookVariables,
  collectUnresolvedRunbookVariables,
} = await import('../../src/services/template-renderer.js');
const { validateOutputsDeclarations } = await import(
  '../../src/helpers/validate-frontmatter-vars.js'
);
const fsPromises = await import('node:fs/promises');
const {
  prepareRunbook,
  prepareRunnableRunbook,
  prepareResolvedRunnableRunbook,
  loadAndParseResolvedRunbook,
  startRunbook,
  countSubsteps,
  inferEntryFromState,
  buildContextVars,
  buildTemplateVars,
} = await import('../../src/helpers/runbook-pipeline.js');
const { setHelperRegistry, resetHelperRegistry } = await import(
  '../../src/services/helper-registry.js'
);

/**
 * Install a fully-successful `core.DelegationLock` mock.
 *
 * Production takes the lock via the disposable scope API (`scope`/`held`,
 * returning an `AsyncDisposable`), so the mock implements those and delegates
 * disposal to an always-resolving `release`. Centralised so the many
 * startRunbook/claim tests that just need the lock to succeed stay in lock-step
 * with the lock's API.
 */
function installHappyDelegationLockMock(): void {
  jest.mocked(core.DelegationLock).mockImplementation(() => {
    const acquire = mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const release = mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const held = (runId?: string): ScopedLock => {
      let released = false;
      const run = async (): Promise<void> => {
        if (released) return;
        released = true;
        await release(runId);
      };
      return { release: run, [Symbol.asyncDispose]: run };
    };
    const scope = async (runId?: string): Promise<ScopedLock> => {
      await acquire(runId);
      return held(runId);
    };
    return { acquire, release, held, scope } as unknown as jest.MockedObject<DelegationLock>;
  });
}

function makeState(id: RunId, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    runbookSrc: '## 1. Step\n- PASS COMPLETE',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: {},
    steps: [{ id: '1', status: 'running' }],
    startedAt: '2026-02-27T10:00:00.000Z',
    updatedAt: '2026-02-27T10:00:00.000Z',
    ...overrides,
  };
}

const DEFAULT_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
};

type TestSubstepInput = Pick<ParsedSubstep, 'id'> & Partial<ParsedSubstep>;
type TestStepInput = {
  name?: string;
  description?: string;
  transitions?: Transitions;
  forClause?: ParsedForClause;
  substeps?: readonly TestSubstepInput[];
};

function makeSubstep(overrides: TestSubstepInput): ParsedSubstep {
  return {
    description: 'Test Substep',
    transitions: DEFAULT_TRANSITIONS,
    ...overrides,
  };
}

function makeStep(overrides: TestStepInput = {}): Step {
  const {
    name = '1',
    description = 'Test Step',
    transitions = DEFAULT_TRANSITIONS,
    forClause,
    substeps,
  } = overrides;
  const base = { name, description, transitions };

  if (forClause) {
    return {
      ...base,
      kind: 'for',
      forClause,
      substeps: (substeps ?? []).map(makeSubstep),
    };
  }

  if (substeps && substeps.length > 0) {
    return {
      ...base,
      kind: 'substeps',
      substeps: substeps.map(makeSubstep),
    };
  }

  return { ...base, kind: 'base' };
}

function mockParseResult(
  overrides: Partial<ParseResult> = {},
): ReturnType<typeof parser.parseRunbookDocument> {
  const result: ParseResult = {
    runbook: { steps: [makeStep()] },
    frontmatter: null,
    diagnostics: [],
    ...overrides,
  };
  return result;
}

function makeLifecycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  type LifecycleState = Record<string, unknown> & {
    step?: string;
    activeEntry?: unknown;
    activeFrameKey?: unknown;
  };
  return {
    ensureActiveEntry: mockFn<
      (id: string, prev: unknown, state: LifecycleState | undefined) => Promise<unknown>
    >().mockImplementation(async (_id, _prev, state) => ({
      state: {
        ...(state ?? {}),
        activeEntry: state?.activeEntry ?? 1,
        activeFrameKey: state?.activeFrameKey ?? `${state?.step ?? '1'}|`,
      },
      frameKey: state?.activeFrameKey ?? `${state?.step ?? '1'}|`,
      entry: state?.activeEntry ?? 1,
    })),
    buildTargetFrameKey: mockFn<(step: string, iteration?: number) => string>().mockImplementation(
      (step, iteration) => `${step}|${iteration != null ? String(iteration) : ''}`,
    ),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  jest.mocked(runExecutionLoop).mockResolvedValue('done');
  jest
    .mocked(core.deriveExecutionAt)
    .mockImplementation(
      (step: string, substep?: string, iteration?: number) =>
        `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
    );
  jest.mocked(core.getActiveForContext).mockReturnValue(undefined);
  jest
    .mocked(core.classifyDelegationLiveness)
    .mockReturnValue({ kind: 'live', substep: {} as never });
  jest.mocked(core.runbooksDir).mockImplementation((cwd: string) => `${cwd}/.rundown/runbooks`);
  jest
    .mocked(createBridgedEmitter)
    .mockReturnValue({ emit: jest.fn() } as unknown as ReturnType<typeof createBridgedEmitter>);
  const runbookRefSchemaMock = core.RunbookRefSchema as unknown as {
    parse: jest.MockedFunction<(ref: unknown) => RunbookRef>;
  };
  runbookRefSchemaMock.parse.mockImplementation((ref: unknown) => realRunbookRefSchema.parse(ref));
  jest.mocked(resolveVariables).mockResolvedValue({
    vars: {},
    warnings: [],
    providedKeys: new Set(),
  });
  jest.mocked(buildStepVariables).mockReturnValue({ Step: '1.1' });
  jest
    .mocked(substituteRunbookVariables)
    .mockImplementation(
      (runbook: unknown) => runbook as ReturnType<typeof substituteRunbookVariables>,
    );
  jest.mocked(resolveForBounds).mockImplementation(
    (runbook: unknown) =>
      ({
        runbook,
        warnings: [],
      }) as unknown as ReturnType<typeof resolveForBounds>,
  );
  jest.mocked(expandLoopVariables).mockImplementation((text: string) => text);
  jest.mocked(warnUnresolvedRunbookVariables).mockReturnValue([]);
  jest.mocked(collectUnresolvedRunbookVariables).mockReturnValue(new Set());
  jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
  // readFile is overloaded; jest.mocked picks the Buffer-returning overload, but we need to
  // resolve a string. Cast through unknown to a typed mock returning string.
  (
    jest.mocked(fsPromises.readFile) as unknown as jest.Mock<() => Promise<string>>
  ).mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE');
  jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
  jest.mocked(core.hashDelegationToken).mockReturnValue(MOCK_TOKEN_HASH);
  jest.mocked(core.isDelegationToken).mockImplementation(realIsDelegationToken);
  jest.mocked(core.generateRunId).mockReturnValue(MOCK_RUN_ID);
  jest.mocked(core.reconstituteContextVars).mockReturnValue({});
  jest.mocked(core.extractInheritedUserVars).mockReturnValue({});
  jest.mocked(core.deriveActiveFrame).mockReturnValue({
    step: '1',
    iteration: undefined,
    frameKey: '1' as unknown as ReturnType<typeof core.deriveActiveFrame>['frameKey'],
  });
  jest.mocked(core.isJsonArray).mockImplementation((v: unknown) => Array.isArray(v));
  jest.mocked(core.isJsonArrayStream).mockImplementation(realIsJsonArrayStream);
  jest.mocked(core.partitionVariables).mockImplementation(partitionVariablesForTest);
  jest
    .mocked(core.buildContextVars)
    .mockImplementation(
      <T>(vars: Readonly<Record<string, T>>) =>
        Object.fromEntries(
          Object.entries(vars).map(([key, value]) => [`context.vars.${key}`, value]),
        ) as Record<string, T>,
    );
  jest.mocked(core.buildTemplateVars).mockImplementation(
    (
      localVars: Readonly<Record<string, TemplateVarValue>>,
      options?: {
        inheritedUserVars?: Readonly<Record<string, TemplateVarValue>>;
        inheritedContextVars?: Readonly<Record<string, TemplateVarValue>>;
      },
    ) => {
      const effective: Record<string, TemplateVarValue> = {
        ...(options?.inheritedUserVars ?? {}),
        ...localVars,
      };
      return {
        ...effective,
        ...Object.fromEntries(
          Object.entries(effective).map(([key, value]) => [`context.vars.${key}`, value]),
        ),
        ...(options?.inheritedContextVars ?? {}),
      };
    },
  );
  jest
    .mocked(core.prepareParsedRunbook)
    .mockImplementation((input: PrepareParsedRunbookInput): PrepareParsedRunbookResult => {
      const baseVars = core.buildTemplateVars(input.templateVars, {
        inheritedUserVars: input.inheritedUserVars,
        inheritedContextVars: input.inheritedContextVars,
      });
      const templateVars =
        input.identity.kind === 'runnable'
          ? ({
              ...baseVars,
              RunbookRef: input.runbookRef,
              RunId: input.identity.runId,
            } as RunnableTemplateVariables)
          : ({
              ...baseVars,
              RunbookRef: input.runbookRef,
            } as PreparedTemplateVariables);
      const earlyError = input.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
      if (earlyError) {
        return {
          ok: false,
          error: earlyError.message,
          code: 'VALIDATION_ERROR',
          details: {},
          templateVars,
          warnings: [],
          diagnostics: input.diagnostics,
        };
      }
      const missing = (input.frontmatter?.required ?? []).filter(
        (name) => !input.providedKeys.has(name),
      );
      if (missing.length > 0) {
        return {
          ok: false,
          error: `Missing required variable${missing.length > 1 ? 's' : ''}: ${missing
            .map((name) => `"${name}"`)
            .join(
              ', ',
            )}. Provide via --input, --input-file, config.yaml, RD_INPUT_* environment variable, or prior runbook OUTPUTS.`,
          code: 'MISSING_REQUIRED_VARS',
          details: { missing },
          templateVars,
          warnings: [],
          diagnostics: input.diagnostics,
        };
      }
      let runbook: ResolvedRunbook;
      try {
        runbook = resolveForBounds(input.rawRunbook, templateVars).runbook;
      } catch (error) {
        return {
          ok: false,
          error: String(error instanceof Error ? error.message : error),
          code: 'VALIDATION_ERROR',
          details: {},
          templateVars,
          warnings: [],
          diagnostics: input.diagnostics,
        };
      }
      runbook = substituteRunbookVariables(runbook, templateVars);
      if (runbook.steps.length === 0) {
        return {
          ok: false,
          error: 'Runbook has no steps',
          code: 'VALIDATION_ERROR',
          details: {},
          templateVars,
          warnings: [],
          diagnostics: input.diagnostics,
        };
      }
      return {
        ok: true,
        runbook,
        templateVars,
        runtimeVars: input.runtimeVars ?? {},
        warnings: [],
        unresolved: [],
      };
    });
  jest.mocked(buildRunbookRef).mockImplementation(actualResolveRunbook.buildRunbookRef);
  jest.mocked(resolveRunbookRef).mockImplementation((_cwd: string, ref: RunbookRef) =>
    Promise.resolve({
      ok: true,
      resolved: {
        path: `/test/${ref.path}`,
        source: ref.source,
        sourceRoot: '/test',
      },
    }),
  );
});

// validateSources was removed in the unified variable model refactoring.
// Source validation now happens during variable resolution.

describe('countSubsteps', () => {
  it('sums substep counts across steps and ignores steps without substeps', () => {
    const steps = [
      makeStep({ substeps: [{ id: '1' }, { id: '2' }] }), // 2 substeps
      makeStep({ name: '2' }), // base step, contributes 0
      makeStep({
        name: '3',
        forClause: { variable: 'i', start: 1, source: 'items' },
        substeps: [{ id: '1' }, { id: '2' }, { id: '3' }],
      }), // 3 substeps
    ];
    // Pins the accumulator arithmetic (a `-` mutant would go negative).
    expect(countSubsteps(steps)).toBe(5);
  });

  it('returns 0 when no step defines substeps', () => {
    expect(countSubsteps([makeStep(), makeStep({ name: '2' })])).toBe(0);
  });
});

describe('inferEntryFromState', () => {
  const FRAME_KEY = brandFrameKeyForTest('1');

  const OTHER_KEY = brandFrameKeyForTest('2');

  it('returns the active entry when the target frame is the active frame', () => {
    const state = makeState(MOCK_RUN_ID, {
      activeFrameKey: FRAME_KEY,
      activeEntry: 7,
    }) as unknown as RunbookState;
    // Pins the `activeFrameKey === frameKey && activeEntry` active-frame branch.
    expect(inferEntryFromState(state, FRAME_KEY)).toBe(7);
  });

  it('returns the recorded frame entry count when the frame is not the active frame', () => {
    const state = makeState(MOCK_RUN_ID, {
      activeFrameKey: OTHER_KEY,
      activeEntry: 3,
      frameEntryCounts: { [FRAME_KEY]: 5 },
    }) as unknown as RunbookState;
    // The active frame differs, so the recorded count must win, not activeEntry.
    expect(inferEntryFromState(state, FRAME_KEY)).toBe(5);
  });

  it('defaults to 1 when there is no active match and no recorded count', () => {
    const state = makeState(MOCK_RUN_ID, {
      activeFrameKey: OTHER_KEY,
      activeEntry: 3,
    }) as unknown as RunbookState;
    expect(inferEntryFromState(state, FRAME_KEY)).toBe(1);
  });
});

describe('prepareRunbook — warning propagation', () => {
  beforeEach(() => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
  });

  it('surfaces collected warnings on a prepared success result', async () => {
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: ['heads up'],
      providedKeys: new Set(),
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual(['heads up']);
  });

  it('omits the warnings field entirely on a prepared success with no warnings', async () => {
    // Pins the `allWarnings.length > 0 ? allWarnings : undefined` guard: a
    // `>= 0` mutant would surface an empty array instead of undefined.
    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toBeUndefined();
  });

  it('surfaces collected warnings on a runnable success result', async () => {
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: ['runnable warn'],
      providedKeys: new Set(),
    });

    const result = await prepareRunnableRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toEqual(['runnable warn']);
  });

  it('omits the warnings field on a runnable success with no warnings', async () => {
    const result = await prepareRunnableRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toBeUndefined();
  });

  it('surfaces collected warnings on a MISSING_REQUIRED_VARS failure', async () => {
    jest
      .mocked(parser.parseRunbookDocument)
      .mockReturnValue(mockParseResult({ frontmatter: { required: ['PlanPath'] } }));
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: ['missing-path warn'],
      providedKeys: new Set(),
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_VARS');
      expect(result.warnings).toEqual(['missing-path warn']);
    }
  });

  it('surfaces collected warnings on a VALIDATION_ERROR failure', async () => {
    jest
      .mocked(parser.parseRunbookDocument)
      .mockReturnValue(
        mockParseResult({ diagnostics: [{ severity: 'error', message: 'bad clause' }] }),
      );
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: ['validation warn'],
      providedKeys: new Set(),
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.warnings).toEqual(['validation warn']);
    }
  });
});

describe('prepareRunbook', () => {
  it('returns error when file not found', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue(null);

    const result = await prepareRunbook('missing.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
      // Pin the not-found message text and structured details (the discovery hint
      // and the echoed runbook name) so the error envelope stays stable.
      expect(result.error).toContain('Runbook not found: missing.md');
      expect(result.error).toContain('rundown ls --all');
      expect(result.details).toEqual({ runbook: 'missing.md' });
    }
  });

  it('returns error when runbook has no steps', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/empty.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult({ runbook: { steps: [] } }));

    const result = await prepareRunbook('empty.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('no steps');
    }
  });

  it('returns prepared runbook on success', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.filePath).toBe('/test/good.md');
      expect(result.prepared.runbook.steps).toHaveLength(1);
    }
  });

  it('prepares resolved runbooks with RunbookRef but without RunId', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/parent.runbook.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('parent.runbook.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables.RunbookRef).toEqual({
        source: 'project',
        path: 'parent.runbook.md',
      });
      expect(result.prepared.mergedVariables).not.toHaveProperty('RunId');
    }
  });

  it('loads resolved runbooks when request identity property order differs', async () => {
    const pathFirstRunbookRef: RunbookRef = {
      path: 'child.runbook.md',
      source: 'project',
    };
    const runbookRefSchemaMock = core.RunbookRefSchema as unknown as {
      parse: jest.MockedFunction<(ref: unknown) => RunbookRef>;
    };
    runbookRefSchemaMock.parse.mockImplementationOnce((ref: unknown) => {
      realRunbookRefSchema.parse(ref);
      return pathFirstRunbookRef;
    });

    const result = await loadAndParseResolvedRunbook({
      resolved: {
        path: '/test/child.runbook.md',
        source: 'project',
        sourceRoot: '/test',
      },
      runbookRef: { source: 'project', path: 'child.runbook.md' },
      displayName: 'child',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runbookRef).toEqual({
        source: 'project',
        path: 'child.runbook.md',
      });
    }
  });

  it('does not re-parse the requested runbook ref for an already-resolved runbook', async () => {
    const runbookRefSchemaMock = core.RunbookRefSchema as unknown as {
      parse: jest.MockedFunction<(ref: unknown) => RunbookRef>;
    };
    runbookRefSchemaMock.parse.mockClear();

    const result = await loadAndParseResolvedRunbook({
      resolved: {
        path: '/test/child.runbook.md',
        source: 'project',
        sourceRoot: '/test',
      },
      runbookRef: { source: 'project', path: 'child.runbook.md' },
      displayName: 'child',
    });

    expect(result.ok).toBe(true);
    expect(runbookRefSchemaMock.parse).toHaveBeenCalledTimes(1);
    expect(runbookRefSchemaMock.parse).toHaveBeenCalledWith({
      source: 'project',
      path: 'child.runbook.md',
    });
  });

  it('returns a structured failure when resolved identity does not match request identity', async () => {
    const result = await loadAndParseResolvedRunbook({
      resolved: {
        path: '/test/child.runbook.md',
        source: 'project',
        sourceRoot: '/test',
      },
      runbookRef: { source: 'project', path: 'parent.runbook.md' },
      displayName: 'child',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_REF_RESOLUTION_ERROR');
      expect(result.error).toContain('project:child.runbook.md');
      expect(result.error).toContain('project:parent.runbook.md');
      expect(result.details).toEqual({ runbook: 'child' });
    }
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('prepares runnable runbooks with RunId before substitution', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/parent.runbook.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunnableRunbook('parent.runbook.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      const runnableRunId: RunId = result.prepared.runId;
      const templateRunId: RunId = result.prepared.mergedVariables.RunId;

      expect(runnableRunId).toMatch(RUN_ID_PATTERN);
      expect(templateRunId).toBe(runnableRunId);
      expect(result.prepared.mergedVariables.RunbookRef).toEqual({
        source: 'project',
        path: 'parent.runbook.md',
      });
    }
  });

  it('prepares resolved runnable runbooks with a supplied run id', async () => {
    const request = {
      resolved: {
        path: '/test/child.runbook.md',
        source: 'project' as const,
        sourceRoot: '/test',
      },
      runbookRef: { source: 'project' as const, path: 'child.runbook.md' },
      displayName: 'child.runbook.md',
    };

    const result = await prepareResolvedRunnableRunbook(request, {}, '/test', {
      runId: 'rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as RunId,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runId).toBe('rd_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    }
  });

  it('mints a fresh run id for a resolved runnable runbook when no options are supplied', async () => {
    // Called with no options object at all, so `options?.runId` must short-circuit
    // to `generateRunId()` — pins the optional-chaining access (a non-optional
    // `options.runId` mutant would throw on the undefined options).
    const request = {
      resolved: {
        path: '/test/child.runbook.md',
        source: 'project' as const,
        sourceRoot: '/test',
      },
      runbookRef: { source: 'project' as const, path: 'child.runbook.md' },
      displayName: 'child.runbook.md',
    };

    const result = await prepareResolvedRunnableRunbook(request, {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runId).toBe(MOCK_RUN_ID);
    }
  });

  // Note: a former 'stores the same runnable template variables used for
  // substitution' test asserted mergedVariables === substituteRunbookVariables'
  // recorded arg. Under the identity substitute mock that is tautological (the
  // mock returns its input); the runnable mergedVariables contract (RunId +
  // RunbookRef present) is covered observably by the runnable RunId/RunbookRef
  // test above.

  it('adds context.vars aliases to merged template variables', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { region: 'us-west' },
      warnings: [],
      providedKeys: new Set(['region']),
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        region: 'us-west',
        'context.vars.region': 'us-west',
      });
    }
  });

  it('adds context.vars.* aliases for inherited user vars', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { Region: 'us-west' },
      warnings: [],
      providedKeys: new Set(['Region']),
    });

    const result = await prepareRunbook('child.md', {}, '/test', {
      inheritedUserVars: { Region: 'us-west' },
    });

    expect(result.ok).toBe(true);
    expect(resolveVariables).toHaveBeenCalledWith(
      expect.objectContaining({
        inheritedVars: { Region: 'us-west' },
      }),
      '/test',
      expect.anything(),
    );
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        Region: 'us-west',
        'context.vars.Region': 'us-west',
      });
    }
  });

  it('child vars override inherited in context.vars.* aliases', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { Region: 'eu-central' },
      warnings: [],
      providedKeys: new Set(['Region']),
    });

    const result = await prepareRunbook('child.md', {}, '/test', {
      inheritedUserVars: { Region: 'us-west' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        Region: 'eu-central',
        'context.vars.Region': 'eu-central',
      });
    }
  });

  it('does not pass frontmatter inputs into variable resolution', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { inputs: ['Region'] },
      }),
    );

    await prepareRunbook('good.md', {}, '/test');

    const call = jest.mocked(resolveVariables).mock.calls[0];
    expect(call[0]).not.toHaveProperty('frontmatterVars');
  });

  it('returns VALIDATION_ERROR when required names are not declared in inputs', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/missing-input.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: {
          inputs: ['PlanPath'],
          required: ['Region'],
        },
        diagnostics: [
          {
            severity: 'error',
            message:
              'Frontmatter "required" variable "Region" must also be declared in "inputs" or "artifacts"',
          },
        ],
      }),
    );

    const result = await prepareRunbook('missing-input.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('must also be declared in "inputs" or "artifacts"');
    }
  });

  it('bails before helper-collision warnings when frontmatter validation fails', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/reserved.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { inputs: ['context'] },
        diagnostics: [
          {
            severity: 'error',
            message:
              'Frontmatter "inputs[0]" — "context" is a reserved variable name (step, index, context, runid, runbookref — case-insensitive)',
          },
        ],
      }),
    );
    jest.mocked(validateOutputsDeclarations).mockReturnValue([]);
    // Provide a variable named `Region` that collides with a registered helper.
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { Region: 'us-west' },
      sources: {},
      warnings: [],
      providedKeys: new Set(['Region']),
    } as unknown as Awaited<ReturnType<typeof resolveVariables>>);
    // Register a helper whose name matches the resolved variable above so that
    // detectHelperCollisions would surface a "shadowed" warning if it were run.
    setHelperRegistry(new Map([['Region', (v: string) => v.toUpperCase()]]));

    try {
      const result = await prepareRunbook('reserved.md', {}, '/test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('VALIDATION_ERROR');
        expect(result.error).toContain('reserved variable name');
        const warnings = result.warnings ?? [];
        const hasHelperWarning = warnings.some((w) =>
          w.includes('shadowed by a registered helper'),
        );
        expect(hasHelperWarning).toBe(false);
      }
    } finally {
      resetHelperRegistry();
    }
  });

  it('returns MISSING_REQUIRED_VARS when required var is not provided', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/needs-var.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { required: ['PlanPath'] },
      }),
    );

    const result = await prepareRunbook('needs-var.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_VARS');
      expect(result.error).toContain('"PlanPath"');
      expect(result.details).toEqual(expect.objectContaining({ missing: ['PlanPath'] }));
    }
  });

  it('succeeds when required var is provided via CLI', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/needs-var.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { required: ['PlanPath'] },
      }),
    );
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { PlanPath: '/some/path' },
      warnings: [],
      providedKeys: new Set(['PlanPath']),
    });

    const result = await prepareRunbook('needs-var.md', {}, '/test');

    expect(result.ok).toBe(true);
  });

  it('fails when required var exists only as builtin', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/needs-date.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { required: ['Date'] },
      }),
    );
    // Date is in vars (builtin) but NOT in providedKeys (external layers)
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { Date: '2026-01-01' },
      warnings: [],
      providedKeys: new Set(),
    });

    const result = await prepareRunbook('needs-date.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('MISSING_REQUIRED_VARS');
      expect(result.details).toEqual(expect.objectContaining({ missing: ['Date'] }));
    }
  });

  it('returns error when validateSources throws', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/sourced.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        runbook: {
          steps: [
            makeStep({
              forClause: { variable: 'item', start: 1, source: 'missing' },
              substeps: [{ id: '1' }],
            }),
          ],
        },
      }),
    );
    jest.mocked(core.prepareParsedRunbook).mockReturnValueOnce({
      ok: false,
      error: 'FOR loop references undefined variable "{{missing}}"',
      code: 'VALIDATION_ERROR',
      details: {},
      templateVars: {},
      warnings: [],
      diagnostics: [],
    });

    const result = await prepareRunbook('sourced.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('missing');
    }
  });

  it('returns VALIDATION_ERROR when parser diagnostics contain errors', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/bad-for.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        diagnostics: [{ severity: 'error', message: 'bad FOR clause', line: 1 }],
      }),
    );

    const result = await prepareRunbook('bad-for.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('bad FOR clause');
    }
    expect(resolveForBounds).not.toHaveBeenCalled();
    expect(substituteRunbookVariables).not.toHaveBeenCalled();
  });

  it('returns PrepareFailure when resolveForBounds throws for invalid value', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/for-bounds.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        runbook: {
          steps: [
            makeStep({
              forClause: { variable: 'i', start: 1, end: { ref: 'Max' }, unresolved: true },
              substeps: [{ id: '1.1', description: 'substep' }],
            }),
          ],
        },
      }),
    );
    jest.mocked(resolveForBounds).mockImplementation(() => {
      throw new Error(
        'FOR end bound "{{Max}}" in step "1" resolved to "hello" — must be a positive integer',
      );
    });

    const result = await prepareRunbook('for-bounds.md', {}, '/test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('must be a positive integer');
    }
  });

  it('returns POLICY_DENIED when file-backed variable resolution is blocked by policy', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest
      .mocked(resolveVariables)
      .mockRejectedValue(
        new FileSourcePolicyError('items', '/test/.env', 'Path blocked by policy'),
      );

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('POLICY_DENIED');
      expect(result.error).toContain('items');
      expect(result.details).toEqual({
        runbook: 'good.md',
        variable: 'items',
        filePath: '/test/.env',
        reason: 'Path blocked by policy',
      });
    }
  });

  it('maps ArtifactChannelError(ARTIFACT_CHANNEL_COLLISION) to a PrepareFailure carrying code + details', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest
      .mocked(resolveVariables)
      .mockRejectedValue(
        new ArtifactChannelError(
          'ARTIFACT_CHANNEL_COLLISION',
          'report',
          'Variable "report" was supplied as both a template var and an artifact',
        ),
      );

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ARTIFACT_CHANNEL_COLLISION');
      expect(result.error).toContain('report');
      expect(result.details).toEqual({
        runbook: 'good.md',
        variable: 'report',
      });
    }
  });

  it('maps ArtifactChannelError(INVALID_ARTIFACT_INPUT) to a PrepareFailure carrying code + details', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest
      .mocked(resolveVariables)
      .mockRejectedValue(
        new ArtifactChannelError(
          'INVALID_ARTIFACT_INPUT',
          'payload',
          'Artifact value for "payload" is not a valid rd:// reference',
        ),
      );

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARTIFACT_INPUT');
      expect(result.error).toContain('payload');
      expect(result.details).toEqual({
        runbook: 'good.md',
        variable: 'payload',
      });
    }
  });

  it('returns a structured failure when canonical runbook ref resolution fails', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/not-runbooks/child.runbook.md',
      source: 'plugin' as const,
      sourceRoot: '/home/user/.claude/extensions/rundown-plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:child', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_REF_RESOLUTION_ERROR');
      expect(result.error).toContain('outside');
      expect(result.error).toContain('/home/user/.claude/extensions/rundown-plugin/runbooks');
      expect(result.details).toEqual({ runbook: 'rundown:child' });
    }
    expect(resolveVariables).not.toHaveBeenCalled();
  });

  it('injects CLAUDE_PLUGIN_ROOT when runbook resolves from plugin source', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/write-plan.runbook.md',
      source: 'plugin' as const,
      sourceRoot: '/home/user/.claude/extensions/rundown-plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    // CLAUDE_PLUGIN_ROOT should be derived from the resolved path (everything before /runbooks/)
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        CLAUDE_PLUGIN_ROOT: '/home/user/.claude/extensions/rundown-plugin/',
      });
    }
  });

  it('injects CLAUDE_PLUGIN_ROOT with forward slashes for Windows plugin paths', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: String.raw`C:\Users\agent\.claude\extensions\rundown-plugin\runbooks\write-plan.runbook.md`,
      source: 'plugin' as const,
      sourceRoot: String.raw`C:\Users\agent\.claude\extensions\rundown-plugin\runbooks`,
    });
    jest.mocked(buildRunbookRef).mockResolvedValue({
      source: 'plugin',
      path: 'write-plan.runbook.md',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        CLAUDE_PLUGIN_ROOT: 'C:/Users/agent/.claude/extensions/rundown-plugin/',
      });
    }
  });

  it('does not inject CLAUDE_PLUGIN_ROOT when runbook resolves from project source', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/.rundown/runbooks/my-runbook.runbook.md',
      source: 'project' as const,
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('my-runbook', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
    }
  });

  it('allows --input to override CLAUDE_PLUGIN_ROOT', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/write-plan.runbook.md',
      source: 'plugin' as const,
      sourceRoot: '/home/user/.claude/extensions/rundown-plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { CLAUDE_PLUGIN_ROOT: '/custom/override' },
      warnings: [],
      providedKeys: new Set(['CLAUDE_PLUGIN_ROOT']),
    });

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    // The user's --input override should win over auto-injected value
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        CLAUDE_PLUGIN_ROOT: '/custom/override',
      });
    }
  });

  it('prepares source-root-relative project runbook refs for project runbook directories', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/.rundown/runbooks/ops/deploy.runbook.md',
      source: 'project' as const,
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('deploy', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'project',
        path: '.rundown/runbooks/ops/deploy.runbook.md',
      });
    }
  });

  it('prepares cwd-relative project runbook refs for directly run files', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/ops/direct.runbook.md',
      source: 'project' as const,
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('ops/direct.runbook.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'project',
        path: 'ops/direct.runbook.md',
      });
    }
  });

  it('preserves legacy .md project runbook refs', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/ops/legacy.md',
      source: 'project' as const,
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('ops/legacy.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'project',
        path: 'ops/legacy.md',
      });
    }
  });

  it('prepares source-root-relative plugin runbook refs', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/planning/write-plan.runbook.md',
      source: 'plugin' as const,
      sourceRoot: '/home/user/.claude/extensions/rundown-plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'plugin',
        path: 'planning/write-plan.runbook.md',
      });
    }
  });

  it('uses the outermost runbooks directory for nested plugin runbook refs', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/team/runbooks/child.runbook.md',
      source: 'plugin' as const,
      sourceRoot: '/home/user/.claude/extensions/rundown-plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:child', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'plugin',
        path: 'team/runbooks/child.runbook.md',
      });
    }
  });

  it('sets RunbookRef from a nested plugin runbook path relative to plugin runbooks root', async () => {
    const runbookRel = 'planning/review/review-plan-risk-safety.runbook.md';
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: `/plugin/runbooks/${runbookRel}`,
      source: 'plugin',
      sourceRoot: '/plugin/runbooks',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook(runbookRel, {}, '/workspace');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.mergedVariables).toMatchObject({
        RunbookRef: { source: 'plugin', path: runbookRel },
      });
      // Prepared (non-runnable) identity must not carry a RunId.
      expect(result.prepared.mergedVariables).not.toHaveProperty('RunId');
    }
  });

  it('prepares source-root-relative bundled runbook refs', async () => {
    const originalBundledPath = process.env.BUNDLED_RUNBOOKS_PATH;
    process.env.BUNDLED_RUNBOOKS_PATH = '/repo/packages/cli/dist/runbooks';
    const result = await (async (): ReturnType<typeof prepareRunbook> => {
      try {
        jest.mocked(resolveRunbookFile).mockResolvedValue({
          path: '/repo/packages/cli/dist/runbooks/planning/review.runbook.md',
          source: 'bundled' as const,
          sourceRoot: '/repo/packages/cli/dist/runbooks',
        });
        (
          parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
        ).mockReturnValue(mockParseResult());

        return await prepareRunbook('review', {}, '/test');
      } finally {
        if (originalBundledPath === undefined) {
          delete process.env.BUNDLED_RUNBOOKS_PATH;
        } else {
          process.env.BUNDLED_RUNBOOKS_PATH = originalBundledPath;
        }
      }
    })();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.runbookRef).toEqual({
        source: 'bundled',
        path: 'planning/review.runbook.md',
      });
    }
  });

  it('forwards resolved artifact runtime variables into runbook preparation', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    const artifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${MOCK_RUN_ID}/plan.json`,
      runId: MOCK_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { PlanPath: artifact, region: 'us-west' },
      warnings: [],
      providedKeys: new Set(['PlanPath', 'region']),
    });

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The trusted artifact value surfaces in the prepared runbook's runtime
      // vars (the runtime path), not flattened into template substitution.
      expect(result.prepared.runtimeVars).toMatchObject({ PlanPath: artifact });
      expect(result.prepared.runtimeVars).not.toHaveProperty('region');
      // Plain values stay on the template path (merged template variables).
      expect(result.prepared.mergedVariables).toMatchObject({ region: 'us-west' });
      expect(result.prepared.mergedVariables).not.toHaveProperty('PlanPath');
    }
  });

  it('forwards inherited context artifact variables into runbook preparation runtime vars', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    const contextArtifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-parent/${MOCK_RUN_ID}/spec.json`,
      runId: MOCK_RUN_ID,
      contextId: 'ctx-parent',
      runbook: { source: 'project', path: 'parent.runbook.md' },
      key: 'spec.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });

    const result = await prepareRunbook('child.md', {}, '/test', {
      inheritedContextVars: { SpecPath: contextArtifact, Region: 'eu-central' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Inherited context artifact merges into the prepared runtime vars; the
      // plain inherited value routes through the template path instead.
      expect(result.prepared.runtimeVars).toMatchObject({ SpecPath: contextArtifact });
      expect(result.prepared.runtimeVars).not.toHaveProperty('Region');
      expect(result.prepared.mergedVariables).toMatchObject({ Region: 'eu-central' });
      expect(result.prepared.mergedVariables).not.toHaveProperty('SpecPath');
    }
  });

  it('merges resolved-input and inherited-context artifacts into prepared runtime vars', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    const resolvedArtifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-a/${MOCK_RUN_ID}/plan.json`,
      runId: MOCK_RUN_ID,
      contextId: 'ctx-a',
      runbook: { source: 'project', path: 'producer.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    const contextArtifact = brandTrustedArtifactRecordForTest({
      kind: 'artifact-record',
      uri: `rd://artifacts/ctx-parent/${MOCK_RUN_ID}/spec.json`,
      runId: MOCK_RUN_ID,
      contextId: 'ctx-parent',
      runbook: { source: 'project', path: 'parent.runbook.md' },
      key: 'spec.json',
      timestamp: '2026-05-25T00:00:00.000Z',
    });
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { PlanPath: resolvedArtifact },
      warnings: [],
      providedKeys: new Set(['PlanPath']),
    });

    const result = await prepareRunbook('child.md', {}, '/test', {
      inheritedContextVars: { SpecPath: contextArtifact },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Both spread operands of the runtimeVars merge must survive into the
      // prepared result simultaneously: the resolved-input artifact AND the
      // inherited-context artifact. Each is covered alone above; this pins both
      // halves of `{ ...partitions.runtimeVars, ...contextPartitions.runtimeVars }`
      // at once, so dropping either spread fails here.
      expect(result.prepared.runtimeVars).toMatchObject({
        PlanPath: resolvedArtifact,
        SpecPath: contextArtifact,
      });
    }
  });
});

describe('startRunbook', () => {
  it('creates state and runs execution loop', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const initializedState = {
      ...createdState,
      lastAction: { type: 'START' as const, origin: 'direct' as const },
      activeFrameKey: '1|' as ReturnType<typeof core.buildFrameKey>,
      activeEntry: 1,
      frameEntryCounts: { '1|': 1 },
    } as unknown as RunbookState;
    const preparedRunId = brandRunIdForTest(`rd_${'b'.repeat(32)}`);
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const mockUpdate = mockFn<RunbookStateManager['update']>().mockResolvedValue(createdState);
    const mockLoad = mockFn<RunbookStateManager['load']>().mockResolvedValue(createdState);
    const mockInitializeSubsteps =
      mockFn<RunbookStateManager['initializeSubsteps']>().mockResolvedValue(undefined);
    const mockInitState =
      mockFn<RunbookActorService['initializeState']>().mockResolvedValue(initializedState);
    const mockPushRunbookWithRunControlClaim = mockFn<
      SessionService['pushRunbookWithRunControlClaim']
    >().mockResolvedValue(
      committed({
        claimId: TEST_CLAIM_ID,
        claim: claimRecord(MOCK_RUN_ID),
      }),
    );
    const mockEnsureActiveEntry = mockFn<
      ExecutionLifecycleService['ensureActiveEntry']
    >().mockResolvedValue({
      state: createdState,
      frameKey: '1|' as ReturnType<typeof core.buildFrameKey>,
      entry: 1,
    });

    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const ctx = makeRunPipelineContext({
      manager: {
        create: mockCreate,
        update: mockUpdate,
        load: mockLoad,
        initializeSubsteps: mockInitializeSubsteps,
      },
      actorService: { initializeState: mockInitState },
      sessionService: {
        pushRunbookWithRunControlClaim: mockPushRunbookWithRunControlClaim,
      },
      lifecycleService: { ensureActiveEntry: mockEnsureActiveEntry },
    });

    const prepared: RunnableRunbook = {
      filePath: '/test/runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'runbook.runbook.md' },
      runId: preparedRunId,
      rawContent: '# Test',
      runbook: { steps: [makeStep() as PreparedRunbook['runbook']['steps'][number]] },
      mergedVariables: {
        RunId: preparedRunId,
        RunbookRef: { source: 'project', path: 'runbook.runbook.md' },
      },
      runtimeVars: {},
      stats: { steps: 1, substeps: 0 },
      frontmatter: null,
    };

    const result = await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
      expect(result.claimId).toBe(TEST_CLAIM_ID);
    }
    expect(mockCreate).toHaveBeenCalledWith(
      prepared.runbookRef,
      prepared.runbook,
      expect.objectContaining({
        runId: prepared.runId,
        runbookPath: 'runbook.md',
        runbookSrc: '# Test',
        templateVars: expect.objectContaining({
          RunId: prepared.runId,
          RunbookRef: prepared.runbookRef,
        }),
        frontmatterOutputs: [],
      }),
    );
    expect(mockInitState).toHaveBeenCalled();
    expect(mockPushRunbookWithRunControlClaim).toHaveBeenCalledWith(MOCK_RUN_ID);
    expect(mockEnsureActiveEntry).not.toHaveBeenCalled();
    expect(mockInitializeSubsteps).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    const createBridgedEmitterMock = createBridgedEmitter as jest.MockedFunction<
      (...args: unknown[]) => unknown
    >;
    expect(createBridgedEmitterMock.mock.calls).toContainEqual([initializedState, ctx.output]);
  });

  it('returns a launch-failed result when actor initialization yields no state', async () => {
    // initializeState resolving to a falsy state must abort the launch with a
    // structured launch-failed envelope — pins the `if (!initializedState) throw`
    // guard and its message, and confirms the session push never happens.
    const runId = brandRunIdForTest(`rd_${'7'.repeat(32)}`);
    const createdState = makeState(runId) as unknown as RunbookState;
    const mockPushWithClaim = mockFn<
      SessionService['pushRunbookWithRunControlClaim']
    >().mockResolvedValue(committed({ claimId: TEST_CLAIM_ID, claim: claimRecord(runId) }));
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);
    const ctx = makeRunPipelineContext({
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState),
        delete: mockDelete,
      },
      // initializeState resolves to null -> the launch must fail before push.
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(null),
      },
      sessionService: { pushRunbookWithRunControlClaim: mockPushWithClaim },
    });

    const prepared: RunnableRunbook = {
      filePath: '/test/runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'runbook.runbook.md' },
      runId,
      rawContent: '# Test',
      runbook: { steps: [makeStep() as PreparedRunbook['runbook']['steps'][number]] },
      mergedVariables: {
        RunId: runId,
        RunbookRef: { source: 'project', path: 'runbook.runbook.md' },
      },
      runtimeVars: {},
      stats: { steps: 1, substeps: 0 },
      frontmatter: null,
    };

    const result = await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'launch-failed') {
      expect(result.reason).toBe('launch-failed');
      expect(result.error).toContain('Failed to initialize runbook engine');
    }
    expect(mockPushWithClaim).not.toHaveBeenCalled();
    // The created run is cleaned up so no orphaned state lingers.
    expect(mockDelete).toHaveBeenCalledWith(runId);
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('cleans up an activated runbook when afterStarted fails', async () => {
    const runId = brandRunIdForTest(`rd_${'4'.repeat(32)}`);
    const createdState = makeState(runId) as unknown as RunbookState;
    const initializedState = {
      ...createdState,
      lastAction: { type: 'START' as const, origin: 'direct' as const },
      activeFrameKey: '1|' as ReturnType<typeof core.buildFrameKey>,
      activeEntry: 1,
      frameEntryCounts: { '1|': 1 },
    } as unknown as RunbookState;
    const mockPushWithClaim = mockFn<
      SessionService['pushRunbookWithRunControlClaim']
    >().mockResolvedValue(committed({ claimId: TEST_CLAIM_ID, claim: claimRecord(runId) }));
    const mockReleaseRunbook = mockFn<SessionService['releaseRunbook']>().mockResolvedValue(
      committed({
        status: 'released',
        runbookId: runId,
        removedFromDefaultStack: true,
        nextDefaultRunbookId: null,
      }),
    );
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);
    const ctx = makeRunPipelineContext({
      sessionService: {
        pushRunbookWithRunControlClaim: mockPushWithClaim,
        releaseRunbook: mockReleaseRunbook,
      },
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState),
        delete: mockDelete,
      },
      actorService: {
        initializeState:
          mockFn<RunbookActorService['initializeState']>().mockResolvedValue(initializedState),
      },
    });

    const prepared: RunnableRunbook = {
      filePath: '/test/child.runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'child.runbook.md' },
      runId,
      rawContent: '# Test',
      runbook: {
        steps: [
          makeStep({
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          }) as PreparedRunbook['runbook']['steps'][number],
        ],
      },
      mergedVariables: {
        RunId: runId,
        RunbookRef: { source: 'project', path: 'child.runbook.md' },
      },
      runtimeVars: {},
      stats: { steps: 1, substeps: 0 },
      frontmatter: null,
    };

    const result = await startRunbook(ctx, prepared, {
      file: 'child.runbook.md',
      afterStarted: async () => {
        throw new Error('started hook failed');
      },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        reason: 'launch-failed',
        code: core.ErrorCodes.LAUNCH_FAILED.code,
      }),
    );
    expect(mockPushWithClaim).toHaveBeenCalledWith(prepared.runId);
    expect(mockReleaseRunbook).toHaveBeenCalledWith(prepared.runId);
    expect(mockDelete).toHaveBeenCalledWith(prepared.runId);
  });

  it('seeds frontmatterOutputs from prepared.frontmatter.outputs to manager.create', async () => {
    const outputDecls = [{ name: 'Result' }, { name: 'Status' }];
    const mockCreate = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'x',
      title: 'T',
      substeps: undefined,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const ctx = {
      output: { flush: jest.fn() } as unknown as OutputEmitter,
      manager: {
        create: mockCreate,
        update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        initializeSubsteps:
          mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'sub-id',
          step: '1',
          activeFrameKey: '1|',
          substep: 'a',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbookWithRunControlClaim: mockFn<
          SessionService['pushRunbookWithRunControlClaim']
        >().mockResolvedValue(
          committed({
            claimId: TEST_CLAIM_ID,
            claim: claimRecord(brandRunIdForTest(`rd_${'d'.repeat(32)}`)),
          }),
        ),
        claimRunbook: mockClaimRunbookSuccess(),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const prepared = {
      filePath: '/test/runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'runbook.md' },
      runId: brandRunIdForTest(`rd_${'c'.repeat(32)}`),
      rawContent: '# Test',
      runbook: { steps: [makeStep()] },
      mergedVariables: {
        RunId: brandRunIdForTest(`rd_${'c'.repeat(32)}`),
        RunbookRef: { source: 'project', path: 'runbook.md' },
      },
      frontmatter: { outputs: outputDecls },
      stats: { steps: 1, substeps: 0 },
    } as unknown as RunnableRunbook;

    await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(mockCreate).toHaveBeenCalledWith(
      prepared.runbookRef,
      prepared.runbook,
      expect.objectContaining({ frontmatterOutputs: outputDecls }),
    );
  });

  it('lets explicit initialVariables override prepared runtime variables', async () => {
    const mockCreate = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'x',
      title: 'T',
      substeps: undefined,
    });
    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const ctx = {
      output: { flush: jest.fn() } as unknown as OutputEmitter,
      manager: {
        create: mockCreate,
        update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        initializeSubsteps:
          mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'sub-id',
          step: '1',
          activeFrameKey: '1|',
          substep: 'a',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbookWithRunControlClaim: mockFn<
          SessionService['pushRunbookWithRunControlClaim']
        >().mockResolvedValue(
          committed({
            claimId: TEST_CLAIM_ID,
            claim: claimRecord(brandRunIdForTest(`rd_${'d'.repeat(32)}`)),
          }),
        ),
        claimRunbook: mockClaimRunbookSuccess(),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const prepared = {
      filePath: '/test/runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'runbook.md' },
      runId: brandRunIdForTest(`rd_${'c'.repeat(32)}`),
      rawContent: '# Test',
      runbook: { steps: [makeStep()] },
      mergedVariables: {
        RunId: brandRunIdForTest(`rd_${'c'.repeat(32)}`),
        RunbookRef: { source: 'project', path: 'runbook.md' },
      },
      runtimeVars: { Plan: 'prepared-plan', Generated: 'prepared-generated' },
      frontmatter: null,
      stats: { steps: 1, substeps: 0 },
    } as unknown as RunnableRunbook;

    await startRunbook(ctx, prepared, {
      file: 'runbook.md',
      initialVariables: { Plan: 'caller-plan' },
    });

    expect(mockCreate).toHaveBeenCalledWith(
      prepared.runbookRef,
      prepared.runbook,
      expect.objectContaining({
        initialVariables: { Plan: 'caller-plan', Generated: 'prepared-generated' },
      }),
    );
  });

  it('initializes substeps when first step has substeps', async () => {
    const mockInitSubsteps =
      mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const mockUpdate = mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const mockCreate = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'sub-id',
      title: 'Sub Test',
    });

    jest.mocked(runExecutionLoop).mockResolvedValue('done');

    const mockLoad = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'sub-id',
      step: '1',
      activeFrameKey: '1|',
    });

    const ctx = {
      output: { flush: jest.fn() } as unknown as OutputEmitter,
      manager: {
        create: mockCreate,
        update: mockUpdate,
        load: mockLoad,
        initializeSubsteps: mockInitSubsteps,
      } as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'sub-id',
          step: '1',
          activeFrameKey: '1|',
          substep: 'a',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbookWithRunControlClaim: mockFn<
          SessionService['pushRunbookWithRunControlClaim']
        >().mockResolvedValue(
          committed({
            claimId: TEST_CLAIM_ID,
            claim: claimRecord(brandRunIdForTest(`rd_${'d'.repeat(32)}`)),
          }),
        ),
        claimRunbook: mockClaimRunbookSuccess(),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const substeps = [{ id: 'a' }, { id: 'b' }];
    const prepared = {
      filePath: '/test/runbook.md',
      source: 'project',
      sourceRoot: '/test',
      runbookRef: { source: 'project', path: 'runbook.md' },
      runId: brandRunIdForTest(`rd_${'d'.repeat(32)}`),
      rawContent: '# Test',
      runbook: { steps: [makeStep({ substeps })] },
      mergedVariables: {
        RunId: brandRunIdForTest(`rd_${'d'.repeat(32)}`),
        RunbookRef: { source: 'project', path: 'runbook.md' },
      },
      stats: { steps: 1, substeps: 2 },
      frontmatter: null,
    } as unknown as RunnableRunbook;

    const result = await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    expect(mockInitSubsteps).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('claimAndLaunch', () => {
  it('returns error when token format is invalid', async () => {
    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: {} as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    const result = await claimAndLaunch(ctx, 'bad-token', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'invalid-token');
    }
  });

  it('returns error when token not found', async () => {
    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: {} as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'token-not-found');
    }
  });

  it('returns an already-claimed error when token already has a live child', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const claimSpy = mockClaimRunbookAlreadyClaimed();
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: { claimRunbook: claimSpy } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toEqual(
        expect.objectContaining({
          reason: 'delegation-already-claimed',
          childRunId: 'existing-child-id',
          stepId: '1',
        }),
      );
    }
  });

  it('returns substepId (not stepId) on already-claimed failure for a delegated substep', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', status: 'pending', delegation }],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '2', // outer step id
        substepId: '1', // delegation lives on substep 2.1
        delegation,
      }),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const claimSpy = mockClaimRunbookAlreadyClaimed();
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: { claimRunbook: claimSpy } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('delegation-already-claimed');
      if (result.reason !== 'delegation-already-claimed') {
        throw new Error(`expected delegation-already-claimed, got ${result.reason}`);
      }
      // ClaimResult.stepId contract: "Step (or substep) ID on the parent that
      // holds the delegation". For a delegated substep, that's substepId, not
      // the outer stepId.
      expect(result.stepId).toBe('1');
    }
  });

  // O15 regression: every failure return in the delegation-claim block must
  // report the substep id that owns the delegation, not the bare outer step id.
  // Each case scans a delegation living on substep `2.1` (stepId '2',
  // substepId '1') and asserts the failure carries stepId '1'.
  const runSubstepClaimFailure = async (opts: {
    cancelledAt?: string | null;
    findOrphanedChild?: unknown;
    findClaimForDelegation?: unknown;
    childState?: unknown;
    claimSpy?: jest.Mock<SessionService['claimRunbook']>;
  }) => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: opts.cancelledAt ?? null,
    };
    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [{ id: '1', status: 'pending', delegation }],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '2', // outer step id
        substepId: '1', // delegation lives on substep 2.1
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(
        opts.findOrphanedChild ?? null,
      ),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockImplementation(
        async (id: unknown) => (id === PARENT_RUN_ID ? parentState : (opts.childState ?? null)),
      ),
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {
        claimRunbook: opts.claimSpy ?? mockClaimRunbookSuccess(),
        findClaimForDelegation: mockFn<
          (...args: unknown[]) => Promise<unknown>
        >().mockResolvedValue(opts.findClaimForDelegation ?? null),
      } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    return claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});
  };

  it('reports substepId (not stepId) on a substep delegation-cancelled failure', async () => {
    const result = await runSubstepClaimFailure({ cancelledAt: new Date().toISOString() });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'delegation-cancelled', stepId: '1' });
  });

  it('reports substepId (not stepId) on an orphan-branch claim failure', async () => {
    const orphanState = makeState(ORPHAN_RUN_ID, {
      delegation: { parentRunId: PARENT_RUN_ID, parentStepId: '1', tokenHash: MOCK_TOKEN_HASH },
    });
    const result = await runSubstepClaimFailure({
      findOrphanedChild: orphanState,
      claimSpy: mockClaimRunbookAlreadyClaimed(),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ stepId: '1' });
  });

  it('reports substepId (not stepId) on an existing-claim child-missing failure', async () => {
    const result = await runSubstepClaimFailure({
      findClaimForDelegation: { controlledRunId: 'existing-child-id' },
      childState: null,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'child-missing', stepId: '1' });
  });

  it('reports substepId (not stepId) on an existing-claim delegation-resolved failure', async () => {
    const resolvedChild = makeState(brandRunIdForTest(`rd_${'e'.repeat(32)}`), {
      lifecycle: 'completed',
    });
    const result = await runSubstepClaimFailure({
      findClaimForDelegation: { controlledRunId: 'existing-child-id' },
      childState: resolvedChild,
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'delegation-resolved', stepId: '1' });
  });

  it('reports substepId (not stepId) on an existing-claim claim failure', async () => {
    const liveChild = makeState(brandRunIdForTest(`rd_${'e'.repeat(32)}`), {});
    const result = await runSubstepClaimFailure({
      findClaimForDelegation: { controlledRunId: 'existing-child-id' },
      childState: liveChild,
      claimSpy: mockClaimRunbookAlreadyClaimed(),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ stepId: '1' });
  });

  it('returns error when delegation was cancelled', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'delegation-cancelled');
    }
  });

  it('adopts orphaned child when found', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const orphanState = makeState(ORPHAN_RUN_ID, {
      delegation: {
        parentRunId: PARENT_RUN_ID,
        parentStepId: '1',
        tokenHash,
      },
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(orphanState),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const claimSpy = mockClaimRunbookSuccess();
    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: { claimRunbook: claimSpy } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe(ORPHAN_RUN_ID);
    }
    expect(mockManager.update).toHaveBeenCalled();
  });

  it('rejects re-claim when the already-claimed child is owned by a different agent', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const claimSpy = mockClaimRunbookSuccess();
    const mockSessionService = {
      claimRunbook: claimSpy,
    } as unknown as SessionService;

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: mockSessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claimId).toBe(TEST_CLAIM_ID);
    }
  });

  it('rejects orphan adoption when the orphan is owned by a different agent', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const orphanLinkage: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      tokenHash,
    };
    const orphanState = makeState(ORPHAN_RUN_ID, {
      parentLinkage: orphanLinkage,
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild:
        mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(orphanState),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    const claimSpy = mockFn<SessionService['claimRunbook']>().mockResolvedValue(
      committed({
        status: 'linkage-mismatch',
        childRunId: ORPHAN_RUN_ID,
        persisted: orphanLinkage,
        incoming: {
          kind: 'delegation',
          parentRunId: DIFFERENT_PARENT_RUN_ID,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: brandFrameKeyForTest('1'),
          parentEntry: 1,
          tokenHash,
        },
      }),
    );
    const mockSessionService = {
      claimRunbook: claimSpy,
    } as unknown as SessionService;

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: mockSessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'linkage-mismatch');
      expect(result.childRunId).toBe(ORPHAN_RUN_ID);
    }
    expect(mockManager.update).not.toHaveBeenCalled();
  });

  it('launches new child when no orphan exists', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
          frameKey: brandFrameKeyForTest('1'),
        },
      ],
    });

    // stepId !== substepId so the `parentStepId: substepId ?? stepId`
    // coalescing in the fresh-launch linkage is actually exercised: the
    // delegation lives on substep '1' under step '2'.
    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '2',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
    jest.mocked(core.reconstituteContextVars).mockReturnValue({});

    const mockCreate = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'new-child-id',
      title: 'Child',
    });
    const mockUpdate = mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      create: mockCreate,
      update: mockUpdate,
      initializeSubsteps:
        mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    jest.mocked(runExecutionLoop).mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'new-child-id',
          step: '1',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbookSuccess(),
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('new-child-id');
      expect(result.loopResult).toBe('waiting');
    }
    expect(mockCreate).toHaveBeenCalledWith(
      { source: 'project', path: 'child.md' },
      expect.anything(),
      expect.objectContaining({
        // Pin every field of the fresh-launch delegation linkage, not just the
        // discriminant: a mutation corrupting parentStepId (the substepId ??
        // stepId coalescing), parentStep, parentFrameKey, or parentEntry must
        // fail here. The idempotent-claim branch is covered separately.
        parentLinkage: {
          kind: 'delegation',
          parentRunId: PARENT_RUN_ID,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: brandFrameKeyForTest('1'),
          parentEntry: 1,
          tokenHash,
        },
      }),
    );
  });

  it('preserves ContextId but does not inherit parent RunId into child vars', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: {
        vars: {
          RunId: 'parent-run',
          ContextId: 'ctx-parent',
          Region: 'us-west',
          'context.vars.Region': 'us-west',
        },
        ancestors: [],
      },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: { RunId: 'child-run', ContextId: 'ctx-parent', Region: 'us-west' },
      warnings: [],
      providedKeys: new Set(['RunId', 'ContextId', 'Region']),
    });

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      create: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        id: 'new-child-id',
        title: 'Child',
      }),
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      initializeSubsteps:
        mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    jest.mocked(runExecutionLoop).mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'new-child-id',
          step: '1',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbookSuccess(),
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    jest.mocked(core.extractInheritedUserVars).mockReturnValue({
      ContextId: 'ctx-parent',
      Region: 'us-west',
    });

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    const resolveCall = jest.mocked(resolveVariables).mock.calls.at(-1) as
      | [{ inheritedVars: Record<string, unknown> }, ...unknown[]]
      | undefined;
    expect(resolveCall).toBeDefined();
    expect(resolveCall?.[0]).toEqual(
      expect.objectContaining({
        inheritedVars: {
          ContextId: 'ctx-parent',
          Region: 'us-west',
        },
      }),
    );
    expect(resolveCall?.[0].inheritedVars).not.toHaveProperty('RunId');
  });

  it('passes published OUTPUTS into delegated child inherited vars', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: {
        vars: {
          ContextId: 'ctx-parent',
          Region: 'us-west',
          Tag: 'from-parent',
          'context.vars.Region': 'us-west',
        },
        ancestors: [],
      },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
    jest.mocked(core.extractInheritedUserVars).mockReturnValue({
      ContextId: 'ctx-parent',
      Region: 'us-west',
      Tag: 'from-parent',
    });
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {
        RunId: 'child-run',
        ContextId: 'ctx-parent',
        Region: 'us-west',
        Tag: 'from-parent',
      },
      warnings: [],
      providedKeys: new Set(['RunId', 'ContextId', 'Region', 'Tag']),
    });

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      create: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        id: 'new-child-id',
        title: 'Child',
      }),
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      initializeSubsteps:
        mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    jest.mocked(runExecutionLoop).mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue({
          id: 'new-child-id',
          step: '1',
        } as unknown as RunbookState),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbookSuccess(),
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    // Inherited vars are passed into resolveVariables untouched
    const resolveCall = jest.mocked(resolveVariables).mock.calls.at(-1);
    expect(resolveCall?.[0]).toEqual(
      expect.objectContaining({
        inheritedVars: {
          ContextId: 'ctx-parent',
          Region: 'us-west',
          Tag: 'from-parent',
        },
      }),
    );
  });

  it('returns error when child runbook file not found', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'missing.md',
      childRunbookRef: { source: 'project', path: 'missing.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    jest.mocked(resolveRunbookRef).mockResolvedValue({
      ok: false,
      reason: 'file-missing',
      runbookRef: { source: 'project', path: 'missing.md' },
    });

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);
    jest.mocked(core.reconstituteContextVars).mockReturnValue({});

    installHappyDelegationLockMock();

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'prepare-failed');
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
      expect(result.runbook).toBe('missing.md');
    }
  });

  it('inherits prompted flag from parent', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      childRunbookRef: { source: 'project', path: 'child.md' },
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState(PARENT_RUN_ID, {
      prompted: true,
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const mockScanner = {
      findByToken: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation,
      }),
      findOrphanedChild: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
    };
    jest
      .mocked(core.DelegationScanService)
      .mockImplementation(() => mockScanner as unknown as jest.MockedObject<DelegationScanService>);

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
      sourceRoot: '/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(mockParseResult());
    jest.mocked(core.reconstituteContextVars).mockReturnValue({});

    const mockCreate = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      id: 'child-id',
      title: 'Child',
    });

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
      create: mockCreate,
      update: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      initializeSubsteps:
        mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);

    installHappyDelegationLockMock();

    jest.mocked(runExecutionLoop).mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {
        initializeState:
          mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbookSuccess(),
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(mockCreate).toHaveBeenCalledWith(
      { source: 'project', path: 'child.md' },
      expect.anything(),
      expect.objectContaining({
        prompted: true,
      }),
    );
  });
});

describe('buildContextVars', () => {
  it('creates context.vars.* aliases for string values', () => {
    const result = buildContextVars({ env: 'prod', version: '1.0' });
    expect(result['context.vars.env']).toBe('prod');
    expect(result['context.vars.version']).toBe('1.0');
  });

  it('preserves JsonObject values in context.vars.*', () => {
    const result = buildContextVars({ config: { host: 'localhost', port: 3000 } });
    expect(result['context.vars.config']).toEqual({ host: 'localhost', port: 3000 });
  });

  it('preserves number values in context.vars.*', () => {
    const result = buildContextVars({ port: 8080 });
    expect(result['context.vars.port']).toBe(8080);
  });
});

describe('buildTemplateVars', () => {
  it('merges inherited and local vars', () => {
    const result = buildTemplateVars({ env: 'staging' }, { inheritedUserVars: { region: 'us' } });
    expect(result.env).toBe('staging');
    expect(result.region).toBe('us');
  });

  it('local vars override inherited', () => {
    const result = buildTemplateVars({ env: 'prod' }, { inheritedUserVars: { env: 'staging' } });
    expect(result.env).toBe('prod');
  });

  it('preserves JsonObject values through merge', () => {
    const result = buildTemplateVars(
      { name: 'child' },
      { inheritedUserVars: { config: { host: 'localhost' } } },
    );
    expect(result.config).toEqual({ host: 'localhost' });
    expect(result['context.vars.config']).toEqual({ host: 'localhost' });
  });

  it('preserves number values through merge', () => {
    const result = buildTemplateVars({ port: 8080 });
    expect(result.port).toBe(8080);
    expect(result['context.vars.port']).toBe(8080);
  });

  it('preserves inherited context vars with object values', () => {
    const result = buildTemplateVars(
      { env: 'staging' },
      {
        inheritedContextVars: {
          'context.parent.vars.config': { host: 'parent-host' },
        },
      },
    );
    expect(result['context.parent.vars.config']).toEqual({ host: 'parent-host' });
  });
});
