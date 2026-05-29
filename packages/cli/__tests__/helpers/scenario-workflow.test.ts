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

const actualCore = await import('@rundown-org/core');
jest.unstable_mockModule('@rundown-org/core', () => ({
  ...actualCore,
  extractFileArtifactReferences: jest.fn(actualCore.extractFileArtifactReferences),
}));

// Mock scenarios schema — include all exports used by scenario-runbook
jest.unstable_mockModule('../../src/schemas/scenarios', () => {
  const getEffectiveResultMock =
    mockFn<
      (s: {
        result?: 'COMPLETE' | 'STOP';
        expect?: { result?: 'COMPLETE' | 'STOP'; errors?: readonly unknown[] };
      }) => 'COMPLETE' | 'STOP' | 'UNKNOWN'
    >();
  getEffectiveResultMock.mockImplementation((s) => {
    const r = s.result ?? s.expect?.result;
    if (r === undefined) {
      if (s.expect?.errors !== undefined && s.expect.errors.length > 0) {
        return 'UNKNOWN';
      }
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
  const statSyncMock = mockFn<typeof actualFs.statSync>();
  // Default: executable bit already set, so executeScenario skips chmodSync.
  statSyncMock.mockReturnValue({ mode: 0o755 } as ReturnType<typeof actualFs.statSync>);
  return {
    ...actualFs,
    mkdtempSync: mkdtempSyncMock,
    mkdirSync: jest.fn(),
    copyFileSync: jest.fn(),
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    realpathSync: jest.fn(),
    symlinkSync: jest.fn(),
    statSync: statSyncMock,
    chmodSync: jest.fn(),
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
  matchErrorAssertions: jest.fn(),
  matchArtifactAssertions: jest.fn(),
  emitScenarioTiming: jest.fn(),
  createInProcessCommandExecutor: actualCommandSequence.createInProcessCommandExecutor,
  formatErrorAssertionDescription: actualCommandSequence.formatErrorAssertionDescription,
  extractRunbookReferences: actualCommandSequence.extractRunbookReferences,
  extractInputFileReferences: actualCommandSequence.extractInputFileReferences,
}));

// Import after mocking
const { resolveRunbookFile } = await import('../../src/helpers/resolve-runbook.js');
const { extractFrontmatter } = await import('@rundown-org/parser');
const { extractFileArtifactReferences } = await import('@rundown-org/core');
const { parseScenarios } = await import('../../src/schemas/scenarios.js');
const { readFile, rm } = await import('node:fs/promises');
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  statSync,
  chmodSync,
} = await import('node:fs');
const { delimiter } = await import('node:path');
const {
  executeCommandSequence,
  matchStepAssertions,
  matchErrorAssertions,
  matchArtifactAssertions,
} = await import('../../src/helpers/command-sequence.js');
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

function setRealpathSyncImplementation(implementation: (path: unknown) => string): void {
  (
    jest.mocked(realpathSync) as unknown as {
      mockImplementation: (fn: (path: unknown) => string) => void;
    }
  ).mockImplementation(implementation);
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
  jest.mocked(copyFileSync).mockImplementation(() => undefined);
  jest.mocked(mkdirSync).mockImplementation(() => undefined);
  jest
    .mocked(extractFileArtifactReferences)
    .mockImplementation(actualCore.extractFileArtifactReferences);
  jest.mocked(readFileSync).mockReturnValue('# Test\n\n## 1. Step\n- PASS COMPLETE\n');
  jest.mocked(existsSync).mockReturnValue(true);
  // clearAllMocks resets call records but not implementations, so restore the
  // executable-bit defaults that individual tests may override.
  jest.mocked(statSync).mockReturnValue({ mode: 0o755 } as ReturnType<typeof statSync>);
  jest.mocked(chmodSync).mockImplementation(() => undefined);
  setRealpathSyncImplementation((path) => String(path));
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
      sourceRoot: '/test',
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
      sourceRoot: '/test',
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
      sourceRoot: '/test',
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
      sourceRoot: '/test',
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
      sourceRoot: '/test',
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
      errors: [],
      artifactEntries: [],
      commandTimings: [],
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

  it('evaluates error assertions when expect.errors present', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(
      makeSequenceResult({
        terminalResult: 'UNKNOWN',
        errors: [{ code: 'CLAIMED_RUNBOOK_UNAVAILABLE', command: 'pass' }],
      }),
    );
    jest.mocked(matchErrorAssertions).mockReturnValue([
      {
        assertion: { code: 'CLAIMED_RUNBOOK_UNAVAILABLE', command: 'pass' },
        matched: true,
        matchedError: { code: 'CLAIMED_RUNBOOK_UNAVAILABLE', command: 'pass' },
      },
    ]);

    const loaded = makeLoadedRunbook({
      result: undefined,
      expect: { errors: [{ code: 'CLAIMED_RUNBOOK_UNAVAILABLE', command: 'pass' }] },
    });

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(true);
    expect(result.expected).toBe('UNKNOWN');
    expect(result.errorAssertions).toBeDefined();
    expect(result.errorAssertions![0].matched).toBe(true);
  });

  it('fails when error assertion does not match', async () => {
    jest
      .mocked(executeCommandSequence)
      .mockResolvedValue(makeSequenceResult({ terminalResult: 'UNKNOWN' }));
    jest.mocked(matchErrorAssertions).mockReturnValue([
      {
        assertion: { code: 'CLAIMED_RUNBOOK_UNAVAILABLE' },
        matched: false,
      },
    ]);

    const loaded = makeLoadedRunbook({
      result: undefined,
      expect: { errors: [{ code: 'CLAIMED_RUNBOOK_UNAVAILABLE' }] },
    });

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(false);
    expect(result.errorAssertions![0].matched).toBe(false);
  });

  it('evaluates artifact assertions when expect.artifacts present', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(matchArtifactAssertions).mockReturnValue([
      {
        assertion: { alias: 'PlanPath', key: 'plan.json', exists: true },
        matched: true,
      },
    ]);

    const loaded = makeLoadedRunbook({
      expect: {
        result: 'COMPLETE',
        artifacts: [{ alias: 'PlanPath', key: 'plan.json', exists: true }],
      },
    });

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(true);
    expect(result.artifactAssertions).toBeDefined();
    expect(result.artifactAssertions![0].matched).toBe(true);
    expect(matchArtifactAssertions).toHaveBeenCalledWith(
      [{ alias: 'PlanPath', key: 'plan.json', exists: true }],
      [],
      expect.any(Function),
    );
  });

  it('fails when artifact assertion does not match', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(matchArtifactAssertions).mockReturnValue([
      {
        assertion: { alias: 'PlanPath', exists: true },
        matched: false,
      },
    ]);

    const loaded = makeLoadedRunbook({
      expect: { result: 'COMPLETE', artifacts: [{ alias: 'PlanPath', exists: true }] },
    });

    const result = await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(result.passed).toBe(false);
    expect(result.artifactAssertions![0].matched).toBe(false);
  });

  it('passes executeCommandSequence correct options', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    // Simulate the CI artifact round-trip stripping the executable bit so the
    // restore path runs.
    jest.mocked(statSync).mockReturnValue({ mode: 0o644 } as ReturnType<typeof statSync>);

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(symlinkSync).toHaveBeenCalledWith(
      '/cli/dist/cli.js',
      '/tmp/rd-scenario-test/node_modules/.bin/rd',
    );
    expect(symlinkSync).toHaveBeenCalledWith(
      '/cli/dist/cli.js',
      '/tmp/rd-scenario-test/node_modules/.bin/rundown',
    );
    // The symlink target must be executable so a scenario shell command that
    // resolves `rd` on PATH can exec cli.js (CI's artifact round-trip strips
    // the bit — see scenario-workflow.ts).
    expect(chmodSync).toHaveBeenCalledWith('/cli/dist/cli.js', 0o755);
    expect(executeCommandSequence).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ['rd run my.runbook.md', 'rd pass'],
        cliPath: '/cli/dist/cli.js',
        quiet: true,
        env: expect.objectContaining({
          PATH: ['/tmp/rd-scenario-test/node_modules/.bin', process.env.PATH]
            .filter((value): value is string => Boolean(value))
            .join(delimiter),
        }),
      }),
    );
  });

  it('skips chmod when the cli target is already executable', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    // Default statSync mock reports mode 0o755 (executable bit set).

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(chmodSync).not.toHaveBeenCalled();
  });

  it.each([
    'EACCES',
    'EPERM',
  ])('tolerates %s when restoring the cli executable bit', async (code) => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(statSync).mockReturnValue({ mode: 0o644 } as ReturnType<typeof statSync>);
    jest.mocked(chmodSync).mockImplementation(() => {
      throw Object.assign(new Error(`${code}: permission denied`), { code });
    });

    // Read-only / global installs may reject chmod even though cli.js is
    // already runnable — the scenario run must still proceed.
    const result = await executeScenario(
      makeLoadedRunbook(),
      'happy',
      true,
      mockOutput,
      '/cli/dist/cli.js',
    );

    expect(result.passed).toBe(true);
    expect(chmodSync).toHaveBeenCalledWith('/cli/dist/cli.js', 0o755);
  });

  it('rethrows non-permission errors from chmod', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(statSync).mockReturnValue({ mode: 0o644 } as ReturnType<typeof statSync>);
    jest.mocked(chmodSync).mockImplementation(() => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });

    await expect(
      executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(/EROFS/);
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

  it('copies static artifact fixtures referenced by the runbook into the scenario workspace', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(readFileSync).mockReturnValue(`# Test

## 1. Step
- ARTIFACTS
  - Schema "schemas/review.schema.json"
- PASS COMPLETE
`);

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(copyFileSync).toHaveBeenCalledWith(
      '/test/patterns/schemas/review.schema.json',
      '/tmp/rd-scenario-test/schemas/review.schema.json',
    );
  });

  it('allows static artifact fixture names that start with two dots without traversing parents', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    jest.mocked(extractFileArtifactReferences).mockReturnValue(['..schema.json']);

    await executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(copyFileSync).toHaveBeenCalledWith(
      '/test/patterns/..schema.json',
      '/tmp/rd-scenario-test/..schema.json',
    );
  });

  it('rejects static artifact fixture refs with parent traversal segments', async () => {
    jest.mocked(extractFileArtifactReferences).mockReturnValue(['schemas/../review.schema.json']);

    await expect(
      executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow('Unsafe artifact path in scenario: schemas/../review.schema.json');
    expect(executeCommandSequence).not.toHaveBeenCalled();
  });

  it('throws before execution when a static artifact fixture is missing', async () => {
    jest.mocked(readFileSync).mockReturnValue(`# Test

## 1. Step
- ARTIFACTS
  - Schema "schemas/review.schema.json"
- PASS COMPLETE
`);
    jest.mocked(existsSync).mockImplementation((path) => {
      return !String(path).endsWith('/schemas/review.schema.json');
    });

    await expect(
      executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow(
      'Artifact file not found: schemas/review.schema.json (searched in: /test/patterns)',
    );
    expect(executeCommandSequence).not.toHaveBeenCalled();
  });

  it('rejects static artifact fixture symlinks that escape the runbook source directory', async () => {
    jest.mocked(readFileSync).mockReturnValue(`# Test

## 1. Step
- ARTIFACTS
  - Schema "schemas/review.schema.json"
- PASS COMPLETE
`);
    setRealpathSyncImplementation((path) => {
      const raw = String(path);
      if (raw.endsWith('/schemas/review.schema.json')) return '/outside/review.schema.json';
      return raw;
    });

    await expect(
      executeScenario(makeLoadedRunbook(), 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow('Artifact source escapes source root: schemas/review.schema.json');
    expect(executeCommandSequence).not.toHaveBeenCalled();
  });

  it('rejects referenced child runbook symlinks that escape the source directory', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());
    setRealpathSyncImplementation((path) => {
      const raw = String(path);
      if (raw.endsWith('/child.runbook.md')) return '/outside/child.runbook.md';
      return raw;
    });

    const loaded = makeLoadedRunbook({
      commands: ['rd run my.runbook.md', 'rd delegate child.runbook.md --step 1'],
    });

    await expect(
      executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js'),
    ).rejects.toThrow('Referenced runbook source escapes source root: child.runbook.md');
  });

  it('creates parent directories before copying nested referenced child runbooks', async () => {
    jest.mocked(executeCommandSequence).mockResolvedValue(makeSequenceResult());

    const loaded = makeLoadedRunbook({
      commands: ['rd run my.runbook.md', 'rd delegate delegation/child.runbook.md --step 1'],
    });

    await executeScenario(loaded, 'happy', true, mockOutput, '/cli/dist/cli.js');

    expect(mkdirSync).toHaveBeenCalledWith('/tmp/rd-scenario-test/.rundown/runbooks/delegation', {
      recursive: true,
    });
    expect(copyFileSync).toHaveBeenCalledWith(
      '/test/patterns/delegation/child.runbook.md',
      '/tmp/rd-scenario-test/.rundown/runbooks/delegation/child.runbook.md',
    );
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
