import { describe, it, expect } from '@jest/globals';
import { ScenarioSuiteRunResponseSchema } from '../../src/output/zod-schemas.js';

describe('ScenarioSuiteRunResponseSchema', () => {
  const validCase = {
    result: true,
    scenario: 'happy-path',
    expected: 'COMPLETE',
    actual: 'COMPLETE',
  };

  const failingCase = {
    result: false,
    scenario: 'stop-path',
    expected: 'COMPLETE',
    actual: 'STOP',
  };

  it('validates a correct suite run response', () => {
    const response = {
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 1,
      failed: 1,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
  });

  it('rejects when total does not equal cases.length', () => {
    const response = {
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
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 2,
      failed: 0,
      cases: [validCase, failingCase],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });

  it('rejects when failed count does not match cases with result === false', () => {
    const response = {
      result: true,
      suite: 'Test Suite',
      total: 2,
      passed: 1,
      failed: 1,
      cases: [validCase, { ...failingCase, result: true }],
    };

    const parsed = ScenarioSuiteRunResponseSchema.safeParse(response);
    expect(parsed.success).toBe(false);
  });
});
