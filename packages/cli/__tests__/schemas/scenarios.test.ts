import {
  ScenarioSchema,
  ScenarioExpectSchema,
  StepAssertionSchema,
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
      expect: { result: 'COMPLETE' },
    };

    const result = ScenarioSchema.safeParse(scenario);
    expect(result.success).toBe(true);
  });

  it('accepts scenario with both result and matching expect.result', () => {
    const scenario = {
      commands: ['rd run test.runbook.md', 'rd pass'],
      result: 'COMPLETE',
      expect: { result: 'COMPLETE' },
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
      expect: {}, // No result anywhere
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

  it('validates with result only', () => {
    const result = ScenarioExpectSchema.safeParse({ result: 'COMPLETE' });
    expect(result.success).toBe(true);
  });

  it('validates with steps array', () => {
    const result = ScenarioExpectSchema.safeParse({
      result: 'COMPLETE',
      steps: [{ at: '2', action: 'CONTINUE', result: 'PASS' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid result', () => {
    const result = ScenarioExpectSchema.safeParse({ result: 'SUCCESS' });
    expect(result.success).toBe(false);
  });
});

describe('StepAssertionSchema', () => {
  it('validates with all fields', () => {
    const result = StepAssertionSchema.safeParse({
      at: '1.3.1',
      from: '1.2.1',
      action: 'BREAK',
      result: 'FAIL',
      command: 'rd echo',
    });
    expect(result.success).toBe(true);
  });

  it('validates empty object (all optional)', () => {
    const result = StepAssertionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('coerces numeric at to string', () => {
    const result = StepAssertionSchema.safeParse({ at: 1.1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.at).toBe('1.1');
    }
  });

  it('coerces numeric from to string', () => {
    const result = StepAssertionSchema.safeParse({ from: 2 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe('2');
    }
  });

  it('rejects invalid action', () => {
    const result = StepAssertionSchema.safeParse({ action: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid result', () => {
    const result = StepAssertionSchema.safeParse({ result: 'pass' }); // lowercase
    expect(result.success).toBe(false);
  });

  it('accepts runbook as a string', () => {
    const result = StepAssertionSchema.safeParse({ runbook: 'child.runbook.md' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runbook).toBe('child.runbook.md');
    }
  });

  it('runbook is optional — absent from parsed data when not provided', () => {
    const result = StepAssertionSchema.safeParse({ action: 'COMPLETE' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runbook).toBeUndefined();
    }
  });

  it('validates full assertion including runbook', () => {
    const result = StepAssertionSchema.safeParse({
      runbook: 'delegation-child-pass.runbook.md',
      from: '1',
      action: 'COMPLETE',
      result: 'PASS',
    });
    expect(result.success).toBe(true);
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

  it('throws when neither result nor expect.result is present', () => {
    const scenario = { commands: ['rd pass'], expect: {} } as any;
    expect(() => getEffectiveResult(scenario)).toThrow(
      'Neither result nor expect.result is defined',
    );
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
        expect: { result: 'COMPLETE' },
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
