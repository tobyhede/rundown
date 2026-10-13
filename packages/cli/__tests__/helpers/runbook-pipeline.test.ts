import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  RunbookActorService,
  RunbookStateManager,
  PrepareParsedRunbookInput,
  PrepareParsedRunbookResult,
  PreparedTemplateVariables,
  RunbookState,
  RunbookRef,
  RunId,
  RunnableTemplateVariables,
  ResolvedStep,
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
import { brandRunIdForTest, brandTrustedArtifactRecordForTest } from './brand-helpers.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const {
  inferFrameEntryFromState: realInferFrameEntryFromState,
  isJsonArrayStream: realIsJsonArrayStream,
  RunbookRefSchema: realRunbookRefSchema,
  RunbookCompositionUnsupportedError: RealRunbookCompositionUnsupportedError,
  generateOwnerToken: realGenerateOwnerToken,
  hashRunSecret: realHashRunSecret,
  redactRunSecret: realRedactRunSecret,
  OwnerTokenSchema: realOwnerTokenSchema,
} = await import('@rundown-org/core');

const RUN_ID_PATTERN = /^rd_[a-f0-9]{32}$/;
const MOCK_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);

jest.unstable_mockModule('@rundown-org/core', () => ({
  RunbookCompositionUnsupportedError: RealRunbookCompositionUnsupportedError,
  generateOwnerToken: realGenerateOwnerToken,
  hashRunSecret: realHashRunSecret,
  redactRunSecret: realRedactRunSecret,
  OwnerTokenSchema: realOwnerTokenSchema,
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
  inferFrameEntryFromState: jest.fn(realInferFrameEntryFromState),
  parseStepIdFromString: jest.fn(),
  RUNS_DIR: '.rundown/runs',
  runbooksDir: jest.fn((cwd: string) => `${cwd}/.rundown/runbooks`),
  RunbookRefSchema: {
    parse: jest.fn((ref: unknown) => realRunbookRefSchema.parse(ref)),
  },
  generateRunId: jest.fn(() => `rd_${'a'.repeat(32)}`),
  progressionDirectiveForStartedRun: (state: RunbookState, steps: readonly ResolvedStep[]) => ({
    kind: 'activate',
    authority: { runId: state.id },
    runbook: state.runbook,
    steps,
    entryBoundary: { kind: 'resume' },
  }),
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
  reconstituteContextVars: mockFn<
    (...args: unknown[]) => Record<string, unknown>
  >().mockReturnValue({}),
  extractInheritedUserVars: jest.fn(),
  ErrorCodes: {
    ENGINE_INIT_FAILED: { code: 'RD-501' },
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

jest.unstable_mockModule('../../src/helpers/runbook-loader', () => ({
  getRunbookFromState: mockFn<() => ResolvedRunbook['steps']>().mockReturnValue([]),
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
  startRunbook: startRunbookCore,
  countSubsteps,
  buildContextVars,
  buildTemplateVars,
} = await import('../../src/helpers/runbook-pipeline.js');
const { setHelperRegistry, resetHelperRegistry } = await import(
  '../../src/services/helper-registry.js'
);

const mockDriveProgression = mockFn<
  Parameters<typeof startRunbookCore>[2]['driveProgression']
>().mockImplementation(async (directive) => ({
  kind: 'completed',
  runId: directive.authority.runId,
}));

async function startRunbook(
  ctx: RunPipelineContext,
  prepared: RunnableRunbook,
  options: Omit<Parameters<typeof startRunbookCore>[2], 'driveProgression'>,
): ReturnType<typeof startRunbookCore> {
  return startRunbookCore(ctx, prepared, {
    ...options,
    driveProgression: (directive, sink) => mockDriveProgression(directive, sink),
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

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  mockDriveProgression.mockImplementation(async (directive) => ({
    kind: 'completed',
    runId: directive.authority.runId,
  }));
  jest
    .mocked(core.deriveExecutionAt)
    .mockImplementation(
      (step: string, substep?: string, iteration?: number) =>
        `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
    );
  jest.mocked(core.getActiveForContext).mockReturnValue(undefined);
  jest
    .mocked(core.inferFrameEntryFromState)
    .mockImplementation((state, frameKey) => realInferFrameEntryFromState(state, frameKey));
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

describe('prepareRunbook — composition (#901)', () => {
  // Whether a composing runbook may start is core's decision, made where the
  // run would be created (`RunbookStateManager.create`); see the startRunbook
  // composition test. Read-only preparation never reaches that seam.
  beforeEach(() => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/compose.runbook.md',
      source: 'project',
      sourceRoot: '/test',
    });
  });

  it('still resolves a composing runbook for read-only preparation (rundown resolve)', async () => {
    jest.mocked(parser.parseRunbookDocument).mockReturnValue(
      mockParseResult({
        runbook: {
          steps: [
            makeStep({
              name: '1',
              substeps: [{ id: '1', description: 'Delegated', delegate: true }],
            }),
          ],
        },
      }),
    );

    const result = await prepareRunbook('compose.runbook.md', {}, '/test');

    expect(result.ok).toBe(true);
  });
});

describe('startRunbook', () => {
  function prepared(runId: RunId, overrides: Partial<RunnableRunbook> = {}): RunnableRunbook {
    return {
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
      ...overrides,
    };
  }

  function initialized(createdState: RunbookState): RunbookState {
    return {
      ...createdState,
      lastAction: { type: 'START' as const, origin: 'direct' as const },
      activeFrameKey: '1|' as ReturnType<typeof core.buildFrameKey>,
      activeEntry: 1,
      frameEntryCounts: { '1|': 1 },
    } as unknown as RunbookState;
  }

  it('creates the run under a fresh Owner Token hash, emits RUNBOOK_STARTED with the token, and drives progression', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const initializedState = initialized(createdState);
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const mockUpdate = mockFn<RunbookStateManager['update']>().mockResolvedValue(createdState);
    const mockInitState =
      mockFn<RunbookActorService['initializeState']>().mockResolvedValue(initializedState);
    const emit = jest.fn();
    jest
      .mocked(createBridgedEmitter)
      .mockReturnValue({ emit } as unknown as ReturnType<typeof createBridgedEmitter>);

    const ctx = makeRunPipelineContext({
      manager: { create: mockCreate, update: mockUpdate },
      actorService: { initializeState: mockInitState },
    });
    const input = prepared(MOCK_RUN_ID);

    const result = await startRunbook(ctx, input, { file: 'runbook.md', prompted: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.progression.kind).toBe('completed');
    expect(result.stateId).toBe(MOCK_RUN_ID);
    expect(core.OwnerTokenSchema.safeParse(result.ownerToken).success).toBe(true);

    // The row carries only the hash of the token the caller was handed.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createOptions = mockCreate.mock.calls[0][2];
    expect(createOptions).toEqual(
      expect.objectContaining({
        runId: input.runId,
        ownerTokenHash: core.hashRunSecret(result.ownerToken),
        runbookPath: 'runbook.md',
        prompted: true,
        runbookSrc: '# Test',
        templateVars: expect.objectContaining({
          RunId: input.runId,
          RunbookRef: input.runbookRef,
        }),
        frontmatterOutputs: [],
      }),
    );
    expect(JSON.stringify(createOptions)).not.toContain(result.ownerToken);
    expect(mockInitState).toHaveBeenCalledWith(MOCK_RUN_ID, input.runbook.steps);
    expect(mockUpdate).not.toHaveBeenCalled();

    // RUNBOOK_STARTED is the one place the plaintext token travels.
    expect(jest.mocked(createBridgedEmitter).mock.calls[0]).toEqual([initializedState, ctx.output]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STARTED',
      payload: expect.objectContaining({ prompted: true, ownerToken: result.ownerToken }),
    });

    // Progression is driven under the directive core mints for a started run.
    expect(mockDriveProgression).toHaveBeenCalledTimes(1);
    const [directive, sink] = mockDriveProgression.mock.calls[0];
    expect(directive).toEqual({
      kind: 'activate',
      authority: expect.objectContaining({ runId: MOCK_RUN_ID }),
      runbook: initializedState.runbook,
      steps: input.runbook.steps,
      entryBoundary: { kind: 'resume' },
    });
    expect(sink).toEqual({ emit });
  });

  it('mints a different Owner Token for every launch', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const ctx = makeRunPipelineContext({
      manager: { create: mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState) },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(
          initialized(createdState),
        ),
      },
    });

    const first = await startRunbook(ctx, prepared(MOCK_RUN_ID), { file: 'runbook.md' });
    const second = await startRunbook(ctx, prepared(MOCK_RUN_ID), { file: 'runbook.md' });

    assertVariant(first, 'ok', true);
    assertVariant(second, 'ok', true);
    expect(first.ownerToken).not.toBe(second.ownerToken);
  });

  it('returns RD-501 and deletes the run row when actor initialization yields no state', async () => {
    // initializeState resolving to a falsy state must abort the launch with a
    // structured launch-failed envelope — pins the `if (!initializedState) throw`
    // guard and its message, and confirms the half-created run does not linger.
    const runId = brandRunIdForTest(`rd_${'7'.repeat(32)}`);
    const createdState = makeState(runId) as unknown as RunbookState;
    const mockDelete = mockFn<RunbookStateManager['delete']>().mockResolvedValue(undefined);
    const ctx = makeRunPipelineContext({
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState),
        delete: mockDelete,
      },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(null),
      },
    });

    const result = await startRunbook(ctx, prepared(runId), { file: 'runbook.md' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a launch failure');
    expect(result.reason).toBe('launch-failed');
    expect(result.code).toBe('RD-501');
    expect(result.error).toContain('Failed to initialize runbook engine');
    expect(result.details).toEqual({ runbookName: 'runbook.md' });
    expect(mockDelete).toHaveBeenCalledWith(runId);
    expect(mockDriveProgression).not.toHaveBeenCalled();
  });

  it('redacts an Owner Token that leaks into a launch error message', async () => {
    const runId = brandRunIdForTest(`rd_${'8'.repeat(32)}`);
    const leaked = core.generateOwnerToken();
    const ctx = makeRunPipelineContext({
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockRejectedValue(
          new Error(`store refused token ${leaked}`),
        ),
        delete: mockFn<RunbookStateManager['delete']>(),
      },
    });

    const result = await startRunbook(ctx, prepared(runId), { file: 'runbook.md' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a launch failure');
    expect(result.code).toBe('RD-501');
    expect(result.error).not.toContain(leaked);
    expect(result.error).toBe(core.redactRunSecret(`store refused token ${leaked}`));
    // Nothing was created, so nothing is deleted.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(ctx.manager.delete).not.toHaveBeenCalled();
  });

  it("renders core's composition refusal as RUNBOOK_COMPOSITION_UNSUPPORTED and creates nothing", async () => {
    // Core refuses at `create`, before writing a row; the CLI only renders the
    // substeps the refusal names, with the text docs/spec/cli-output.md quotes.
    const runId = brandRunIdForTest(`rd_${'6'.repeat(32)}`);
    const mockInitialize = mockFn<RunbookActorService['initializeState']>();
    const ctx = makeRunPipelineContext({
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockRejectedValue(
          new RealRunbookCompositionUnsupportedError(['1.1', '2.3']),
        ),
        delete: mockFn<RunbookStateManager['delete']>(),
      },
      actorService: { initializeState: mockInitialize },
    });

    const result = await startRunbook(ctx, prepared(runId), {
      file: 'runbooks/parent.runbook.md',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'composition-unsupported',
      error:
        'Runbook composes other runbooks at 1.1, 2.3 in a form this build does not run ' +
        '(a substep listing more than one runbook: each substep composes one child).',
      code: 'RUNBOOK_COMPOSITION_UNSUPPORTED',
      details: { runbook: 'runbooks/parent.runbook.md', substeps: ['1.1', '2.3'] },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects this structural mock without invoking it.
    expect(ctx.manager.delete).not.toHaveBeenCalled();
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockDriveProgression).not.toHaveBeenCalled();
  });

  it('preserves the launch error when the best-effort cleanup itself fails', async () => {
    const runId = brandRunIdForTest(`rd_${'9'.repeat(32)}`);
    const createdState = makeState(runId) as unknown as RunbookState;
    const ctx = makeRunPipelineContext({
      manager: {
        create: mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState),
        delete: mockFn<RunbookStateManager['delete']>().mockRejectedValue(new Error('locked')),
      },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(null),
      },
    });

    const result = await startRunbook(ctx, prepared(runId), { file: 'runbook.md' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a launch failure');
    expect(result.error).toContain('Failed to initialize runbook engine');
  });

  it('seeds frontmatterOutputs from prepared.frontmatter.outputs to manager.create', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const ctx = makeRunPipelineContext({
      manager: { create: mockCreate },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(
          initialized(createdState),
        ),
      },
    });

    await startRunbook(
      ctx,
      prepared(MOCK_RUN_ID, {
        frontmatter: { outputs: [{ name: 'PlanPath' }, { name: 'Summary' }] },
      }),
      { file: 'runbook.md' },
    );

    expect(mockCreate.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        frontmatterOutputs: [{ name: 'PlanPath' }, { name: 'Summary' }],
      }),
    );
  });

  it('lets explicit initialVariables override prepared runtime variables', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const ctx = makeRunPipelineContext({
      manager: { create: mockCreate },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(
          initialized(createdState),
        ),
      },
    });

    await startRunbook(
      ctx,
      prepared(MOCK_RUN_ID, {
        runtimeVars: { Kept: 'from-prepared', Overridden: 'from-prepared' },
      }),
      { file: 'runbook.md', initialVariables: { Overridden: 'explicit', Added: 'explicit' } },
    );

    expect(mockCreate.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        initialVariables: { Kept: 'from-prepared', Overridden: 'explicit', Added: 'explicit' },
      }),
    );
  });

  it('writes prompted: false when the caller names no mode', async () => {
    const createdState = makeState(MOCK_RUN_ID) as unknown as RunbookState;
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const emit = jest.fn();
    jest
      .mocked(createBridgedEmitter)
      .mockReturnValue({ emit } as unknown as ReturnType<typeof createBridgedEmitter>);
    const ctx = makeRunPipelineContext({
      manager: { create: mockCreate },
      actorService: {
        initializeState: mockFn<RunbookActorService['initializeState']>().mockResolvedValue(
          initialized(createdState),
        ),
      },
    });

    await startRunbook(ctx, prepared(MOCK_RUN_ID), { file: 'runbook.md' });

    expect(mockCreate.mock.calls[0][2]).toEqual(expect.objectContaining({ prompted: false }));
    expect(emit).toHaveBeenCalledWith({
      type: 'RUNBOOK_STARTED',
      payload: expect.objectContaining({ prompted: false }),
    });
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
