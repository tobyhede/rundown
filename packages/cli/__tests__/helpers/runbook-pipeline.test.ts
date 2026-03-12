import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { mockErrorHelpers } from './mock-error-helpers';

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
  isSourced: jest.fn(),
  stepHasSubsteps: (step: { kind: string }) => step.kind === 'substeps' || step.kind === 'for',
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
  extractVarsFromMarkdown: jest.fn().mockReturnValue({}),
  resolveVariables: jest.fn().mockResolvedValue({ vars: {}, sources: {} }),
  generateContextId: jest.fn().mockReturnValue('testctx1'),
}));

// Mock template-renderer
jest.unstable_mockModule('../../src/services/template-renderer', () => ({
  substituteRunbookVariables: jest.fn((runbook: unknown) => runbook),
  expandForClauseVariables: jest.fn((content: string) => content),
  expandLoopVariables: jest.fn((text: string) => text),
  warnUnresolvedRunbookVariables: jest.fn(),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE'),
}));

// Import after mocking
const core = await import('@rundown-org/core');
const parser = await import('@rundown-org/parser');
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { runExecutionLoop, buildStepVariables } = await import('../../src/services/execution');
const { createBridgedEmitter } = await import('../../src/helpers/execution-emitter');
const { FileSourcePolicyError, extractVarsFromMarkdown, resolveVariables, generateContextId } =
  await import('../../src/services/variable-discovery');
const { substituteRunbookVariables, expandForClauseVariables, expandLoopVariables } = await import(
  '../../src/services/template-renderer'
);
const fsPromises = await import('node:fs/promises');
const { validateSources, prepareRunbook, startRunbook } = await import(
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
  (extractVarsFromMarkdown as jest.Mock).mockReturnValue({});
  (resolveVariables as jest.Mock).mockResolvedValue({ vars: {}, sources: {} });
  (buildStepVariables as jest.Mock).mockReturnValue({ Step: '1.1' });
  (substituteRunbookVariables as jest.Mock).mockImplementation((runbook: unknown) => runbook);
  (expandForClauseVariables as jest.Mock).mockImplementation((content: string) => content);
  (expandLoopVariables as jest.Mock).mockImplementation((text: string) => text);
  (fsPromises.readFile as jest.Mock).mockResolvedValue('# Test\n\n## 1. Step\n- PASS CONTINUE');
  (generateContextId as jest.Mock).mockReturnValue('testctx1');
  (core.hashDelegationToken as jest.Mock).mockReturnValue('sha256:mock');
  (core.reconstituteContextVars as jest.Mock).mockReturnValue({});
  (core.deriveActiveFrame as jest.Mock).mockReturnValue({
    step: '1',
    substep: undefined,
    iteration: undefined,
    frameKey: '1',
  });
});

describe('validateSources', () => {
  it('passes when no FOR clauses', () => {
    expect(() => validateSources([makeStep()], {})).not.toThrow();
  });

  it('passes when sourced FOR clause has defined source', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);

    const step = { kind: 'for', forClause: { source: 'items' } };
    expect(() => validateSources([step as any], { items: ['a', 'b'] })).not.toThrow();
  });

  it('throws when sourced FOR clause references undefined source', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);

    const step = { kind: 'for', forClause: { source: 'missing' } };
    expect(() => validateSources([step as any], {})).toThrow(
      'FOR loop references undefined data source "{{missing}}"',
    );
  });

  it('skips non-sourced FOR clauses', () => {
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(false);

    const step = { kind: 'for', forClause: { variable: 'i', start: 1, end: 5 } };
    expect(() => validateSources([step as any], {})).not.toThrow();
  });
});

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
    resolveRunbookFile.mockResolvedValue('/test/empty.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [] } as any);

    const result = await prepareRunbook('empty.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('no steps');
    }
  });

  it('returns prepared runbook on success', async () => {
    resolveRunbookFile.mockResolvedValue('/test/good.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);

    const result = await prepareRunbook('good.md', {}, '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prepared.filePath).toBe('/test/good.md');
      expect(result.prepared.runbook.steps).toHaveLength(1);
    }
  });

  it('adds context.vars aliases to merged template variables', async () => {
    resolveRunbookFile.mockResolvedValue('/test/good.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { region: 'us-west' },
      sources: {},
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
    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: {},
      sources: {},
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
    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
    (resolveVariables as jest.Mock).mockResolvedValue({
      vars: { Region: 'eu-central' },
      sources: {},
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

  it('returns error when validateSources throws', async () => {
    resolveRunbookFile.mockResolvedValue('/test/sourced.md');
    (parser.isSourced as jest.MockedFunction<typeof parser.isSourced>).mockReturnValue(true);
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({
      steps: [makeStep({ forClause: { source: 'missing' } })],
    } as any);

    const result = await prepareRunbook('sourced.md', {}, '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('missing');
    }
  });

  it('returns POLICY_DENIED when file-backed variable resolution is blocked by policy', async () => {
    resolveRunbookFile.mockResolvedValue('/test/good.md');
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

  it('injects ContextId when not present in mergedVariables', async () => {
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'ctx-id',
      title: 'Test',
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockInitState = jest.fn<any>().mockResolvedValue(undefined);
    const mockPushRunbook = jest.fn<any>().mockResolvedValue(undefined);

    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: { flush: jest.fn() } as any,
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

    await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

    expect(mockCreate).toHaveBeenCalledWith(
      'runbook.md',
      expect.anything(),
      expect.objectContaining({
        templateVars: expect.objectContaining({
          ContextId: 'testctx1',
          'context.vars.ContextId': 'testctx1',
        }),
      }),
    );
  });

  it('preserves explicit ContextId from --var', async () => {
    const mockCreate = jest.fn<any>().mockResolvedValue({
      id: 'ctx-id',
      title: 'Test',
    });
    const mockUpdate = jest.fn<any>().mockResolvedValue(undefined);
    const mockInitState = jest.fn<any>().mockResolvedValue(undefined);
    const mockPushRunbook = jest.fn<any>().mockResolvedValue(undefined);

    runExecutionLoop.mockResolvedValue('done');

    const ctx = {
      output: { flush: jest.fn() } as any,
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
      mergedVariables: { ContextId: 'sprint-42' },
      sources: {},
    };

    await startRunbook(ctx as any, prepared, { file: 'runbook.md' });

    expect(mockCreate).toHaveBeenCalledWith(
      'runbook.md',
      expect.anything(),
      expect.objectContaining({
        templateVars: expect.objectContaining({
          ContextId: 'sprint-42',
        }),
      }),
    );
    expect(generateContextId).not.toHaveBeenCalled();
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

    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
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
        delegation: expect.objectContaining({
          parentRunId: 'parent-id',
          tokenHash,
        }),
      }),
    );
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

    resolveRunbookFile.mockResolvedValue('/test/child.md');
    (
      core.parseRunbookDocument as jest.MockedFunction<typeof core.parseRunbookDocument>
    ).mockReturnValue({ steps: [makeStep()] } as any);
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
