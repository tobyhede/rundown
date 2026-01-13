import { ScenarioSchema, ScenariosSchema, parseScenarios } from '../../src/schemas/scenarios.js';

describe('ScenarioSchema', () => {
  it('validates a complete scenario', () => {
    const scenario = {
      description: 'Happy path through workflow',
      commands: ['rd run --prompted test.runbook.md', 'rd pass', 'rd pass'],
      result: 'COMPLETE',
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(true);
  });

  it('validates scenario without description', () => {
    const scenario = {
      commands: ['rd run --prompted test.runbook.md', 'rd fail'],
      result: 'STOP',
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(true);
  });

  it('rejects scenario without commands', () => {
    const scenario = {
      result: 'COMPLETE',
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });

  it('rejects scenario with empty commands', () => {
    const scenario = {
      commands: [],
      result: 'COMPLETE',
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });

  it('rejects invalid result value', () => {
    const scenario = {
      commands: ['rd pass'],
      result: 'SUCCESS',  // Invalid - should be COMPLETE or STOP
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });
});

describe('ScenariosSchema', () => {
  it('validates multiple named scenarios', () => {
    const scenarios = {
      success: {
        commands: ['rd run --prompted test.md', 'rd pass'],
        result: 'COMPLETE',
      },
      failure: {
        description: 'Early failure path',
        commands: ['rd run --prompted test.md', 'rd fail'],
        result: 'STOP',
      },
    };

    const result = ScenariosSchema.safeParse(scenarios);
    expect(result.success).toBe(true);
  });
});

describe('parseScenarios', () => {
  it('returns scenarios when valid', () => {
    const frontmatter = {
      name: 'test',
      scenarios: {
        success: {
          commands: ['rd pass'],
          result: 'COMPLETE',
        },
      },
    };

    const result = parseScenarios(frontmatter);
    expect(result.scenarios).not.toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it('returns empty errors when no scenarios field', () => {
    const frontmatter = { name: 'test' };

    const result = parseScenarios(frontmatter);
    expect(result.scenarios).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it('returns validation errors for invalid scenarios', () => {
    const frontmatter = {
      name: 'test',
      scenarios: {
        broken: {
          commands: [],  // Invalid: empty array
          result: 'COMPLETE',
        },
      },
    };

    const result = parseScenarios(frontmatter);
    expect(result.scenarios).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('commands');
  });
});
