import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ScenarioSuiteCaseSchema,
  ScenarioSuiteSchema,
  loadScenarioSuite,
} from '../../src/schemas/scenario-suite.js';

describe('ScenarioSuiteCaseSchema', () => {
  it('validates a complete case', () => {
    const c = {
      description: 'Happy path deployment',
      file: 'deploy-service.runbook.md',
      commands: ['rd run deploy-service.runbook.md', 'rd pass'],
      result: 'COMPLETE',
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(true);
  });

  it('validates case with expect block instead of result', () => {
    const c = {
      file: 'test.runbook.md',
      commands: ['rd run test.runbook.md'],
      expect: { result: 'COMPLETE', finalStep: '2' },
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(true);
  });

  it('rejects case with non-runbook file', () => {
    const c = {
      file: 'test.md', // Must end with .runbook.md
      commands: ['rd run test.md'],
      result: 'COMPLETE',
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it('rejects case without commands', () => {
    const c = {
      file: 'test.runbook.md',
      result: 'COMPLETE',
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it('rejects case with empty commands', () => {
    const c = {
      file: 'test.runbook.md',
      commands: [],
      result: 'COMPLETE',
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it('rejects case without any result specification', () => {
    const c = {
      file: 'test.runbook.md',
      commands: ['rd run test.runbook.md'],
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it('rejects case with expect but no expect.result', () => {
    const c = {
      file: 'test.runbook.md',
      commands: ['rd run test.runbook.md'],
      expect: { stepsCompleted: 2 },
    };

    const result = ScenarioSuiteCaseSchema.safeParse(c);
    expect(result.success).toBe(false);
  });
});

describe('ScenarioSuiteSchema', () => {
  it('validates a complete suite', () => {
    const suite = {
      version: 1,
      name: 'Core patterns',
      description: 'Regression suite for pattern runbooks',
      tags: ['patterns', 'regression'],
      cases: {
        'deploy-completes': {
          description: 'Happy path deployment',
          file: 'deploy-service.runbook.md',
          commands: ['rd run deploy-service.runbook.md', 'rd pass', 'rd pass'],
          result: 'COMPLETE',
        },
        'deploy-stops': {
          file: 'deploy-service.runbook.md',
          commands: ['rd run deploy-service.runbook.md', 'rd pass', 'rd fail'],
          result: 'STOP',
        },
      },
    };

    const result = ScenarioSuiteSchema.safeParse(suite);
    expect(result.success).toBe(true);
  });

  it('rejects wrong version', () => {
    const suite = {
      version: 2,
      name: 'Test',
      cases: {
        test: {
          file: 'test.runbook.md',
          commands: ['rd pass'],
          result: 'COMPLETE',
        },
      },
    };

    const result = ScenarioSuiteSchema.safeParse(suite);
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const suite = {
      version: 1,
      cases: {
        test: {
          file: 'test.runbook.md',
          commands: ['rd pass'],
          result: 'COMPLETE',
        },
      },
    };

    const result = ScenarioSuiteSchema.safeParse(suite);
    expect(result.success).toBe(false);
  });

  it('rejects empty cases', () => {
    const suite = {
      version: 1,
      name: 'Empty',
      cases: {},
    };

    const result = ScenarioSuiteSchema.safeParse(suite);
    expect(result.success).toBe(false);
  });

  it('validates suite with minimal fields', () => {
    const suite = {
      version: 1,
      name: 'Minimal',
      cases: {
        test: {
          file: 'test.runbook.md',
          commands: ['rd run test.runbook.md'],
          result: 'COMPLETE',
        },
      },
    };

    const result = ScenarioSuiteSchema.safeParse(suite);
    expect(result.success).toBe(true);
  });
});

describe('loadScenarioSuite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rd-suite-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns error when file does not exist', async () => {
    const result = await loadScenarioSuite(join(tmpDir, 'nonexistent.yaml'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Suite file not found');
    }
  });

  it('returns error for invalid YAML', async () => {
    const badYaml = join(tmpDir, 'bad.yaml');
    await writeFile(badYaml, '{ invalid yaml: [');

    const result = await loadScenarioSuite(badYaml);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid YAML');
    }
  });

  it('returns error with details for invalid structure', async () => {
    const invalidSuite = join(tmpDir, 'invalid.yaml');
    await writeFile(
      invalidSuite,
      'version: 1\nname: Bad\ncases:\n  broken:\n    file: not-a-runbook.txt\n    commands: []\n',
    );

    const result = await loadScenarioSuite(invalidSuite);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid suite file');
      expect(result.details).toBeDefined();
      expect(result.details!.length).toBeGreaterThan(0);
    }
  });

  it('loads and validates a correct suite file', async () => {
    const validSuite = join(tmpDir, 'valid.yaml');
    await writeFile(
      validSuite,
      [
        'version: 1',
        'name: Test Suite',
        'cases:',
        '  happy:',
        '    file: test.runbook.md',
        '    commands:',
        '      - rd run test.runbook.md',
        '      - rd pass',
        '    result: COMPLETE',
      ].join('\n'),
    );

    const result = await loadScenarioSuite(validSuite);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.suite.name).toBe('Test Suite');
      expect(result.suite.cases['happy']).toBeDefined();
      expect(result.suite.cases['happy'].commands).toHaveLength(2);
    }
  });
});
