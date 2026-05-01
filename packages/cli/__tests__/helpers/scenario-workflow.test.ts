import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Scenario, Scenarios } from '../../src/schemas/scenarios.js';
import type {
  CapturedTransition,
  CommandSequenceResult,
} from '../../src/helpers/command-sequence.js';
import type { OutputEmitter } from '../../src/services/output-emitter.js';
import { mockFn } from './typed-mocks.js';

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
jest.unstable_mockModule('../../src/schemas/scenarios', () => {
  const getEffectiveResultMock =
    mockFn<
      (s: {
        result?: 'COMPLETE' | 'STOP';
        expect?: { result?: 'COMPLETE' | 'STOP' };
      }) => 'COMPLETE' | 'STOP'
    >();
  getEffectiveResultMock.mockImplementation((s) => {
    const r = s.result ?? s.expect?.result;
    if (r === undefined) {
      throw new Error('Neither result nor expect.result is defined');
    }
    return r;
  });
  return {
    parseScenarios: jest.fn(),
    getEffectiveResult: getEffectiveResultMock,
  };
});

// Mock node:fs/promises
const actualFsPromises = await import('node:fs/promises');
jest.unstable_mockModule('node:fs/promises', () => {
  const rmMock = mockFn<typeof actualFsPromises.rm>();
  rmMock.mockResolvedValue(undefined);
  return {
    ...actualFsPromises,
    readFile: jest.fn(),
    rm: rmMock,
  };
});

// Mock node:fs (sync functions used by executeScenario)
const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => {
  const mkdtempSyncMock = mockFn<typeof actualFs.mkdtempSync>();
  mkdtempSyncMock.mockReturnValue('/tmp/rd-scenario-test');
  return {
    ...actualFs,
    mkdtempSync: mkdtempSyncMock,
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn(),
  };
});

// Mock shell-quote
jest.unstable_mockModule('shell-quote', () => {
  const parseMock = mockFn<(str: string) => Array<string | { op: string }>>();
  parseMock.mockImplementation((str) => str.split(/\s+/));
  return {
    parse: parseMock,
  };
});

// Mock command-sequence (pass through extract helpers so extractReferencedRunbooks/input-file copying works)
const actualCommandSequence = await import('../../src/helpers/command-sequence.js');
jest.unstable_mockModule('../../src/helpers/command-sequence', () => ({
  executeCommandSequence: jest.fn(),
  matchStepAssertions: jest.fn(),
  extractRunbookReferences: actualCommandSequence.extractRunbookReferences,
  extractInputFileReferences: actualCommandSequence.extractInputFileReferences,
}));

// Import after mocking
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook.js');
const { extractFrontmatter } = await import('@rundown-org/parser');
const { parseScenarios } = await import('../../src/schemas/scenarios.js');
const { readFile, rm } = await import('node:fs/promises');
const { copyFileSync } = await import('node:fs');
const { executeCommandSequence, matchStepAssertions } = await import(
  '../../src/helpers/command-sequence.js'
);
const {
  loadScenarios,
  buildScenarioListRows,
  buildScenarioDetail,
  extractReferencedRunbooks,
  executeScenario,
} = await import('../../src/helpers/scenario-workflow.js');

// `readFile` is heavily overloaded; the production call site uses
// `readFile(path, 'utf-8')` which returns Promise<string>. `jest.mocked()`
// collapses to the first overload (Buffer-returning). Tests cast through
// `unknown` to land on the string overload's return value.
function setReadFileResolved(value: string): void {
  (
    jest.mocked(readFile) as unknown as {
      mockResolvedValue: (v: string) => void;
    }
  ).mockResolvedValue(value);
}

// `extractFrontmatter` returns a `RunbookFrontmatter | null`. Tests want to
// inject malformed/partial values; cast through `unknown`.
type ExtractedFrontmatter = ReturnType<typeof extractFrontmatter>;
function setExtractFrontmatter(frontmatter: unknown, content: string): void {
  jest.mocked(extractFrontmatter).mockReturnValue({
    frontmatter: frontmatter as ExtractedFrontmatter['frontmatter'],
    content,
    diagnostics: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loadScenarios', () => {
  it('returns error when file not found', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue(null);

    const result = await loadScenarios('missing.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('RUNBOOK_NOT_FOUND');
    }
  });

  it('returns error when no frontmatter', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/runbook.md',
      source: 'project',
    });
    setReadFileResolved('# No frontmatter');
    setExtractFrontmatter(null, '# No frontmatter');

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('No frontmatter');
    }
  });

  it('returns error with validation details', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/runbook.md',
      source: 'project',
    });
    setReadFileResolved('---\nscenarios: bad\n---');
    setExtractFrontmatter({ scenarios: 'bad' }, '');
    jest.mocked(parseScenarios).mockReturnValue({
      scenarios: null,
      errors: ['Field "commands" is required'],
    });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.details).toEqual(['Field "commands" is required']);
    }
  });

  it('returns error when no scenarios defined', async () => {
    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/runbook.md',
      source: 'project',
    });
    setReadFileResolved('---\nname: test\n---');
    setExtractFrontmatter({ name: 'test' }, '');
    jest.mocked(parseScenarios).mockReturnValue({ scenarios: null, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No scenarios');
    }
  });

  it('returns loaded runbook on success', async () => {
    const scenarios: Scenarios = {
      happy: {
        result: 'COMPLETE',
        commands: ['rd run test.md', 'rd pass'],
        description: 'Happy path',
      },
    };

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/runbook.md',
      source: 'project',
    });
    setReadFileResolved('---\nname: my-runbook\n---');
    setExtractFrontmatter({ name: 'my-runbook', scenarios }, '');
    jest.mocked(parseScenarios).mockReturnValue({ scenarios, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.name).toBe('my-runbook');
      expect(result.loaded.filePath).toBe('/test/runbook.md');
      expect(result.loaded.scenarios).toBe(scenarios);
    }
  });

  it('uses file as name when frontmatter has no name', async () => {
    const scenarios: Scenarios = {
      test: { result: 'COMPLETE', commands: ['rd run x.md'] },
    };

    jest.mocked(resolveRunbookFile).mockResolvedValue({
      path: '/test/runbook.md',
      source: 'project',
    });
    setReadFileResolved('---\nscenarios:\n---');
    setExtractFrontmatter({}, '');
    jest.mocked(parseScenarios).mockReturnValue({ scenarios, errors: [] });

    const result = await loadScenarios('runbook.md', '/test');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loaded.name).toBe('runbook.md');
    }
  });
});

describe('buildScenarioListRows', () => {
  it('maps scenarios to row objects', () => {
    const scenarios: Scenarios = {
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
    const scenarios: Scenarios = {
      tagged: {
        result: 'COMPLETE',
        commands: ['rd run x.md'],
        tags: ['smoke', 'regression'],
      },
    };

    const rows = buildScenarioListRows(scenarios);

    expect(rows[0].tags).toBe('smoke, regression');
  });
});

describe('buildScenarioDetail', () => {
  it('returns null for missing scenario', () => {
    const scenarios: Scenarios = {
      exists: { result: 'COMPLETE', commands: ['rd run x.md'] },
    };

    expect(buildScenarioDetail('missing', scenarios)).toBeNull();
  });

  it('returns detail for existing scenario', () => {
    const scenarios: Scenarios = {
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
    const scenarios: Scenarios = {
      tagged: {
        result: 'COMPLETE',
        commands: ['rd run x.md'],
        tags: ['smoke'],
      },
    };

    const detail = buildScenarioDetail('tagged', scenarios);

    expect(detail?.tags).toEqual(['smoke']);
  });

  it('includes expect block when present', () => {
    const scenarios: Scenarios = {
      rich: {
        result: 'COMPLETE',
        commands: ['rd run x.md', 'rd pass'],
        expect: { result: 'COMPLETE' },
      },
    };

    const detail = buildScenarioDetail('rich', scenarios);

    expect(detail?.expect).toEqual({ result: 'COMPLETE' });
  });
});

describe('extractReferencedRunbooks', () => {
  it('extracts runbook filenames from commands', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd pass'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['main.runbook.md']);
  });

  it('deduplicates references', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd run main.runbook.md'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['main.runbook.md']);
  });

  it('extracts multiple unique references', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd run main.runbook.md', 'rd delegate child.runbook.md --step 2'],
    };

    const refs = extractReferencedRunbooks(scenario);
    expect(refs).toContain('main.runbook.md');
    expect(refs).toContain('child.runbook.md');
    expect(refs).toHaveLength(2);
  });

  it('returns empty array when no runbook references', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd pass', 'rd fail'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual([]);
  });

  it('strips double quotes from runbook filenames', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd run --prompted "child.runbook.md"'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['child.runbook.md']);
  });

  it('strips single quotes from runbook filenames', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ["rd run --prompted 'child.runbook.md'"],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['child.runbook.md']);
  });

  it('extracts paths with slashes', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd delegate delegation/child.runbook.md --step 1'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['delegation/child.runbook.md']);
  });

  it('extracts filenames with hyphens', () => {
    const scenario: Scenario = {
      result: 'COMPLETE',
      commands: ['rd run my-cool-thing.runbook.md'],
    };

    expect(extractReferencedRunbooks(scenario)).toEqual(['my-cool-thing.runbook.md']);
  });
});

describe('executeScenario', () => {
  // OutputEmitter shape required by executeScenario; only `message` and `flush`
  // are exercised in these paths so we cast via `unknown` to the real type.
  const mockOutput = {
    message: jest.fn(),
    flush: jest.fn(),
  } as unknown as OutputEmitter;

  function makeLoadedRunbook(scenarioOverrides: Partial<Scenario> = {}) {
    return {
      filePath: '/test/patterns/my.runbook.md',
      name: 'my-runbook',
      description: 'Test runbook',
      scenarios: {
        happy: {
          result: 'COMPLETE' as const,
          commands: ['rd run my.runbook.md', 'rd pass'],
          ...scenarioOverrides,
        },
      },
    };
  }

  function makeSequenceResult(
    overrides: Partial<CommandSequenceResult> = {},
  ): CommandSequenceResult {
    return {
      terminalResult: 'COMPLETE',
      transitions: [],
      capturedTokens: [],
      capturedClaimIds: [],
      ...overrides,
    };
  }

  it('returns passed when terminalResult matches expected', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());

    const result = await executeScenario(
      makeLoadedRunbook(),
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
    jest
      .mocked(executeCommandSequence)
      .mockResolvedValue(makeSequenceResult({ terminalResult: 'STOP' }));

    const result = await executeScenario(
      makeLoadedRunbook(),
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
    const transition: CapturedTransition = {
      action: 'CONTINUE',
      from: '1',
      at: '2',
      result: 'PASS',
    };
    jest.mocked(executeCommandSequence).mockResolvedValue(
      makeSequenceResult({
        transitions: [transition],
      }),
    );
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

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(true);
    expect(result.stepAssertions).toBeDefined();
    expect(result.stepAssertions![0].matched).toBe(true);
  });

  it('fails when step assertion does not match', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest
      .mocked(matchStepAssertions)
      .mockReturnValue([{ assertion: { at: '3', action: 'COMPLETE' }, matched: false }]);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', steps: [{ at: '3', action: 'COMPLETE' }] },
    });

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(false);
    expect(result.stepAssertions![0].matched).toBe(false);
  });

  it('passes executeCommandSequence correct options', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(executeCommandSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['rd run my.runbook.md', 'rd pass'],
        cliPath: '/cli/dist/cli.js',
        quiet: true,
      }),
    );
  });

  it('cleans up temp directory after execution', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(rm).toHaveBeenCalledWith('/tmp/rd-scenario-test', {
      recursive: true,
      force: true,
    });
  });

  it('throws informative error when referenced child runbook is missing', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    jest.mocked(copyFileSync).mockImplementation((src) => {
      // Succeed for main runbook, throw ENOENT for child
      if (String(src).includes('child.runbook.md')) {
        throw enoentError;
      }
    });

    const loaded = makeLoadedRunbook({
      commands: ['rd run my.runbook.md', 'rd delegate child.runbook.md --step 1'],
    });

    await expect(
      executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(/Referenced runbook not found: child\.runbook\.md/);

    await expect(
      executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(/searched in:/);
  });

  describe('input-file path traversal guard', () => {
    beforeEach(() => {
      jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    });

    it('rejects absolute --input-file paths', async () => {
      const loaded = {
        filePath: '/test/patterns/my.runbook.md',
        name: 'my-runbook',
        description: 'Test',
        scenarios: {
          s: {
            result: 'COMPLETE' as const,
            commands: ['rd run my.runbook.md --input-file /etc/passwd'],
          },
        },
      };

      await expect(
        executeScenario(loaded, 's', true, mockOutput, '/cli/dist/cli.js'),
      ).rejects.toThrow(/Unsafe input-file path in scenario/);
    });

    it('rejects --input-file paths with .. traversal', async () => {
      const loaded = {
        filePath: '/test/patterns/my.runbook.md',
        name: 'my-runbook',
        description: 'Test',
        scenarios: {
          s: {
            result: 'COMPLETE' as const,
            commands: ['rd run my.runbook.md --input-file=../outside/data.yaml'],
          },
        },
      };

      await expect(
        executeScenario(loaded, 's', true, mockOutput, '/cli/dist/cli.js'),
      ).rejects.toThrow(/Unsafe input-file path in scenario/);
    });
  });
});
