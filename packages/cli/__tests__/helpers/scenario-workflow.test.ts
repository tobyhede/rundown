import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock resolve-runbook
jest.unstable_mockModule('../../src/helpers/resolve-runbook', () => ({
  resolveRunbookFile: jest.fn(),
}));

// Mock @rundown-org/parser (only extractFrontmatter, pass through rest)
const actualParser = await import('@rundown-org/parser');
jest.unstable_mockModule('@rundown-org/parser', () => ({
  ...actualParser,
  extractFrontmatter: jest.fn(),
}));

// Mock scenarios schema — include all exports used by scenario-runbook
jest.unstable_mockModule('../../src/schemas/scenarios', () => ({
  parseScenarios: jest.fn(),
  getEffectiveResult: jest.fn().mockImplementation((s: any) => s.result ?? s.expect?.result),
}));

// Mock node:fs/promises
const actualFsPromises = await import('node:fs/promises');
jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsPromises,
  readFile: jest.fn(),
  rm: jest.fn().mockResolvedValue(undefined),
}));

// Mock node:fs (sync functions used by executeScenario)
const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  mkdtempSync: jest.fn().mockReturnValue('/tmp/rd-scenario-test'),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn(),
}));

// Mock shell-quote
jest.unstable_mockModule('shell-quote', () => ({
  parse: jest.fn().mockImplementation((str: string) => str.split(/\s+/)),
}));

// Mock command-sequence (pass through extract helpers so extractReferencedRunbooks/input-file copying works)
const actualCommandSequence = await import('../../src/helpers/command-sequence');
jest.unstable_mockModule('../../src/helpers/command-sequence', () => ({
  executeCommandSequence: jest.fn(),
  matchStepAssertions: jest.fn(),
  extractRunbookReferences: actualCommandSequence.extractRunbookReferences,
  extractInputFileReferences: actualCommandSequence.extractInputFileReferences,
}));

// Import after mocking
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook');
const { extractFrontmatter } = await import('@rundown-org/parser');
const { parseScenarios } = await import('../../src/schemas/scenarios');
const { readFile, rm } = await import('node:fs/promises');
const { copyFileSync } = await import('node:fs');
const { executeCommandSequence, matchStepAssertions } = await import(
  '../../src/helpers/command-sequence'
);
const {
  loadScenarios,
  buildScenarioListRows,
  buildScenarioDetail,
  extractReferencedRunbooks,
  executeScenario,
} = await import('../../src/helpers/scenario-workflow');

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
    resolveRunbookFile.mockResolvedValue({ path: '/test/runbook.md', source: 'project' });
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue('# No frontmatter' as any);
    extractFrontmatter.mockReturnValue({ frontmatter: null, content: '# No frontmatter' });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('No frontmatter');
    }
  });

  it('returns error with validation details', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/runbook.md', source: 'project' });
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nscenarios: bad\n---' as any,
    );
    extractFrontmatter.mockReturnValue({ frontmatter: { scenarios: 'bad' }, content: '' });
    parseScenarios.mockReturnValue({ scenarios: null, errors: ['Field "commands" is required'] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(['Field "commands" is required']);
    }
  });

  it('returns error when no scenarios defined', async () => {
    resolveRunbookFile.mockResolvedValue({ path: '/test/runbook.md', source: 'project' });
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nname: test\n---' as any,
    );
    extractFrontmatter.mockReturnValue({ frontmatter: { name: 'test' }, content: '' });
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

    resolveRunbookFile.mockResolvedValue({ path: '/test/runbook.md', source: 'project' });
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nname: my-runbook\n---' as any,
    );
    extractFrontmatter.mockReturnValue({
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

    resolveRunbookFile.mockResolvedValue({ path: '/test/runbook.md', source: 'project' });
    (readFile as jest.MockedFunction<typeof readFile>).mockResolvedValue(
      '---\nscenarios:\n---' as any,
    );
    extractFrontmatter.mockReturnValue({ frontmatter: {}, content: '' });
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
        expect: { result: 'COMPLETE' },
      },
    } as any;

    const detail = buildScenarioDetail('rich', scenarios);

    expect(detail?.expect).toEqual({ result: 'COMPLETE' });
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

  it('strips double quotes from runbook filenames', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd run --prompted "child.runbook.md"'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['child.runbook.md']);
  });

  it('strips single quotes from runbook filenames', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ["rd run --prompted 'child.runbook.md'"],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['child.runbook.md']);
  });

  it('extracts paths with slashes', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd delegate delegation/child.runbook.md --step 1'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['delegation/child.runbook.md']);
  });

  it('extracts filenames with hyphens', () => {
    const scenario: any = {
      result: 'COMPLETE',
      commands: ['rd run my-cool-thing.runbook.md'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['my-cool-thing.runbook.md']);
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

  it('returns passed when terminalResult matches expected', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'COMPLETE',
      transitions: [],
      capturedTokens: [],
    });

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
  });

  it('returns failed when terminalResult does not match expected', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'STOP',
      transitions: [],
      capturedTokens: [],
    });

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

  it('evaluates step assertions when expect.steps present', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'COMPLETE',
      transitions: [{ action: 'CONTINUE', from: '1', at: '2', result: 'PASS' }],
      capturedTokens: [],
    });
    jest.mocked(matchStepAssertions).mockReturnValue([
      {
        assertion: { at: '2', action: 'CONTINUE' },
        matched: true,
        matchedEvent: { action: 'CONTINUE', at: '2' },
      },
    ]);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', steps: [{ at: '2', action: 'CONTINUE' }] },
    });

    const result = await executeScenario(
      loaded as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(true);
    expect(result.stepAssertions).toBeDefined();
    expect(result.stepAssertions![0].matched).toBe(true);
  });

  it('fails when step assertion does not match', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'COMPLETE',
      transitions: [],
      capturedTokens: [],
    });
    jest
      .mocked(matchStepAssertions)
      .mockReturnValue([{ assertion: { at: '3', action: 'COMPLETE' }, matched: false }]);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', steps: [{ at: '3', action: 'COMPLETE' }] },
    });

    const result = await executeScenario(
      loaded as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(false);
    expect(result.stepAssertions![0].matched).toBe(false);
  });

  it('passes executeCommandSequence correct options', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'COMPLETE',
      transitions: [],
      capturedTokens: [],
    });

    await executeScenario(
      makeLoadedRunbook() as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(executeCommandSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['rd run my.runbook.md', 'rd pass'],
        cliPath: '/cli/dist/cli.js',
        quiet: true,
      }),
    );
  });

  it('cleans up temp directory after execution', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue({
      terminalResult: 'COMPLETE',
      transitions: [],
      capturedTokens: [],
    });

    await executeScenario(
      makeLoadedRunbook() as any,
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(rm).toHaveBeenCalledWith('/tmp/rd-scenario-test', {
      recursive: true,
      force: true,
    });
  });

  it('throws informative error when referenced child runbook is missing', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    jest.mocked(copyFileSync).mockImplementation((src: any) => {
      // Succeed for main runbook, throw ENOENT for child
      if (String(src).includes('child.runbook.md')) {
        throw enoentError;
      }
    });

    const loaded = makeLoadedRunbook({
      commands: ['rd run my.runbook.md', 'rd delegate child.runbook.md --step 1'],
    });

    await expect(
      executeScenario(loaded as any, 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(/Referenced runbook not found: child\.runbook\.md/);

    await expect(
      executeScenario(loaded as any, 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(/searched in:/);
  });
});
