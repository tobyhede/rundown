import {
  ScenarioSchema,
  ScenarioExpectSchema,
  ScenariosSchema,
  parseScenarios,
  getEffectiveResult,
} from '../../src/schemas/scenarios.js';

describe('ScenarioSchema', () => {
  it('validates a complete scenario with result', () => {
    const scenario = {
      description: 'Happy path through runbook',
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
      result: 'SUCCESS', // Invalid - should be COMPLETE or STOP
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });

  it('accepts scenario with expect.result instead of result', () => {
    const scenario = {
      commands: ['rd run test.runbook.md', 'rd pass'],
      expect: { result: 'COMPLETE', finalStep: '2' },
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(true);
  });

  it('accepts scenario with both result and matching expect.result', () => {
    const scenario = {
      commands: ['rd run test.runbook.md', 'rd pass'],
      result: 'COMPLETE',
      expect: { result: 'COMPLETE', stepsCompleted: 2 },
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(true);
  });

  it('rejects scenario with disagreeing result and expect.result', () => {
    const scenario = {
      commands: ['rd run test.runbook.md'],
      result: 'COMPLETE',
      expect: { result: 'STOP' },
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });

  it('rejects scenario with neither result nor expect.result', () => {
    const scenario = {
      commands: ['rd run test.runbook.md'],
      expect: { stepsCompleted: 2 }, // No result anywhere
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });

  it('rejects scenario with no result and no expect block', () => {
    const scenario = {
      commands: ['rd run test.runbook.md'],
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(false);
  });
});

describe('ScenarioExpectSchema', () => {
  it('validates empty expect', () => {
    const result = ScenarioExpectSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates all fields', () => {
    const expect_block = {
      result: 'COMPLETE',
      finalStep: '3',
      stepsCompleted: 2,
      lastAction: 'CONTINUE',
      lastResult: 'pass',
      retryCount: 0,
      variables: { completed: true, count: 5 },
    };

    const result = ScenarioExpectSchema.safeParse(expect_block);
    expect(result.success).toBe(true);
  });

  it('rejects invalid lastAction value', () => {
    const result = ScenarioExpectSchema.safeParse({ lastAction: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid lastResult value', () => {
    const result = ScenarioExpectSchema.safeParse({ lastResult: 'success' });
    expect(result.success).toBe(false);
  });

  it('rejects negative stepsCompleted', () => {
    const result = ScenarioExpectSchema.safeParse({ stepsCompleted: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer stepsCompleted', () => {
    const result = ScenarioExpectSchema.safeParse({ stepsCompleted: 1.5 });
    expect(result.success).toBe(false);
  });

  it('validates individual field combinations', () => {
    expect(ScenarioExpectSchema.safeParse({ finalStep: '2' }).success).toBe(true);
    expect(ScenarioExpectSchema.safeParse({ retryCount: 3 }).success).toBe(true);
    expect(ScenarioExpectSchema.safeParse({ variables: { key: 'value' } }).success).toBe(true);
  });
});

describe('getEffectiveResult', () => {
  it('returns result when present', () => {
    const scenario = { result: 'COMPLETE', commands: ['rd pass'] } as any;
    expect(getEffectiveResult(scenario)).toBe('COMPLETE');
  });

  it('returns expect.result when result is absent', () => {
    const scenario = {
      commands: ['rd pass'],
      expect: { result: 'STOP' },
    } as any;
    expect(getEffectiveResult(scenario)).toBe('STOP');
  });

  it('returns result over expect.result when both present', () => {
    const scenario = {
      commands: ['rd pass'],
      result: 'COMPLETE',
      expect: { result: 'COMPLETE' },
    } as any;
    expect(getEffectiveResult(scenario)).toBe('COMPLETE');
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

  it('validates scenario with expect-only result', () => {
    const scenarios = {
      rich: {
        commands: ['rd run test.md', 'rd pass'],
        expect: { result: 'COMPLETE', finalStep: '2' },
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
          commands: [], // Invalid: empty array
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
