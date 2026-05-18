import { describe, it, expect } from '@jest/globals';
import { ScenarioSuiteRunResponseSchema } from '../../src/output/zod-schemas.js';

describe('ScenarioSuiteRunResponseSchema', () => {
  const validCase = {
    kind: 'scenario_run' as const,
    result: true,
    scenario: 'happy-path',
    expected: 'COMPLETE',
    actual: 'COMPLETE',
  };

  const failingCase = {
    kind: 'scenario_run' as const,
    result: false,
    scenario: 'stop-path',
    expected: 'COMPLETE',
    actual: 'STOP',
  };

  it('validates a correct suite run response with mixed results', () => {
    const response = {
      kind: 'scenario_suite_run' as const,
      result: false,
      suite: 'Test Suite',
      total: 2,
      passed: 1,
      failed: 1,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it('validates a correct suite run response with all passing', () => {
    const allPassingCase = {
      kind: 'scenario_run' as const,
      result: true,
      scenario: 'another-happy',
      expected: 'COMPLETE',
      actual: 'COMPLETE',
    };

    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 2,
      failed: 0,
      cases: [validCase, allPassingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it('accepts artifact assertion results on case entries', () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_11111111111111111111111111111111/plan.json',
      runId: 'rd_11111111111111111111111111111111',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: '.rundown/runbooks/artifacts.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    };
    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 1,
      passed: 1,
      failed: 0,
      cases: [
        {
          ...validCase,
          artifactAssertions: [
            {
              assertion: { alias: 'PlanPath', key: 'plan.json', exists: true },
              matched: true,
              matchedEntry: {
                artifacts: { PlanPath: artifact },
              },
              matchedRecords: [artifact],
            },
          ],
        },
      ],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it('rejects when total does not equal cases.length', () => {
    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 5,
      passed: 1,
      failed: 1,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('total'))).toBe(true);
    }
  });

  it('rejects when passed + failed does not equal total', () => {
    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 0,
      failed: 0,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('passed') && m.includes('failed'))).toBe(true);
    }
  });

  it('rejects when passed count does not match cases with result === true', () => {
    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 2,
      failed: 0,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('passed'))).toBe(true);
    }
  });

  it('rejects when failed count does not match cases with result === false', () => {
    const response = {
      kind: 'scenario_suite_run' as const,
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 1,
      failed: 1,
      cases: [validCase, { ...failingCase, result: true }],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('failed'))).toBe(true);
    }
  });
});
