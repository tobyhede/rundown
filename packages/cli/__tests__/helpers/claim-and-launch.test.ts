import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  ClaimId,
  ClaimRecord,
  ClaimRunbookResult,
  DelegationLinkage,
  FrameKey,
  PrepareParsedRunbookInput,
  PrepareParsedRunbookResult,
  PreparedTemplateVariables,
  ReleaseRunbookResult,
  RunbookActorService,
  RunbookRef,
  RunId,
  RunbookStateManager,
  RunnableTemplateVariables,
  RunbookState,
  SessionService,
  TemplateVarValue,
  StepDelegation,
  TokenScanResult,
} from '@rundown-org/core';
import type { RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import type * as VariableDiscoveryModule from '../../src/services/variable-discovery.js';
import type { ResolvedRunbook } from '@rundown-org/parser';
import { assertClaimLookupKey, assertClaimSecretHash } from '@rundown-org/core';
import { makeClaimRecord } from '@rundown-org/core/testing/claim-fixtures';
import { makeDelegationCredentialDescriptor } from '@rundown-org/core/testing/delegation-fixtures';
import { assertVariant } from './assert-variant.js';
import {
  brandDelegationTokenHashForTest,
  brandFrameKeyForTest,
  brandRunIdForTest,
} from './brand-helpers.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import {
  isArtifactValueShapeForTest,
  partitionVariablesForTest,
} from './mock-partition-variables.js';
import { mockFn } from './typed-mocks.js';
import { committed } from './session-mutation-fixtures.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const {
  inferFrameEntryFromState: realInferFrameEntryFromState,
  isDelegationToken: realIsDelegationToken,
  isJsonArrayStream: realIsJsonArrayStream,
  // The initial-link re-derive loop paces itself on the store's own optimistic
  // budget; both are captured real so this suite exercises the shipped loop.
  DEFAULT_MUTATE_ATTEMPTS: realDefaultMutateAttempts,
  mutateBackoffMs: realMutateBackoffMs,
} = await import('@rundown-org/core');

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

function claimRecord(childRunId: RunId, overrides: Record<string, unknown> = {}): ClaimRecord {
  return makeClaimRecord({
    claimKey: assertClaimLookupKey('rdclk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    secretHash: assertClaimSecretHash(`sha256:${'a'.repeat(64)}`),
    controlledRunId: childRunId,
    delegation: {
      childRunId,
      tokenHash: MOCK_TOKEN_HASH,
      parentRunId: RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
    },
    grants: [],
    ...overrides,
  });
}

function claimedRunbookResult(
  childRunId: RunId,
  overrides: Record<string, unknown> = {},
): ClaimRunbookResult {
  return { status: 'claimed', claimId: TEST_CLAIM_ID, claim: claimRecord(childRunId, overrides) };
}

/**
 * Wrap a domain result in the committed arm of core's guarded session result.
 *
 * Every guarded `SessionService` method now returns `SessionMutationResult<T>`;
 * these wiring tests exercise the committed path, so the refusal arms stay out
 * of the fixtures and each mock keeps naming only the domain value it means.
 *
 * @param value - Domain result the mocked mutation commits.
 * @returns The committed session mutation result carrying `value`.
 */

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

function mockClaimAndInitialLinkSuccess(): jest.Mock<SessionService['claimAndInitialLink']> {
  return mockFn<SessionService['claimAndInitialLink']>().mockImplementation(async (input) =>
    committed(
      claimedRunbookResult(input.childRunId, {
        delegation: {
          childRunId: input.childRunId,
          tokenHash: input.linkage.tokenHash,
          parentRunId: input.linkage.parentRunId,
          parentStepId: input.linkage.parentStepId,
          parentStep: input.linkage.parentStep,
          parentFrameKey: input.linkage.parentFrameKey,
          parentEntry: input.linkage.parentEntry,
        },
      }),
    ),
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
  inferFrameEntryFromState: jest.fn((state: RunbookState, frameKey: FrameKey) =>
    realInferFrameEntryFromState(state, frameKey),
  ),
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
  loadPolicy: jest.fn(),
  DelegationScanService: mockFn<() => { findByToken: jest.Mock }>().mockImplementation(() => ({
    findByToken: mockFn<() => Promise<TokenScanResult | null>>().mockResolvedValue(null),
  })),
  DEFAULT_MUTATE_ATTEMPTS: realDefaultMutateAttempts,
  mutateBackoffMs: realMutateBackoffMs,
  reconstituteContextVars: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
  extractInheritedUserVars: mockFn<() => Record<string, unknown>>().mockReturnValue({}),
  hashDelegationToken: mockFn<() => string>().mockReturnValue(MOCK_TOKEN_HASH),
  isDelegationToken: jest.fn(realIsDelegationToken),
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
    LAUNCH_FAILED: { code: 'RD-816' },
    CLAIM_INVARIANT_VIOLATED: { code: 'RD-820' },
  },
  isJsonArray: jest.fn((v: unknown) => Array.isArray(v)),
  isJsonArrayStream: jest.fn(realIsJsonArrayStream),
  isArtifactValue: jest.fn(isArtifactValueShapeForTest),
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
      runbookRef: RunbookRef;
      identity: { kind: 'prepared' } | { kind: 'runnable'; runId: RunId };
    }) => ({
      ok: true,
      runbook: input.rawRunbook,
      templateVars:
        input.identity.kind === 'runnable'
          ? { ...input.templateVars, RunbookRef: input.runbookRef, RunId: input.identity.runId }
          : { ...input.templateVars, RunbookRef: input.runbookRef },
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
  ArtifactChannelError: class ArtifactChannelError extends Error {
    readonly code: string;
    readonly key: string;

    constructor(code: string, key: string, message: string) {
      super(message);
      this.code = code;
      this.key = key;
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

jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => ResolvedRunbook['steps']>().mockReturnValue([]),
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
const { getRunbookFromState } = await import('../../src/helpers/runbook-loader.js');
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
  const typedOverrides = overrides as Partial<RunPipelineContext>;
  const manager = {
    load: jest.fn(),
    list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
  } as unknown as RunbookStateManager;
  Object.assign(manager, typedOverrides.manager);
  // This default must use the merged manager.load: overrides are assigned above,
  // and initial-link tests depend on capture observing that overridden behavior.
  const captureRunAuthorityState = mockFn<
    RunbookStateManager['captureRunAuthorityState']
  >().mockImplementation(async (runId) => {
    const state = await manager.load(runId);
    if (!state) return { kind: 'missing', runId, message: `Run ${runId} does not exist.` };
    return {
      kind: 'captured',
      authority: {
        runId,
        claimKey: assertClaimLookupKey('rdclk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        claimGeneration: 0,
        stateVersion: 0,
      },
      state,
    } as Awaited<ReturnType<RunbookStateManager['captureRunAuthorityState']>>;
  });
  if (!typedOverrides.manager?.captureRunAuthorityState) {
    Object.assign(manager, { captureRunAuthorityState });
  }
  const actorService = {
    prepareDelegationChildLink: mockFn<
      RunbookActorService['prepareDelegationChildLink']
    >().mockImplementation(
      async (previousState) =>
        ({
          kind: 'prepared',
          prepared: {
            mutation: {
              previousState,
              nextState: previousState,
              snapshot: previousState.snapshot ?? {},
              effects: [],
            },
          },
        }) as unknown as Awaited<ReturnType<RunbookActorService['prepareDelegationChildLink']>>,
    ),
    prepareDelegationChildUnlink: mockFn<
      RunbookActorService['prepareDelegationChildUnlink']
    >().mockImplementation(
      async (previousState) =>
        ({
          kind: 'prepared',
          prepared: {
            mutation: {
              previousState,
              nextState: previousState,
              snapshot: previousState.snapshot ?? {},
              effects: [],
            },
          },
        }) as unknown as Awaited<ReturnType<RunbookActorService['prepareDelegationChildUnlink']>>,
    ),
  };
  Object.assign(actorService, typedOverrides.actorService);
  const sessionService = {
    claimRunbook: mockClaimRunbookSuccess(),
    claimAndInitialLink: mockClaimAndInitialLinkSuccess(),
    rollbackInitialLink: mockFn<SessionService['rollbackInitialLink']>().mockResolvedValue(
      committed({ status: 'rolled-back' }),
    ),
    findClaimForDelegation:
      mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
  };
  Object.assign(sessionService, typedOverrides.sessionService);
  return {
    output: {
      error: jest.fn(),
      status: jest.fn(),
      action: jest.fn(),
      detail: jest.fn(),
      warning: jest.fn(),
      flush: jest.fn(),
    },
    lifecycleService: {},
    // Fake cwd for the mocked pipeline context. Deliberately NOT under /tmp:
    // a `/tmp/...` literal is read by CodeQL's js/insecure-temporary-file as a
    // temp-dir taint source and propagates through production into the safe-fs
    // directory guard, producing a false positive on a read-only O_NOFOLLOW open.
    cwd: '/work/test',
    ...typedOverrides,
    manager,
    actorService: actorService as unknown as RunPipelineContext['actorService'],
    sessionService: sessionService as unknown as RunPipelineContext['sessionService'],
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

beforeEach(() => {
  jest.resetAllMocks();
  // Restore defaults after reset
  jest
    .mocked(core.inferFrameEntryFromState)
    .mockImplementation((state, frameKey) => realInferFrameEntryFromState(state, frameKey));
  jest.mocked(core.runbooksDir).mockImplementation((cwd: string) => `${cwd}/.rundown/runbooks`);
  const runbookRefSchemaMock = core.RunbookRefSchema as unknown as {
    parse: jest.MockedFunction<(ref: unknown) => RunbookRef>;
  };
  runbookRefSchemaMock.parse.mockImplementation((ref: unknown) => ref as RunbookRef);
  jest.mocked(core.hashDelegationToken).mockReturnValue(MOCK_TOKEN_HASH);
  jest.mocked(core.isDelegationToken).mockImplementation(realIsDelegationToken);
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
      return { ok: true, runbook, templateVars, runtimeVars: {}, warnings: [], unresolved: [] };
    });
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
  jest.mocked(getRunbookFromState).mockReturnValue([]);
  jest
    .mocked(createBridgedEmitter)
    .mockReturnValue({ emit: jest.fn() } as unknown as ReturnType<typeof createBridgedEmitter>);
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
    expect(core.hashDelegationToken).not.toHaveBeenCalled();
  });

  it.each(['rdtk_ABC', 'rdtk_invalid@#$%', 'bad-token'])(
    'rejects invalid token %s before hashing',
    async (token) => {
      const ctx = makeCtx();

      const result = await claimAndLaunch(ctx, token, {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        assertVariant(result, 'reason', 'invalid-token');
      }
      expect(core.hashDelegationToken).not.toHaveBeenCalled();
    },
  );

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
            credential: makeDelegationCredentialDescriptor(),
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
            credential: makeDelegationCredentialDescriptor(),
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

    // Mock manager.load returning fresh state with already-claimed delegation
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected success, got ${result.reason}`);
    expect(result.childRunId).toBe(EXISTING_CHILD_RUN_ID);
    expect(result.parentRunId).toBe(RUN_ID);
  });

  // #738: the pipeline used to derive `parentEntry` with `inferFrameEntryFromState`,
  // reading the parent's CURRENT frame entry. Core's liveness classifier then
  // recomputed the same expression over the same state, so the two could not
  // disagree for any input — and the claim minted a grant naming an entry the
  // child was never stamped with, whose terminal report `grantAllows` silently
  // dropped. The entry now comes off the delegation row's credential, which is
  // written once at issuance and survives frame re-entry.
  //
  // Nothing in the CLI classifies liveness on this path any more, so the linkage
  // handed to `claimRunbook` is the only evidence core's in-transaction
  // classifier has. The fixture makes the two coordinates disagree — live state
  // is on the frame's third entry, the credential records the first — so an
  // entry recomputed from `freshParent` would report 3, agree with whatever core
  // re-derives from those same rows, and make the disagreement invisible at the
  // one place left that can act on it.
  it('builds the 3c claim linkage entry from the credential, not from live frame state', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      step: '1',
      variables: {},
      // Live state says the frame is on its third entry — two GOTOs past the
      // issuance the delegation row still records.
      activeFrameKey: '1|0',
      activeEntry: 3,
      frameEntryCounts: { '1|0': 3 },
      substepStates: [
        {
          id: '1',
          frameKey: '1|0',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            credential: makeDelegationCredentialDescriptor({ parentEntry: 1 }),
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            // Routes the claim through 3c, where the hoisted linkage is handed
            // straight to `claimRunbook`.
            childRunId: EXISTING_CHILD_RUN_ID,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [] },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };
    const claimRunbook = mockClaimRunbookSuccess();
    Object.assign(ctx.sessionService, { claimRunbook });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
    );
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(claimRunbook).toHaveBeenCalledTimes(1);
    expect(claimRunbook.mock.calls[0][1]).toMatchObject({ parentEntry: 1 });
  });

  // The same pairing as above, for the step coordinate rather than the entry.
  // The parent's live cursor has moved to step "2"; the delegation was issued on
  // step "1". A linkage that read `freshParent.step` would name "2" — a
  // coordinate recomputed from live state, which is the drift class #738 exists
  // to remove — while the claim's counterparty was stamped with "1". Core
  // compares its own read of the cursor against `linkage.parentStep` inside the
  // claim transaction, so recomputing the field here would make that comparison
  // self-fulfilling and an advanced cursor unobservable.
  it('builds the 3c claim linkage step from the delegation, not from the parent cursor', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      // Live cursor has advanced past the delegating step.
      step: '2',
      variables: {},
      activeFrameKey: '1|0',
      activeEntry: 1,
      frameEntryCounts: { '1|0': 1 },
      substepStates: [
        {
          id: '1',
          frameKey: '1|0',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            credential: makeDelegationCredentialDescriptor({ parentEntry: 1 }),
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
    const claimRunbook = mockClaimRunbookSuccess();
    Object.assign(ctx.sessionService, { claimRunbook });

    mockScanService(
      scanResult({
        parentState,
        // The delegation's own step, as `DelegationScanService` records it from
        // the issuance-time context snapshot.
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
    );
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(claimRunbook).toHaveBeenCalledTimes(1);
    expect(claimRunbook.mock.calls[0][1]).toMatchObject({ parentStep: '1', parentStepId: '1' });
  });

  // `claimResultToFailure`'s child-naming arm, on the one route that has a child
  // to name. 3c hands core a delegation that already records a child, and core's
  // in-transaction classifier — the sole owner of this verdict since the CLI
  // stopped pre-classifying — refuses the claim as superseded. Core's own
  // `delegation-superseded` result leaves `childRunId` unset, so an id in the
  // envelope can only come from the pipeline substituting the child it was
  // claiming: a bearer holder needs to know WHICH run holds the delegation it
  // just lost. The fresh-launch arm deliberately carries none, because the only
  // child it could name is the one launch cleanup is about to delete.
  it('names the claimed child when core supersedes an already-linked claim', async () => {
    const ctx = makeCtx();

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
            credential: makeDelegationCredentialDescriptor(),
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
    const claimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue(
      committed({ status: 'delegation-superseded', parentRunId: RUN_ID, parentStepId: '1' }),
    );
    Object.assign(ctx.sessionService, { claimRunbook });

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
    );
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result).toEqual({
      ok: false,
      reason: 'delegation-superseded',
      parentRunId: RUN_ID,
      stepId: '1',
      childRunId: EXISTING_CHILD_RUN_ID,
    });
    expect(claimRunbook).toHaveBeenCalledTimes(1);
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
            credential: makeDelegationCredentialDescriptor(),
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

    // Mock manager.load returning fresh state with unclaimed delegation
    jest.mocked(ctx.manager).load.mockResolvedValue(parentState as unknown as RunbookState);

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe(ORPHAN_RUN_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }

    const serviceMocks = ctx.sessionService as unknown as {
      readonly claimAndInitialLink: jest.Mock;
    };
    expect(serviceMocks.claimAndInitialLink.mock.calls).toContainEqual([
      expect.objectContaining({
        childRunId: ORPHAN_RUN_ID,
        linkage: expect.objectContaining({ parentRunId: RUN_ID, tokenHash: MOCK_TOKEN_HASH }),
      }),
    ]);
    const managerMocks = ctx.manager as unknown as { readonly update: jest.Mock };
    expect(managerMocks.update).not.toHaveBeenCalled();
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
            credential: makeDelegationCredentialDescriptor(),
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
        parentStep: '1',
        parentFrameKey: brandFrameKeyForTest('1'),
        parentEntry: 1,
      }),
    );
    const claimAndInitialLink = mockClaimAndInitialLinkSuccess();
    const update = mockFn<() => Promise<void>>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      manager: {
        load: mockFn<(id: string) => Promise<unknown>>().mockImplementation(async (id) =>
          id === EXISTING_SESSION_CHILD_ID ? existingChildState : parentState,
        ),
        update,
      },
      sessionService: {
        claimAndInitialLink,
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
    expect(claimAndInitialLink).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: EXISTING_SESSION_CHILD_ID,
        linkage: expect.objectContaining({
          parentRunId: RUN_ID,
          parentStepId: '1',
          tokenHash: MOCK_TOKEN_HASH,
        }),
      }),
    );
    expect(update).not.toHaveBeenCalled();
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
            credential: makeDelegationCredentialDescriptor(),
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
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      tokenHash: MOCK_TOKEN_HASH,
    };
    const persisted: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: DIFFERENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      tokenHash: MOCK_TOKEN_HASH,
    };
    const claimAndInitialLink = mockFn<SessionService['claimAndInitialLink']>().mockResolvedValue(
      committed({
        status: 'linkage-mismatch',
        childRunId: EXISTING_SESSION_CHILD_ID,
        incoming,
        persisted,
      }),
    );
    const update = mockFn<() => Promise<void>>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      manager: {
        load: mockFn<(id: string) => Promise<unknown>>().mockImplementation(async (id) =>
          id === EXISTING_SESSION_CHILD_ID ? existingChildState : parentState,
        ),
        update,
      },
      sessionService: {
        claimAndInitialLink,
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

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'linkage-mismatch');
      expect(result.childRunId).toBe(EXISTING_SESSION_CHILD_ID);
      expect(result.parentRunId).toBe(RUN_ID);
    }
    expect(claimAndInitialLink).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: EXISTING_SESSION_CHILD_ID }),
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
            credential: makeDelegationCredentialDescriptor(),
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

    const mockClaimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue(
      committed({
        status: 'missing-child',
        childRunId: EXISTING_CHILD_RUN_ID,
      }),
    );

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
            credential: makeDelegationCredentialDescriptor(),
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
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      tokenHash: MOCK_TOKEN_HASH,
    };
    const persisted: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1'),
      parentEntry: 1,
      tokenHash: DIFFERENT_TOKEN_HASH,
    };
    const mockClaimRunbook = mockFn<SessionService['claimRunbook']>().mockResolvedValue(
      committed({
        status: 'linkage-mismatch',
        childRunId: EXISTING_CHILD_RUN_ID,
        incoming,
        persisted,
      }),
    );

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

  it('returns TOKEN_NOT_FOUND when parent state no longer exists at the freshness re-read', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: 'run-deleted',
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            credential: makeDelegationCredentialDescriptor(),
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

  it.each(['completed', 'stopped'] as const)(
    'returns parent-ended when parent is %s at the freshness re-read',
    async (lifecycle) => {
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
              credential: makeDelegationCredentialDescriptor(),
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
    },
  );

  it('returns TOKEN_NOT_FOUND when delegation disappears before the freshness re-read', async () => {
    const ctx = makeCtx();

    const parentState = {
      id: RUN_ID,
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            credential: makeDelegationCredentialDescriptor(),
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

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    assertVariant(result, 'reason', 'invalid-token');
    expect(core.hashDelegationToken).not.toHaveBeenCalled();
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
            credential: makeDelegationCredentialDescriptor(),
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

    const mockClaimAndInitialLink = mockClaimAndInitialLinkSuccess();
    const mockUpdate = mockFn<() => Promise<void>>().mockResolvedValue(undefined);

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockCreate,
        update: mockUpdate,
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
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected success, got ${result.reason}`);

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

    // Result surfaces the claim id returned by the atomic operation, which
    // is called with the freshly built linkage (not stale persisted data).
    // cspell:disable-next-line
    expect(result.claimId).toBe('rdclm_abcdefghijklmnopqrstu1');
    expect(result.childRunId).toBe(NEW_CHILD_ID);
    expect(mockClaimAndInitialLink).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: NEW_CHILD_ID,
        linkage: expect.objectContaining({
          kind: 'delegation',
          parentFrameKey: '1|3',
        }),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('uses the delegating step for linkage, not the advanced parent cursor', async () => {
    // Parent state: the delegation was issued on step '1'; the parent's cursor
    // has since advanced to step '2'. The linkage must carry the DELEGATING
    // step — it is the value `classifyDelegationLiveness` compares the
    // in-transaction parent cursor against, and the value persisted onto the
    // claim for the parent-side half of the same latch. Copying the parent's
    // current cursor makes that comparison self-fulfilling.
    const parentState = {
      id: RUN_ID,
      step: '2',
      variables: {},
      substepStates: [
        {
          id: 'delegate',
          frameKey: '1|0',
          status: 'pending',
          delegation: {
            tokenHash: MOCK_TOKEN_HASH,
            credential: makeDelegationCredentialDescriptor(),
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            childRunId: null,
            cancelledAt: null,
            contextSnapshot: { vars: {}, ancestors: [], step: '1' },
            createdAt: '2026-02-27T10:00:00.000Z',
          },
        },
      ],
    };

    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: 'delegate',
        delegation: parentState.substepStates[0].delegation,
        frameKey: brandFrameKeyForTest('1', 0),
      }),
      null,
    );

    jest.mocked(core.deriveActiveFrame).mockReturnValue({
      step: '2',
      iteration: undefined,
      frameKey: brandFrameKeyForTest('2'),
    });

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/work/test/child.md',
      source: 'project',
      sourceRoot: '/work/test',
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
    // resolveForBounds returns a `ResolvedRunbook` (post-FOR-resolution brand).
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
    mockCreate.mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' });

    const mockClaimAndInitialLink = mockClaimAndInitialLinkSuccess();

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
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected success, got ${result.reason}`);

    // Assert on the linkage core RECEIVED, not on the command outcome: core is
    // mocked here and its claim transaction — the only thing that classifies
    // liveness — is stubbed to succeed, so the outcome cannot distinguish the
    // two candidate values. The end-to-end consequence is pinned by
    // `__tests__/integration/delegate-workflow.test.ts`.
    expect(mockClaimAndInitialLink).toHaveBeenCalledTimes(1);
    const linkage = mockClaimAndInitialLink.mock.calls[0][0].linkage;
    expect(linkage.parentStep).toBe('1');
    expect(linkage.parentStepId).toBe('delegate');
    expect(linkage.parentFrameKey).toBe('1|0');
  });

  it('returns LAUNCH_FAILED (RD-816) when manager.create throws', async () => {
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
            credential: makeDelegationCredentialDescriptor(),
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
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'launch-failed');
      expect(result.code).toBe('RD-816');
      expect(result.cause).toContain('disk full');
    }
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
            credential: makeDelegationCredentialDescriptor(),
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

    const mockClaimAndInitialLink = mockFn<
      SessionService['claimAndInitialLink']
    >().mockResolvedValue({
      kind: 'missing',
      runId: NEW_CHILD_ID,
      message: `Run ${NEW_CHILD_ID} no longer exists.`,
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
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
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
    // Claim was attempted against the newly created child run ID
    expect(mockClaimAndInitialLink).toHaveBeenCalledWith(
      expect.objectContaining({ childRunId: NEW_CHILD_ID }),
    );
  });

  it.each([
    {
      caseName: 'delegation-superseded',
      atomicResult: {
        kind: 'claim_superseded' as const,
        runId: RUN_ID,
        message: `Run ${RUN_ID} claim was superseded.`,
      },
      expected: {
        ok: false,
        reason: 'delegation-superseded',
        parentRunId: RUN_ID,
        stepId: 'delegate',
      },
    },
    {
      caseName: 'concurrent-modification',
      atomicResult: {
        kind: 'concurrent_modification' as const,
        runId: RUN_ID,
        message: `Run ${RUN_ID} changed during the atomic claim.`,
      },
      expected: {
        ok: false,
        reason: 'concurrent-modification',
        parentRunId: RUN_ID,
        stepId: 'delegate',
        childRunId: NEW_CHILD_ID,
      },
    },
    {
      // #752. An `rd abort` that lands while the child is being created is the
      // same class of race as the two above — the transaction refused before
      // writing — so it must reach the caller as itself rather than through the
      // `CLAIM_INVARIANT_VIOLATED` envelope this switch reserves for genuinely
      // broken preconditions. The fixture's delegation is uncancelled, so the
      // pre-commit check passed and only the transaction saw the abort. It
      // names no child: the one this claim created is about to be deleted.
      caseName: 'delegation-cancelled',
      atomicResult: committed({
        status: 'delegation-cancelled' as const,
        parentRunId: RUN_ID,
        parentStepId: 'delegate',
        cancelledAt: '2026-08-14T04:05:06.000Z',
      }),
      expected: {
        ok: false,
        reason: 'delegation-cancelled',
        parentRunId: RUN_ID,
        stepId: 'delegate',
        cancelledAt: '2026-08-14T04:05:06.000Z',
      },
    },
  ])(
    'returns $caseName and deletes the fresh child without unlinking when the claim race loses',
    async ({ atomicResult, expected }) => {
      const parentState = {
        id: RUN_ID,
        step: '1',
        variables: {},
        substepStates: [
          {
            id: 'delegate',
            frameKey: '1|0',
            status: 'pending',
            delegation: {
              tokenHash: MOCK_TOKEN_HASH,
              credential: makeDelegationCredentialDescriptor(),
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
          substepId: 'delegate',
          delegation: parentState.substepStates[0].delegation,
          frameKey: brandFrameKeyForTest('1', 0),
        }),
        null,
      );

      jest.mocked(resolveRunbookFile).mockResolvedValue({
        path: '/tmp/test/child.md',
        source: 'project',
        sourceRoot: '/tmp/test',
      });
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
          (runbook) =>
            ({ runbook, warnings: [] }) as unknown as ReturnType<typeof resolveForBounds>,
        );
      jest.mocked(substituteRunbookVariables).mockImplementation((runbook) => runbook);
      jest.mocked(collectUnresolvedRunbookVariables).mockReturnValue(new Set());

      const claimAndInitialLink =
        mockFn<SessionService['claimAndInitialLink']>().mockResolvedValue(atomicResult);
      const update = mockFn<RunbookStateManager['update']>().mockResolvedValue(
        parentState as unknown as RunbookState,
      );
      const removeChild = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);
      const initializeState = mockFn<() => Promise<RunbookState>>().mockResolvedValue({
        id: NEW_CHILD_ID,
        step: '1',
      } as unknown as RunbookState);
      const load = mockFn<() => Promise<RunbookState>>().mockResolvedValue(
        parentState as unknown as RunbookState,
      );
      const ctx = makeCtx({
        manager: {
          load,
          create: mockFn<
            (...args: unknown[]) => Promise<{ id: RunId; title: string }>
          >().mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' }),
          update,
          delete: removeChild,
          list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
          initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        },
        actorService: { initializeState },
        sessionService: {
          claimAndInitialLink,
          findClaimForDelegation:
            mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
        },
      });

      // cspell:disable-next-line
      const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

      expect(result).toEqual(expected);
      expect(claimAndInitialLink).toHaveBeenCalledWith(
        expect.objectContaining({ childRunId: NEW_CHILD_ID }),
      );
      expect(update).not.toHaveBeenCalled();
      expect(removeChild).toHaveBeenCalledWith(NEW_CHILD_ID);
      expect(initializeState).toHaveBeenCalled();
      expect(runExecutionLoop).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural service mock without invoking it.
      expect(ctx.actorService.prepareDelegationChildUnlink).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural service mock without invoking it.
      expect(ctx.sessionService.rollbackInitialLink).not.toHaveBeenCalled();
    },
  );

  it('keeps parent-missing typed when the parent is deleted after fresh launch, rather than RD-820', async () => {
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
            credential: makeDelegationCredentialDescriptor(),
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

    // The parent is deleted between the 4a re-read and the claim transaction.
    // That is a race, not a Rundown invariant break, and `parent-missing` is the
    // refusal the same pipeline already emits for it earlier in 4a.
    const mockClaimAndInitialLink = mockFn<
      SessionService['claimAndInitialLink']
    >().mockResolvedValue({
      kind: 'missing',
      runId: RUN_ID,
      message: `Run ${RUN_ID} no longer exists.`,
    });
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockFn<
          (...args: unknown[]) => Promise<{ id: RunId; title: string }>
        >().mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' }),
        update: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        delete: mockDelete,
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
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'parent-missing');
      expect(result.parentRunId).toBe(RUN_ID);
    }
    expect(mockDelete).toHaveBeenCalledWith(NEW_CHILD_ID);
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('names the winning child when a second claimer loses the delegation, rather than RD-820', async () => {
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
            credential: makeDelegationCredentialDescriptor(),
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

    // Two processes claim one token. This one got past the 4c replay check
    // before the winner committed, launched its own child, and only learns the
    // truth when it re-derives the link against the committed parent. That is a
    // race Rundown handled correctly, not a broken invariant — and the fact the
    // user needs is the WINNER's run id, not this claimer's child, which launch
    // cleanup is about to delete.
    const winningChildRunId = brandRunIdForTest('rd_77777777777777777777777777777777');
    const mockPrepare = mockFn<
      RunbookActorService['prepareDelegationChildLink']
    >().mockResolvedValue({
      kind: 'already_linked',
      runId: RUN_ID,
      message: `Delegation 1 is already linked to another child`,
      occupyingChildRunId: winningChildRunId,
    });
    const mockClaimAndInitialLink = mockFn<SessionService['claimAndInitialLink']>();
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockFn<
          (...args: unknown[]) => Promise<{ id: RunId; title: string }>
        >().mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' }),
        update: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        delete: mockDelete,
        list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
        initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          step: '1',
        } as unknown as RunbookState),
        prepareDelegationChildLink: mockPrepare,
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'delegation-already-claimed');
      expect(result.parentRunId).toBe(RUN_ID);
      expect(result.stepId).toBe('1');
      expect(result.childRunId).toBe(winningChildRunId);
    }
    // The permanent refusal was decided before any commit was attempted.
    expect(mockClaimAndInitialLink).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith(NEW_CHILD_ID);
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  it('does not claim or link when fresh delegated launch initialization fails', async () => {
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
            credential: makeDelegationCredentialDescriptor(),
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

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
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

    const mockClaimRunbook = mockClaimRunbookSuccess();
    const mockReleaseRunbook = mockFn<SessionService['releaseRunbook']>().mockResolvedValue(
      committed({
        status: 'released',
        runbookId: NEW_CHILD_ID,
        removedFromDefaultStack: false,
        nextDefaultRunbookId: null,
      } satisfies ReleaseRunbookResult),
    );
    const mockUpdate = mockFn<RunbookStateManager['update']>().mockResolvedValue(
      parentState as unknown as RunbookState,
    );
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);

    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockFn<
          (...args: unknown[]) => Promise<{ id: RunId; title: string }>
        >().mockResolvedValue({ id: NEW_CHILD_ID, title: 'Child' }),
        update: mockUpdate,
        delete: mockDelete,
        list: mockFn<() => Promise<unknown[]>>().mockResolvedValue([]),
        initializeSubsteps: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockRejectedValue(
          new Error('initialize failed'),
        ),
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimRunbook: mockClaimRunbook,
        releaseRunbook: mockReleaseRunbook,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertVariant(result, 'reason', 'launch-failed');
      expect(result.code).toBe('RD-816');
      expect(result.cause).toContain('initialize failed');
    }
    expect(mockClaimRunbook).not.toHaveBeenCalled();
    const serviceMocks = ctx.sessionService as unknown as {
      readonly claimAndInitialLink: jest.Mock;
    };
    expect(serviceMocks.claimAndInitialLink).not.toHaveBeenCalled();
    expect(mockReleaseRunbook).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith(NEW_CHILD_ID);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(runExecutionLoop).not.toHaveBeenCalled();
  });

  async function arrangeInitialLinkRollback() {
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
            credential: makeDelegationCredentialDescriptor(),
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
    const linkage: DelegationLinkage = {
      kind: 'delegation',
      parentRunId: RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: brandFrameKeyForTest('1', 0),
      parentEntry: 1,
      tokenHash: MOCK_TOKEN_HASH,
    };
    mockScanService(
      scanResult({
        parentState,
        stepId: '1',
        substepId: '1',
        delegation: parentState.substepStates[0].delegation,
        frameKey: linkage.parentFrameKey,
      }),
      null,
    );
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
    jest.mocked(parser.parseRunbookDocument).mockReturnValue({
      runbook: { steps: [{ kind: 'base', name: '1', description: 'Step' }] },
      frontmatter: null,
      diagnostics: [],
    } as unknown as ReturnType<typeof parser.parseRunbookDocument>);
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

    const mockUpdate = mockFn<RunbookStateManager['update']>().mockResolvedValue(
      parentState as unknown as RunbookState,
    );
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);
    const claimAndInitialLink = mockClaimAndInitialLinkSuccess();
    const ctx = makeCtx({
      manager: {
        load: mockFn<() => Promise<RunbookState>>().mockResolvedValue(
          parentState as unknown as RunbookState,
        ),
        create: mockFn<() => Promise<{ id: RunId; title: string }>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          title: 'Child',
        }),
        update: mockUpdate,
        delete: mockDelete,
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          step: '1',
        } as unknown as RunbookState),
      },
      sessionService: { claimAndInitialLink },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
    const prepareUnlink = jest.mocked(ctx.actorService.prepareDelegationChildUnlink);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
    const rollbackInitialLink = jest.mocked(ctx.sessionService.rollbackInitialLink);
    jest.mocked(createBridgedEmitter).mockReturnValue({
      emit: jest.fn(() => {
        throw new Error('post-link startup failure');
      }),
    } as unknown as ReturnType<typeof createBridgedEmitter>);

    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
    const capture = jest.mocked(ctx.manager.captureRunAuthorityState);
    const firstCapture = capture.mock.results.at(0);
    if (firstCapture === undefined) throw new Error('Expected the initial parent capture');
    const capturedAuthority = (await firstCapture.value) as Awaited<
      ReturnType<RunbookStateManager['captureRunAuthorityState']>
    >;
    if (capturedAuthority.kind !== 'captured') {
      throw new Error('Expected the initial launch to capture the parent authority');
    }
    return { ctx, prepareUnlink, rollbackInitialLink, capturedAuthority };
  }

  it('rolls back the exact atomic initial link when startup fails before the execution loop', async () => {
    const { ctx, prepareUnlink, rollbackInitialLink, capturedAuthority } =
      await arrangeInitialLinkRollback();

    expect(prepareUnlink as unknown as jest.Mock).toHaveBeenCalledWith(
      capturedAuthority.state,
      [],
      NEW_CHILD_ID,
      expect.objectContaining({ parentRunId: RUN_ID, tokenHash: MOCK_TOKEN_HASH }),
    );
    expect(rollbackInitialLink as unknown as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        childRunId: NEW_CHILD_ID,
        linkage: expect.objectContaining({ parentRunId: RUN_ID, tokenHash: MOCK_TOKEN_HASH }),
      }),
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies this structural state-manager mock without invoking it.
    expect(ctx.manager.delete).toHaveBeenCalledWith(NEW_CHILD_ID);
    expect(runExecutionLoop).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies this structural state-manager mock without invoking it.
    expect(ctx.manager.update).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies this structural output-emitter mock without invoking it.
    expect(ctx.output.warning).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing parent',
      configure: (mocks: Awaited<ReturnType<typeof arrangeInitialLinkRollback>>): void => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
        const capture = jest.mocked(mocks.ctx.manager.captureRunAuthorityState);
        capture.mockReset();
        capture.mockResolvedValueOnce(mocks.capturedAuthority).mockResolvedValueOnce({
          kind: 'missing',
          runId: RUN_ID,
          message: `Run ${RUN_ID} disappeared before rollback.`,
        });
        mocks.prepareUnlink.mockClear();
        mocks.rollbackInitialLink.mockClear();
      },
      expectedWarning: `Run ${RUN_ID} disappeared before rollback.`,
      expectedPrepareCalls: 0,
      expectedRollbackCalls: 0,
    },
    {
      name: 'superseded delegation',
      configure: (mocks: Awaited<ReturnType<typeof arrangeInitialLinkRollback>>): void => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
        const capture = jest.mocked(mocks.ctx.manager.captureRunAuthorityState);
        capture.mockReset();
        capture.mockResolvedValue(mocks.capturedAuthority);
        mocks.prepareUnlink.mockReset();
        mocks.prepareUnlink.mockResolvedValue({
          kind: 'delegation_superseded',
          runId: RUN_ID,
          message: 'The delegation moved before rollback preparation.',
        });
        mocks.rollbackInitialLink.mockClear();
      },
      expectedWarning: 'The delegation moved before rollback preparation.',
      expectedPrepareCalls: 1,
      expectedRollbackCalls: 0,
    },
    {
      name: 'concurrent modification',
      configure: (mocks: Awaited<ReturnType<typeof arrangeInitialLinkRollback>>): void => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
        const capture = jest.mocked(mocks.ctx.manager.captureRunAuthorityState);
        capture.mockReset();
        capture.mockResolvedValue(mocks.capturedAuthority);
        mocks.prepareUnlink.mockClear();
        mocks.rollbackInitialLink.mockReset();
        mocks.rollbackInitialLink.mockResolvedValue({
          kind: 'concurrent_modification',
          runId: RUN_ID,
          message: `Run ${RUN_ID} was modified concurrently.`,
        });
      },
      expectedWarning: `Run ${RUN_ID} was modified concurrently.`,
      expectedPrepareCalls: 1,
      expectedRollbackCalls: 1,
    },
    {
      name: 'unexpected rollback error',
      configure: (mocks: Awaited<ReturnType<typeof arrangeInitialLinkRollback>>): void => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- The context contains the Jest mock installed by makeCtx.
        const capture = jest.mocked(mocks.ctx.manager.captureRunAuthorityState);
        capture.mockReset();
        capture.mockResolvedValue(mocks.capturedAuthority);
        mocks.prepareUnlink.mockClear();
        mocks.rollbackInitialLink.mockReset();
        mocks.rollbackInitialLink.mockRejectedValue(new Error('rollback storage failed'));
      },
      expectedWarning: 'rollback storage failed',
      expectedPrepareCalls: 1,
      expectedRollbackCalls: 1,
    },
  ])(
    'warns and preserves the launch failure for $name',
    async ({ configure, expectedWarning, expectedPrepareCalls, expectedRollbackCalls }) => {
      const mocks = await arrangeInitialLinkRollback();
      configure(mocks);

      // cspell:disable-next-line
      const result = await claimAndLaunch(mocks.ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

      expect(result).toMatchObject({
        ok: false,
        reason: 'launch-failed',
        code: 'RD-816',
        cause: 'post-link startup failure',
      });
      expect(mocks.prepareUnlink).toHaveBeenCalledTimes(expectedPrepareCalls);
      expect(mocks.rollbackInitialLink).toHaveBeenCalledTimes(expectedRollbackCalls);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies this structural output-emitter mock without invoking it.
      expect(mocks.ctx.output.warning).toHaveBeenCalledWith(
        `Could not unlink delegated child ${NEW_CHILD_ID} from parent ${RUN_ID}: ${expectedWarning}`,
      );
    },
  );

  it('deletes orphaned child state when afterInit throws due to claim invariant violation', async () => {
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
            credential: makeDelegationCredentialDescriptor(),
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

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/tmp/test/child.md',
      source: 'project',
      sourceRoot: '/tmp/test',
    });
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

    const mockClaimAndInitialLink = mockFn<
      SessionService['claimAndInitialLink']
    >().mockResolvedValue({
      kind: 'missing',
      runId: NEW_CHILD_ID,
      message: `Run ${NEW_CHILD_ID} no longer exists.`,
    });

    const mockDelete = mockFn<(id: RunId) => Promise<void>>().mockResolvedValue(undefined);

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
        delete: mockDelete,
      },
      actorService: {
        initializeState: mockFn<() => Promise<RunbookState>>().mockResolvedValue({
          id: NEW_CHILD_ID,
          step: '1',
        } as unknown as RunbookState),
      },
      sessionService: {
        pushRunbook: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        claimAndInitialLink: mockClaimAndInitialLink,
        findClaimForDelegation:
          mockFn<SessionService['findClaimForDelegation']>().mockResolvedValue(null),
      },
    });

    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    // The orphaned child run created by manager.create must be cleaned up
    expect(mockDelete).toHaveBeenCalledWith(NEW_CHILD_ID);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies structural service mocks without invoking them.
    expect(ctx.manager.captureRunAuthorityState).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies structural service mocks without invoking them.
    expect(ctx.actorService.prepareDelegationChildUnlink).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest verifies structural service mocks without invoking them.
    expect(ctx.sessionService.rollbackInitialLink).not.toHaveBeenCalled();
  });
});
