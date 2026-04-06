import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers.js';

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
  RunbookStateManager: jest.fn(),
  loadPolicy: jest.fn(),
  DelegationScanService: jest.fn(),
  DelegationLock: jest.fn(),
  reconstituteContextVars: jest.fn().mockReturnValue({}),
  extractInheritedUserVars: jest.fn(),
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
  isJsonArray: jest.fn((v: unknown) => Array.isArray(v)),
  isJsonArrayStream: jest.fn(
    (v: unknown) =>
      typeof v === 'object' &&
      v !== null &&
      (v as Record<string, unknown>).kind === 'json-array-stream',
  ),
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
  buildStepVariables: jest.fn().mockReturnValue({ Step: '1.1' }),
  runExecutionLoop: jest.fn().mockResolvedValue('done'),
}));

// Mock execution-emitter
jest.unstable_mockModule('../../src/helpers/execution-emitter', () => ({
  createBridgedEmitter: jest.fn().mockReturnValue({
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
  resolveVariables: jest
    .fn()
    .mockResolvedValue({ vars: {}, sources: {}, warnings: [], providedKeys: new Set() }),
  RUNTIME_RESERVED_VARIABLES: new Set(['step', 'index', 'context']),
  isRuntimeReservedVariable: jest.fn().mockReturnValue(false),
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
  validateRequiredVars: jest.fn().mockReturnValue([]),
}));

// Mock node:fs/promises
const actualFsPromises = await import('node:fs/promises');
jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsPromises,
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE'),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { runExecutionLoop, buildStepVariables } = await import('../../src/services/execution');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter');
const { FileSourcePolicyError, resolveVariables } = await import(
  '../../src/services/variable-discovery'
);
const {
  substituteRunbookVariables,
  resolveForBounds,
  expandLoopVariables,
  warnUnresolvedRunbookVariables,
  collectUnresolvedRunbookVariables,
} = await import('../../src/services/template-renderer');
const { validateFrontmatterVars, validateRequiredVars } = await import(
  '../../src/helpers/validate-frontmatter-vars'
);
const fsPromises = await import('node:fs/promises');
const { prepareRunbook, startRunbook, buildContextVars, buildTemplateVars } = await import(
  '../../src/helpers/runbook-pipeline'
);

function makeState(id: string, overrides: Record<string, unknown> = {}): any {
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

function makeStep(overrides: Record<string, unknown> = {}): any {
  const obj = {
    name: '1',
    description: 'Test Step',
    transitions: {
      pass: { action: 'continue' as const, retry: 0 },
      fail: { action: 'continue' as const, retry: 0 },
    },
    ...overrides,
  };
  const kind =
    obj.forClause !== undefined
      ? 'for'
      : Array.isArray(obj.substeps) && (obj.substeps as unknown[]).length > 0
        ? 'substeps'
        : obj.command !== undefined
          ? 'command'
          : 'base';
  return { ...obj, kind } as any;
}

function mockParseResult(overrides: Record<string, unknown> = {}): any {
  return {
    runbook: { steps: [makeStep()] },
    frontmatter: null,
    diagnostics: [],
    ...overrides,
  };
}

function makeLifecycle(overrides: Record<string, unknown> = {}): any {
  return {
    ensureActiveEntry: jest
      .fn<any>()
      .mockImplementation(async (_id: string, _prev: unknown, state: any) => ({
        state: {
          ...(state ?? {}),
          activeEntry: state?.activeEntry ?? 1,
          activeFrameKey: state?.activeFrameKey ?? `${String(state?.step ?? '1')}|`,
        },
        frameKey: state?.activeFrameKey ?? `${String(state?.step ?? '1')}|`,
        entry: state?.activeEntry ?? 1,
      })),
    buildTargetFrameKey: jest
      .fn<any>()
      .mockImplementation(
        (step: string, iteration?: number) =>
          `${step}|${iteration != null ? String(iteration) : ''}`,
      ),
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-establish default mock implementations after reset
  (runExecutionLoop as jest.Mock).mockResolvedValue('done');
  (core.deriveExecutionAt as jest.Mock).mockImplementation(
    (step: string, substep?: string, iteration?: number) =>
      `${step}${iteration != null ? `.${String(iteration)}` : ''}${substep ? `.${substep}` : ''}`,
  );
  (core.getActiveForContext as jest.Mock).mockReturnValue(null);
  (createBridgedEmitter as jest.Mock).mockReturnValue({ emit: jest.fn() });
  (resolveVariables as jest.Mock).mockResolvedValue({
    vars: {},
    sources: {},
    warnings: [],
    providedKeys: new Set(),
  });
  (buildStepVariables as jest.Mock).mockReturnValue({ Step: '1.1' });
  (substituteRunbookVariables as jest.Mock).mockImplementation((runbook: unknown) => runbook);
  (resolveForBounds as jest.Mock).mockImplementation((runbook: unknown) => ({
    runbook,
    warnings: [],
  }));
  (expandLoopVariables as jest.Mock).mockImplementation((text: string) => text);
  (warnUnresolvedRunbookVariables as jest.Mock).mockReturnValue([]);
  (collectUnresolvedRunbookVariables as jest.Mock).mockReturnValue(new Set());
  (validateFrontmatterVars as jest.Mock).mockReturnValue([]);
  (validateRequiredVars as jest.Mock).mockReturnValue([]);
  (fsPromises.readFile as jest.Mock).mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE');
  (
    parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
  ).mockReturnValue(mockParseResult());
  (core.hashDelegationToken as jest.Mock).mockReturnValue('sha256:mock');
  (core.reconstituteContextVars as jest.Mock).mockReturnValue({});
  (core.extractInheritedUserVars as jest.Mock).mockReturnValue({});
  (core.deriveActiveFrame as jest.Mock).mockReturnValue({
    step: '1',
    substep: undefined,
    iteration: undefined,
    frameKey: '1',
  });
});

// validateSources was removed in the unified variable model refactoring.
// Source validation now happens during variable resolution.

describe('prepareRunbook', () => {
  it('returns error when file not found', async () => {
    resolveRunbookFile.mockResolvedValue(null);

    const result = await prepareRunbook('missing.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('returns error when runbook has no steps', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/empty.md', source: 'project' });
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/good.md', source: 'project' });
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/good.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { region: 'us-west' },
      sources: {},
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/child.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: {},
      sources: {},
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/child.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { Region: 'eu-central' },
      sources: {},
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

  it('passes parser frontmatter vars into variable resolution', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/good.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { vars: { Region: 'us-west' } },
      }),
    );

    await prepareRunbook('good.md', {}, '/test');

    expect(resolveVariables).toHaveBeenCalledWith(
      expect.objectContaining({
        frontmatterVars: { Region: 'us-west' },
      }),
      '/test',
      expect.anything(),
    );
  });

  it('returns VALIDATION_ERROR when frontmatter vars use reserved names', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/reserved.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { vars: { context: 'bad' } },
      }),
    );
    (validateFrontmatterVars as jest.Mock).mockReturnValue([
      {
        severity: 'error',
        message:
          'Frontmatter var "context" uses reserved runtime variable name. Reserved names (case-insensitive): step, index, context',
      },
    ]);

    const result = await prepareRunbook('reserved.md', {}, '/test');

    expect(validateFrontmatterVars).toHaveBeenCalledWith({ context: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('reserved runtime variable name');
    }
  });

  it('returns MISSING_REQUIRED_VARS when required var is not provided', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/needs-var.md', source: 'project' });
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/needs-var.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { required: ['PlanPath'] },
      }),
    );
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { PlanPath: '/some/path' },
      sources: {},
      warnings: [],
      providedKeys: new Set(['PlanPath']),
    });

    const result = await prepareRunbook('needs-var.md', {}, '/test');

    expect(result.ok).toBe(true);
  });

  it('fails when required var exists only as builtin', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/needs-date.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        frontmatter: { required: ['Date'] },
      }),
    );
    // Date is in vars (builtin) but NOT in providedKeys (external layers)
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { Date: '2026-01-01' },
      sources: {},
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/sourced.md', source: 'project' });
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        runbook: {
          steps: [makeStep({ forClause: { source: 'missing' }, substeps: [{ id: '1' }] })],
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/bad-for.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(
      mockParseResult({
        diagnostics: [{ severity: 'error', message: 'bad FOR clause', line: 1, column: 1 }],
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/for-bounds.md', source: 'project' });
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
    (resolveForBounds as jest.Mock).mockImplementation(() => {
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
    resolveRunbookFile.mockResolvedValue({ path: '/test/good.md', source: 'project' });
    (resolveVariables as jest.Mock).mockRejectedValue(
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
    resolveRunbookFile.mockResolvedValue({
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
    resolveRunbookFile.mockResolvedValue({
      path: '/test/.claude/rundown/runbooks/my-runbook.runbook.md',
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

  it('allows --var to override CLAUDE_PLUGIN_ROOT', async () => {
    resolveRunbookFile.mockResolvedValue({
      path: '/home/user/.claude/extensions/rundown-plugin/runbooks/write-plan.runbook.md',
      source: 'plugin' as const,
    });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { CLAUDE_PLUGIN_ROOT: '/custom/override' },
      sources: {},
      warnings: [],
      providedKeys: new Set(['CLAUDE_PLUGIN_ROOT']),
    });

    const result = await prepareRunbook('rundown:write-plan', {}, '/test');

    expect(result.ok).toBe(true);
    // The user's --var override should win over auto-injected value
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
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'new-id',
      title: 'Test',
      substeps: undefined,
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockInitState = jest.fn<any>().mockResolvedValue(undefined);
    const mockPushRunbook = jest.fn<any>().mockResolvedValue(undefined);
    const mockOutput = { flush: jest.fn() };

    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: mockOutput as any,
      manager: {
        create: mockCreate,
        update: mockUpdate,
        initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
      } as any,
      actorService: { initializeState: mockInitState } as any,
      sessionService: { pushRunbook: mockPushRunbook } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep()] } as any,
      mergedVariables: {},
      sources: {},
    };

    const result = await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

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
      }),
    );
    expect(mockInitState).toHaveBeenCalled();
    expect(mockPushRunbook).toHaveBeenCalled();
  });
  it('initializes substeps when first step has substeps', async () => {
    const mockInitSubsteps = jest.fn<any>().mockResolvedValue(undefined);
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'sub-id',
      title: 'Sub Test',
    });

    runExecutionLoop.mockResolvedValue('done');

    const mockLoad = jest.fn<any>().mockResolvedValue({
      id: 'sub-id',
      step: '1',
      activeFrameKey: '1|',
    });

    const ctx = {
      output: { flush: jest.fn() } as any,
      manager: {
        create: mockCreate,
        update: mockUpdate,
        load: mockLoad,
        initializeSubsteps: mockInitSubsteps,
      } as any,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const substeps = [{ id: 'a' }, { id: 'b' }];
    const prepared = {
      filePath: '/test/runbook.md',
      rawContent: '# Test',
      runbook: { steps: [makeStep({ substeps })] } as any,
      mergedVariables: {},
      sources: {},
    };

    const result = await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

    expect(result.ok).toBe(true);
    expect(mockInitSubsteps).toHaveBeenCalledWith('sub-id', substeps, '1|');
    expect(mockUpdate).toHaveBeenCalledWith('sub-id', { substep: 'a' });
  });
});

describe('claimAndLaunch', () => {
  it('returns error when token format is invalid', async () => {
    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    const result = await claimAndLaunch(ctx as any, 'bad-token', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-807');
      expect(result.error).toContain('rdtk_');
    }
  });

  it('returns error when token not found', async () => {
    const mockScanner = {
      findByToken: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const ctx = {
      output: {} as any,
      manager: {} as any,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-808');
    }
  });

  it('returns idempotent result when token already claimed', async () => {
    const delegation = {
      tokenHash: 'sha256:mock',
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('existing-child-id');
      expect(result.loopResult).toBe('waiting');
    }
  });

  it('returns error when delegation was cancelled', async () => {
    const delegation = {
      tokenHash: 'sha256:mock',
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RD-809');
    }
  });

  it('adopts orphaned child when found', async () => {
    const tokenHash = 'sha256:mock';
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(orphanState),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      update: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.childRunId).toBe('orphan-id');
    }
    expect(mockManager.update).toHaveBeenCalled();
  });

  it('launches new child when no orphan exists', async () => {
    const tokenHash = 'sha256:mock';
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue({ path: '/test/child.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'new-child-id',
      title: 'Child',
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      create: mockCreate,
      update: mockUpdate,
      initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    runExecutionLoop.mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: mockManager,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

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
    const tokenHash = 'sha256:mock';
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue({ path: '/test/child.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { RunId: 'child-run', ContextId: 'ctx-parent', Region: 'us-west' },
      sources: {},
      warnings: [],
      providedKeys: new Set(['RunId', 'ContextId', 'Region']),
    });

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      create: jest.fn<any>().mockResolvedValue({
        id: 'new-child-id',
        title: 'Child',
      }),
      update: jest.fn<any>().mockResolvedValue(undefined),
      initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    (core.DelegationLock as jest.Mock).mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));

    runExecutionLoop.mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: mockManager,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    (core.extractInheritedUserVars as jest.Mock).mockReturnValue({
      ContextId: 'ctx-parent',
      Region: 'us-west',
    });

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(true);
    const resolveCall = (resolveVariables as jest.Mock).mock.calls.at(-1);
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

  it('returns error when child runbook file not found', async () => {
    const tokenHash = 'sha256:mock';
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue(null); // File not found

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    const ctx = {
      output: {} as any,
      manager: mockManager,
      actorService: {} as any,
      sessionService: {} as any,
      lifecycleService: {} as any,
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    const result = await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('inherits prompted flag from parent', async () => {
    const tokenHash = 'sha256:mock';
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
      findByToken: jest
        .fn<any>()
        .mockResolvedValue({ parentState, stepId: '1', substepId: '1', delegation }),
      findOrphanedChild: jest.fn<any>().mockResolvedValue(null),
    };
    (core.DelegationScanService as jest.Mock).mockImplementation(() => mockScanner);

    resolveRunbookFile.mockResolvedValue({ path: '/test/child.md', source: 'project' });
    (
      parser.parseRunbookDocument as jest.MockedFunction<typeof parser.parseRunbookDocument>
    ).mockReturnValue(mockParseResult());
    (core.reconstituteContextVars as jest.Mock).mockReturnValue({});

    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'child-id',
      title: 'Child',
    });

    const mockManager = {
      load: jest.fn<any>().mockResolvedValue(parentState),
      create: mockCreate,
      update: jest.fn<any>().mockResolvedValue(undefined),
      initializeSubsteps: jest.fn<any>().mockResolvedValue(undefined),
    };
    (core.RunbookStateManager as jest.Mock).mockImplementation(() => mockManager);

    const mockLock = jest.fn().mockImplementation(() => ({
      acquire: jest.fn<any>().mockResolvedValue(undefined),
      release: jest.fn<any>().mockResolvedValue(undefined),
    }));
    (core.DelegationLock as jest.Mock).mockImplementation(mockLock);

    runExecutionLoop.mockResolvedValue('waiting');

    const ctx = {
      output: { status: jest.fn(), flush: jest.fn() } as any,
      manager: mockManager,
      actorService: { initializeState: jest.fn<any>().mockResolvedValue(undefined) } as any,
      sessionService: { pushRunbook: jest.fn<any>().mockResolvedValue(undefined) } as any,
      lifecycleService: makeLifecycle(),
      cwd: '/test',
    };

    const { claimAndLaunch } = await import('../../src/helpers/runbook-pipeline');
    // cspell:disable-next-line
    await claimAndLaunch(ctx as any, 'rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', {});

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
