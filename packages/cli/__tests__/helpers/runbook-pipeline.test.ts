import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type {
  RunbookActorService,
  RunbookStateManager,
  SessionService,
  ExecutionLifecycleService,
  DelegationScanService,
  DelegationLock,
  RunbookState,
} from '@rundown-org/core';
import type {
  ParsedForClause,
  ParsedSubstep,
  ParseResult,
  Step,
  Transitions,
} from '@rundown-org/parser';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import type { PreparedRunbook, RunPipelineContext } from '../../src/helpers/runbook-pipeline.js';
import { assertVariant } from './assert-variant.js';
import { mockErrorHelpers } from './mock-error-helpers.js';
import { makeRunPipelineContext } from './run-pipeline-context-helpers.js';
import { mockFn } from './typed-mocks.js';
import { brandDelegationTokenHashForTest } from './brand-helpers.js';

// Capture the real isJsonArrayStream before the mock is registered.
// jest.unstable_mockModule does NOT hoist (unlike jest.mock), so this top-level
// await executes first and always captures the real branded implementation.
const { isJsonArrayStream: realIsJsonArrayStream } = await import('@rundown-org/core');

const MOCK_TOKEN_HASH = brandDelegationTokenHashForTest(`sha256:${'a'.repeat(64)}`);

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
    DELEGATION_OWNER_CONFLICT: { code: 'RD-819' },
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
  resolveVariables: mockFn<
    (...args: unknown[]) => Promise<{
      vars: Record<string, unknown>;
      warnings: string[];
      providedKeys: Set<string>;
      sources?: Record<string, unknown>;
    }>
  >().mockResolvedValue({ vars: {}, warnings: [], providedKeys: new Set() }),
  RUNTIME_RESERVED_VARIABLES: new Set(['step', 'index', 'context']),
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
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook.js');
const { runExecutionLoop, buildStepVariables } = await import('../../src/services/execution.js');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter.js');
const { FileSourcePolicyError, resolveVariables } = await import(
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
const { prepareRunbook, startRunbook, buildContextVars, buildTemplateVars } = await import(
  '../../src/helpers/runbook-pipeline.js'
);
const { setHelperRegistry, resetHelperRegistry } = await import(
  '../../src/services/helper-registry.js'
);

function makeState(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    runbook: 'test.md',
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
    .mocked(createBridgedEmitter)
    .mockReturnValue({ emit: jest.fn() } as unknown as ReturnType<typeof createBridgedEmitter>);
  jest.mocked(resolveVariables).mockResolvedValue({
    vars: {},
    sources: {},
    warnings: [],
    providedKeys: new Set(),
  } as unknown as Awaited<ReturnType<typeof resolveVariables>>);
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
  jest.mocked(core.reconstituteContextVars).mockReturnValue({});
  jest.mocked(core.extractInheritedUserVars).mockReturnValue({});
  jest.mocked(core.deriveActiveFrame).mockReturnValue({
    step: '1',
    iteration: undefined,
    frameKey: '1' as unknown as ReturnType<typeof core.deriveActiveFrame>['frameKey'],
  });
  jest.mocked(core.isJsonArray).mockImplementation((v: unknown) => Array.isArray(v));
  jest.mocked(core.isJsonArrayStream).mockImplementation(realIsJsonArrayStream);
});

// validateSources was removed in the unified variable model refactoring.
// Source validation now happens during variable resolution.

describe('prepareRunbook', () => {
  it('returns error when file not found', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue(null);

    const result = await prepareRunbook('missing.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('returns error when runbook has no steps', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/empty.md',
      source: 'project',
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

  it('adds context.vars aliases to merged template variables', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
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
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        region: 'us-west',
        'context.vars.region': 'us-west',
      }),
    );
  });

  it('adds context.vars.* aliases for inherited user vars', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    jest.mocked(resolveVariables).mockResolvedValue({
      vars: {},
      warnings: [],
      providedKeys: new Set(),
    });

    const result = await prepareRunbook('child.md', {}, '/test', {
      inheritedUserVars: { Region: 'us-west' },
    });

    expect(result.ok).toBe(true);
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Region: 'us-west',
        'context.vars.Region': 'us-west',
      }),
    );
  });

  it('child vars override inherited in context.vars.* aliases', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/child.md',
      source: 'project',
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
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Region: 'eu-central',
        'context.vars.Region': 'eu-central',
      }),
    );
  });

  it('does not pass frontmatter inputs into variable resolution', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/good.md',
      source: 'project',
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
            message: 'Frontmatter "required" variable "Region" must also be declared in "inputs"',
          },
        ],
      }),
    );

    const result = await prepareRunbook('missing-input.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('must also be declared in "inputs"');
    }
  });

  it('bails before helper-collision warnings when frontmatter validation fails', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/reserved.md',
      source: 'project',
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
              'Frontmatter "inputs[0]" — "context" is a reserved variable name (step, index, context — case-insensitive)',
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

  it('injects CLAUDE_PLUGIN_ROOT when runbook resolves from plugin source', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/write-plan.runbook.md',
      source: 'plugin' as const,
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    // CLAUDE_PLUGIN_ROOT should be derived from the resolved path (everything before /runbooks/)
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        CLAUDE_PLUGIN_ROOT: '/home/user/.claude/extensions/rundown-plugin/',
      }),
    );
  });

  it('does not inject CLAUDE_PLUGIN_ROOT when runbook resolves from project source', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/.rundown/runbooks/my-runbook.runbook.md',
      source: 'project' as const,
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());

    const result = await prepareRunbook('my-runbook', {}, '/test');

    expect(result.ok).toBe(true);
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({
        CLAUDE_PLUGIN_ROOT: expect.anything(),
      }),
    );
  });

  it('allows --input to override CLAUDE_PLUGIN_ROOT', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/write-plan.runbook.md',
      source: 'plugin' as const,
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
    expect(substituteRunbookVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        CLAUDE_PLUGIN_ROOT: '/custom/override',
      }),
    );
  });
});

describe('startRunbook', () => {
  it('creates state and runs execution loop', async () => {
    const createdState = makeState('new-id') as unknown as RunbookState;
    const mockCreate = mockFn<RunbookStateManager['create']>().mockResolvedValue(createdState);
    const mockUpdate = mockFn<RunbookStateManager['update']>().mockResolvedValue(createdState);
    const mockLoad = mockFn<RunbookStateManager['load']>().mockResolvedValue(createdState);
    const mockInitializeSubsteps =
      mockFn<RunbookStateManager['initializeSubsteps']>().mockResolvedValue(undefined);
    const mockInitState =
      mockFn<RunbookActorService['initializeState']>().mockResolvedValue(createdState);
    const mockPushRunbook = mockFn<SessionService['pushRunbook']>().mockResolvedValue(undefined);
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
      sessionService: { pushRunbook: mockPushRunbook },
      lifecycleService: { ensureActiveEntry: mockEnsureActiveEntry },
    });

    const prepared: PreparedRunbook = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep() as PreparedRunbook['runbook']['steps'][number]] },
      mergedVariables: {},
      stats: { steps: 1, substeps: 0 },
      frontmatter: null,
    };

    const result = await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loopResult).toBe('done');
    }
    expect(mockCreate).toHaveBeenCalledWith(
      'runbook.md',
      prepared.runbook,
      expect.objectContaining({
        runbookPath: 'runbook.md',
        runbookSrc: '# Test',
        frontmatterOutputs: [],
      }),
    );
    expect(mockInitState).toHaveBeenCalled();
    expect(mockPushRunbook).toHaveBeenCalled();
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
        initializeState:
          mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep()] },
      mergedVariables: {},
      sources: {},
      frontmatter: { outputs: outputDecls },
    } as unknown as PreparedRunbook;

    await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(mockCreate).toHaveBeenCalledWith(
      'runbook.md',
      prepared.runbook,
      expect.objectContaining({ frontmatterOutputs: outputDecls }),
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
        initializeState:
          mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as RunbookActorService,
      sessionService: {
        pushRunbook: mockFn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const substeps = [{ id: 'a' }, { id: 'b' }];
    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep({ substeps })] },
      mergedVariables: {},
      sources: {},
    } as unknown as PreparedRunbook;

    const result = await startRunbook(ctx, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    const firstStep = prepared.runbook.steps[0];
    if (firstStep.kind !== 'substeps') {
      throw new Error(`Expected first step to have substeps, got ${firstStep.kind}`);
    }
    expect(mockInitSubsteps).toHaveBeenCalledWith('sub-id', firstStep.substeps, '1|');
    expect(mockUpdate).toHaveBeenCalledWith('sub-id', { substep: 'a' });
  });
});

describe('claimAndLaunch', () => {
  it('returns error when token format is invalid', async () => {
    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: {} as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {} as unknown as SessionService,
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
      sessionService: {} as unknown as SessionService,
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

  it('returns idempotent result when token already claimed', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {} as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('existing-child-id');
      expect(result.loopResult).toBe('waiting');
    }
  });

  it('returns error when delegation was cancelled', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: new Date().toISOString(),
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {} as unknown as SessionService,
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
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const orphanState = makeState('orphan-id', {
      delegation: {
        parentRunId: 'parent-id',
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {} as unknown as SessionService,
      lifecycleService: {} as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('orphan-id');
    }
    expect(mockManager.update).toHaveBeenCalled();
  });

  it('rejects re-claim when the already-claimed child is owned by a different agent', async () => {
    const delegation = {
      tokenHash: MOCK_TOKEN_HASH,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: 'existing-child-id',
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const claimSpy = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      status: 'claimed',
      claim: {
        claimId: 'rdclm_abcdefghijklmnopqrstu1',
      },
    });
    const mockSessionService = {
      claimRunbook: claimSpy,
    } as unknown as SessionService;

    const ctx = {
      output: {} as unknown as OutputEmitter,
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
      expect(result.claimId).toBe('rdclm_abcdefghijklmnopqrstu1');
    }
  });

  it('rejects orphan adoption when the orphan is owned by a different agent', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
      substepStates: [
        {
          id: '1',
          status: 'pending',
          delegation,
        },
      ],
    });

    const orphanState = makeState('orphan-id', {
      parentLinkage: {
        kind: 'delegation',
        parentRunId: 'parent-id',
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const claimSpy = mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      status: 'claimed',
      claim: {
        claimId: 'rdclm_abcdefghijklmnopqrstu1',
      },
    });
    const mockSessionService = {
      claimRunbook: claimSpy,
    } as unknown as SessionService;

    const ctx = {
      output: {} as unknown as OutputEmitter,
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
      expect(result.claimId).toBe('rdclm_abcdefghijklmnopqrstu1');
    }
  });

  it('launches new child when no orphan exists', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

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
      'child.md',
      expect.anything(),
      expect.objectContaining({
        parentLinkage: expect.objectContaining({
          kind: 'delegation',
          parentRunId: 'parent-id',
          tokenHash,
        }),
      }),
    );
  });

  it('preserves ContextId but does not inherit parent RunId into child vars', async () => {
    const tokenHash = MOCK_TOKEN_HASH;
    const delegation = {
      tokenHash,
      childRunbookPath: 'child.md',
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

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

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

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

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
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(resolveRunbookFile).mockResolvedValue(null); // File not found

    const mockManager = {
      load: mockFn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(parentState),
    };
    jest
      .mocked(core.RunbookStateManager)
      .mockImplementation(() => mockManager as unknown as jest.MockedObject<RunbookStateManager>);
    jest.mocked(core.reconstituteContextVars).mockReturnValue({});

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

    const ctx = {
      output: {} as unknown as OutputEmitter,
      manager: mockManager as unknown as RunbookStateManager,
      actorService: {} as unknown as RunbookActorService,
      sessionService: {} as unknown as SessionService,
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
      contextSnapshot: { vars: {}, ancestors: [] },
      childRunId: null,
      createdAt: new Date().toISOString(),
      cancelledAt: null,
    };

    const parentState = makeState('parent-id', {
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

    jest.mocked(core.DelegationLock).mockImplementation(
      () =>
        ({
          acquire: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
          release: mockFn<() => Promise<void>>().mockResolvedValue(undefined),
        }) as unknown as jest.MockedObject<DelegationLock>,
    );

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
      } as unknown as SessionService,
      lifecycleService: makeLifecycle() as unknown as ExecutionLifecycleService,
      cwd: '/test',
    } satisfies RunPipelineContext;

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline.js');
    // cspell:disable-next-line
    await claimAndLaunch(ctx, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(mockCreate).toHaveBeenCalledWith(
      'child.md',
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
