import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock resolve-runbook
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: jest.fn(),
}));

// Mock extract-raw-frontmatter
jest.unstable_mockModule('../../src/helpers/extract-raw-frontmatter', () => ({
  extractRawFrontmatter: jest.fn(),
}));

// Mock scenarios schema — include all exports used by scenario-runbook
jest.unstable_mockModule('../../src/schemas/scenarios', () => ({
  parseScenarios: jest.fn(),
  getEffectiveResult: jest.fn().mockImplementation((s: any) => s.result ?? s.expect?.result),
}));

// Mock node:fs/promises
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn(),
  rm: jest.fn().mockResolvedValue(undefined),
}));

// Mock node:fs (sync functions used by executeScenario)
jest.unstable_mockModule('node:fs', () => ({
  mkdtempSync: jest.fn().mockReturnValue('/tmp/rd-scenario-test'),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn(),
  readdirSync: jest.fn().mockReturnValue([]),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
}));

// Mock node:child_process
jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: jest.fn(),
  execSync: jest.fn(),
}));

// Mock shell-quote
jest.unstable_mockModule('shell-quote', () => ({
  parse: jest.fn().mockImplementation((str: string) => str.split(/\s+/)),
}));

// Import after mocking
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { extractRawFrontmatter } = await import('../../src/helpers/extract-raw-frontmatter');
const { parseScenarios } = await import('../../src/schemas/scenarios');
const { readFile, rm } = await import('node:fs/promises');
const { readdirSync, readFileSync, statSync } = await import('node:fs');
const { execFileSync } = await import('node:child_process');
const {
  loadScenarios,
  buildScenarioListRows,
  buildScenarioDetail,
  extractReferencedRunbooks,
  executeScenario,
  evaluateExpectations,
} = await import('../../src/helpers/scenario-runbook');

// Types are inferred from mocked modules; use `any` casts where needed

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loadScenarios', () => {
  it('returns error when file not found', async () => {
    resolveRunbookFile.mockResolvedValue(null);

    const result = await loadScenarios('missing.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('returns error when no frontmatter', async () => {
    resolveRunbookFile.mockResolvedValue('/test/runbook.md');
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue('# No frontmatter' as any);
    extractRawFrontmatter.mockReturnValue({ frontmatter: null, content: '# No frontmatter' });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('No frontmatter');
    }
  });

  it('returns error with validation details', async () => {
    resolveRunbookFile.mockResolvedValue('/test/runbook.md');
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nscenarios: bad\n---' as any,
    );
    extractRawFrontmatter.mockReturnValue({ frontmatter: { scenarios: 'bad' }, content: '' });
    parseScenarios.mockReturnValue({ scenarios: null, errors: ['Field "commands" is required'] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(['Field "commands" is required']);
    }
  });

  it('returns error when no scenarios defined', async () => {
    resolveRunbookFile.mockResolvedValue('/test/runbook.md');
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nname: test\n---' as any,
    );
    extractRawFrontmatter.mockReturnValue({ frontmatter: { name: 'test' }, content: '' });
    parseScenarios.mockReturnValue({ scenarios: null, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No scenarios');
    }
  });

  it('returns loaded runbook on success', async () => {
    const scenarios: any = {
      happy: {
        result: 'COMPLETE',
        commands: ['rd run test.md', 'rd pass'],
        description: 'Happy path',
      },
    };

    resolveRunbookFile.mockResolvedValue('/test/runbook.md');
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nname: my-runbook\n---' as any,
    );
    extractRawFrontmatter.mockReturnValue({
      frontmatter: { name: 'my-runbook', scenarios },
      content: '',
    });
    parseScenarios.mockReturnValue({ scenarios, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.name).toBe('my-runbook');
      expect(result.loaded.filePath).toBe('/test/runbook.md');
      expect(result.loaded.scenarios).toBe(scenarios);
    }
  });

  it('uses file as name when frontmatter has no name', async () => {
    const scenarios: any = {
      test: { result: 'COMPLETE', commands: ['rd run x.md'] },
    };

    resolveRunbookFile.mockResolvedValue('/test/runbook.md');
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nscenarios:\n---' as any,
    );
    extractRawFrontmatter.mockReturnValue({ frontmatter: {}, content: '' });
    parseScenarios.mockReturnValue({ scenarios, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.name).toBe('runbook.md');
    }
  });
});

describe('buildScenarioListRows', () => {
  it('maps scenarios to row objects', () => {
    const scenarios: any = {
      happy: { result: 'COMPLETE', commands: ['rd run x.md'], description: 'Happy path' },
      sad: { result: 'STOP', commands: ['rd run x.md'] },
    };

    const rows = buildScenarioListRows(scenarios);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'happy',
      expected: 'COMPLETE',
      description: 'Happy path',
      tags: '',
    });
    expect(rows[1]).toEqual({
      name: 'sad',
      expected: 'STOP',
      description: '',
      tags: '',
    });
  });

  it('joins tags with commas', () => {
    const scenarios = {
      tagged: {
        result: 'COMPLETE',
        commands: ['rd run x.md'],
        tags: ['smoke', 'regression'],
      },
    } as any;

    const rows = buildScenarioListRows(scenarios);

    expect(rows[0].tags).toBe('smoke, regression');
  });
});

describe('buildScenarioDetail', () => {
  it('returns null for missing scenario', () => {
    const scenarios: any = {
      exists: { result: 'COMPLETE', commands: ['rd run x.md'] },
    };

    expect(buildScenarioDetail('missing', scenarios)).toBeNull();
  });

  it('returns detail for existing scenario', () => {
    const scenarios: any = {
      happy: { result: 'COMPLETE', commands: ['rd run x.md', 'rd pass'], description: 'Works' },
    };

    const detail = buildScenarioDetail('happy', scenarios);

    expect(detail).toMatchObject({
      name: 'happy',
      description: 'Works',
      expected: 'COMPLETE',
      commands: ['rd run x.md', 'rd pass'],
      tags: undefined,
    });
  });

  it('includes tags when present', () => {
    const scenarios = {
      tagged: {
        result: 'COMPLETE',
        commands: ['rd run x.md'],
        tags: ['smoke'],
      },
    } as any;

    const detail = buildScenarioDetail('tagged', scenarios);

    expect(detail?.tags).toEqual(['smoke']);
  });

  it('includes expect block when present', () => {
    const scenarios = {
      rich: {
        result: 'COMPLETE',
        commands: ['rd run x.md', 'rd pass'],
        expect: { result: 'COMPLETE', finalStep: '2' },
      },
    } as any;

    const detail = buildScenarioDetail('rich', scenarios);

    expect(detail?.expect).toEqual({ result: 'COMPLETE', finalStep: '2' });
  });
});

describe('extractReferencedRunbooks', () => {
  it('extracts runbook filenames from commands', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd pass'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['main.runbook.md']);
  });

  it('deduplicates references', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd run main.runbook.md'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['main.runbook.md']);
  });

  it('extracts multiple unique references', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd delegate child.runbook.md --step 2'],
    };

    const refs = extractReferencedRunbooks(scenario);
    expect(refs).toContain('main.runbook.md');
    expect(refs).toContain('child.runbook.md');
    expect(refs).toHaveLength(2);
  });

  it('returns empty array when no runbook references', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd pass', 'rd fail'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual([]);
  });
});

describe('evaluateExpectations', () => {
  it('passes when all expectations match', () => {
    const state = {
      step: '3',
      retryCount: 0,
      lastAction: { type: 'COMPLETE' },
      lastResult: 'pass',
      steps: [{ status: 'complete' }, { status: 'complete' }, { status: 'pending' }],
      variables: { completed: true },
    };

    const result = evaluateExpectations(state, {
      finalStep: '3',
      stepsCompleted: 2,
      lastAction: 'COMPLETE',
      lastResult: 'pass',
      retryCount: 0,
      variables: { completed: true },
    });

    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(6);
    expect(result.assertions.every((a) => a.passed)).toBe(true);
  });

  it('fails when finalStep does not match', () => {
    const state = { step: '2' };

    const result = evaluateExpectations(state, { finalStep: '3' });

    expect(result.passed).toBe(false);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]).toEqual({
      field: 'finalStep',
      expected: '3',
      actual: '2',
      passed: false,
    });
  });

  it('fails when stepsCompleted does not match', () => {
    const state = {
      steps: [{ status: 'complete' }, { status: 'pending' }],
    };

    const result = evaluateExpectations(state, { stepsCompleted: 2 });

    expect(result.passed).toBe(false);
    expect(result.assertions[0].actual).toBe(1);
  });

  it('checks lastAction type', () => {
    const state = { lastAction: { type: 'STOP' } };

    const result = evaluateExpectations(state, { lastAction: 'COMPLETE' });

    expect(result.passed).toBe(false);
    expect(result.assertions[0]).toMatchObject({
      field: 'lastAction',
      expected: 'COMPLETE',
      actual: 'STOP',
      passed: false,
    });
  });

  it('checks lastResult', () => {
    const state = { lastResult: 'fail' };

    const result = evaluateExpectations(state, { lastResult: 'pass' });

    expect(result.passed).toBe(false);
  });

  it('checks retryCount', () => {
    const state = { retryCount: 2 };

    const result = evaluateExpectations(state, { retryCount: 0 });

    expect(result.passed).toBe(false);
    expect(result.assertions[0]).toMatchObject({
      field: 'retryCount',
      expected: 0,
      actual: 2,
    });
  });

  it('checks individual variables', () => {
    const state = { variables: { completed: true, count: 5 } };

    const result = evaluateExpectations(state, {
      variables: { completed: true, count: 3 },
    });

    expect(result.passed).toBe(false);
    expect(result.assertions).toHaveLength(2);
    expect(result.assertions[0].passed).toBe(true); // completed matches
    expect(result.assertions[1].passed).toBe(false); // count doesn't match
  });

  it('returns empty assertions for empty expect', () => {
    const state = { step: '1' };

    const result = evaluateExpectations(state, {});

    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(0);
  });
});

describe('executeScenario', () => {
  const mockOutput = {
    message: jest.fn(),
    flush: jest.fn(),
  } as any;

  function makeLoadedRunbook(scenarioOverrides: Record<string, any> = {}) {
    return {
      filePath: '/test/patterns/my.runbook.md',
      name: 'my-runbook',
      description: 'Test runbook',
      scenarios: {
        happy: {
          result: 'COMPLETE',
          commands: ['rd run my.runbook.md', 'rd pass'],
          ...scenarioOverrides,
        },
      },
    };
  }

  it('returns passed for COMPLETE scenario when state shows completed', async () => {
    (readdirSync as jest.MockedFunction<typeof readdirSync>).mockReturnValue([
      'wf-test.json',
    ] as any);
    (readFileSync as jest.MockedFunction<typeof readFileSync>).mockReturnValue(
      JSON.stringify({ variables: { completed: true } }),
    );
    (statSync as jest.MockedFunction<typeof statSync>).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    const result = await executeScenario(
      makeLoadedRunbook() as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(true);
    expect(result.expected).toBe('COMPLETE');
    expect(result.actual).toBe('COMPLETE');
    expect(execFileSync).toHaveBeenCalled();
    expect(rm).toHaveBeenCalled();
  });

  it('returns passed for STOP scenario when state shows stopped', async () => {
    const loaded = {
      filePath: '/test/patterns/my.runbook.md',
      name: 'my-runbook',
      description: 'Test runbook',
      scenarios: {
        stop: {
          result: 'STOP',
          commands: ['rd run my.runbook.md', 'rd stop'],
        },
      },
    };

    (readdirSync as jest.MockedFunction<typeof readdirSync>).mockReturnValue([
      'wf-test.json',
    ] as any);
    (readFileSync as jest.MockedFunction<typeof readFileSync>).mockReturnValue(
      JSON.stringify({ variables: { stopped: true } }),
    );
    (statSync as jest.MockedFunction<typeof statSync>).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    const result = await executeScenario(
      loaded as any,
      'stop',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(true);
    expect(result.expected).toBe('STOP');
    expect(result.actual).toBe('STOP');
  });

  it('returns failed when actual does not match expected', async () => {
    (readdirSync as jest.MockedFunction<typeof readdirSync>).mockReturnValue([
      'wf-test.json',
    ] as any);
    (readFileSync as jest.MockedFunction<typeof readFileSync>).mockReturnValue(
      JSON.stringify({ variables: { stopped: true } }),
    );
    (statSync as jest.MockedFunction<typeof statSync>).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    const result = await executeScenario(
      makeLoadedRunbook() as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(false);
    expect(result.expected).toBe('COMPLETE');
    expect(result.actual).toBe('STOP');
  });

  it('includes assertions when expect block is present', async () => {
    (readdirSync as jest.MockedFunction<typeof readdirSync>).mockReturnValue([
      'wf-test.json',
    ] as any);
    (readFileSync as jest.MockedFunction<typeof readFileSync>).mockReturnValue(
      JSON.stringify({
        variables: { completed: true },
        step: '2',
        lastAction: { type: 'COMPLETE' },
      }),
    );
    (statSync as jest.MockedFunction<typeof statSync>).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', finalStep: '2', lastAction: 'COMPLETE' },
    });

    const result = await executeScenario(
      loaded as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(true);
    expect(result.assertions).toBeDefined();
    expect(result.assertions!.length).toBeGreaterThan(0);
    expect(result.assertions!.every((a) => a.passed)).toBe(true);
  });

  it('fails when expect assertions do not match', async () => {
    (readdirSync as jest.MockedFunction<typeof readdirSync>).mockReturnValue([
      'wf-test.json',
    ] as any);
    (readFileSync as jest.MockedFunction<typeof readFileSync>).mockReturnValue(
      JSON.stringify({
        variables: { completed: true },
        step: '1',
        lastAction: { type: 'CONTINUE' },
      }),
    );
    (statSync as jest.MockedFunction<typeof statSync>).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', finalStep: '3', lastAction: 'COMPLETE' },
    });

    const result = await executeScenario(
      loaded as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(false);
    expect(result.assertions).toBeDefined();
    expect(result.assertions!.some((a) => !a.passed)).toBe(true);
  });
});
