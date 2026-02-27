import { ScenarioSuiteCaseSchema, ScenarioSuiteSchema } from '../../src/schemas/scenario-suite.js';

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
