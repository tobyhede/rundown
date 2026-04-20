import { describe, it, expect } from '@jest/globals';
import { RunbookStateSchema } from '../../src/schemas.js';

const BASE_STATE = {
  id: 'r1',
  runbook: 'x.md',
  runbookPath: 'x.md',
  step: '1',
  stepName: 'x',
  retryCount: 0,
  steps: [],
  startedAt: '2026-04-19T00:00:00.000Z',
  updatedAt: '2026-04-19T00:00:00.000Z',
};

describe('RunbookStateSchema — schema version and lifecycle fields', () => {
  it('accepts state with schemaVersion 2 and lifecycle field', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.lifecycle).toBe('running');
    expect(parsed.schemaVersion).toBe(2);
  });

  it('accepts all lifecycle enum values', () => {
    for (const lc of ['running', 'completed', 'stopped'] as const) {
      const parsed = RunbookStateSchema.parse({
        ...BASE_STATE,
        variables: {},
        lifecycle: lc,
        schemaVersion: 2,
      });
      expect(parsed.lifecycle).toBe(lc);
    }
  });

  it('rejects boolean values inside variables (narrow shape enforced)', () => {
    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_STATE,
        variables: { completed: true },
        lifecycle: 'running',
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it('rejects number values inside variables', () => {
    expect(() =>
      RunbookStateSchema.parse({
        ...BASE_STATE,
        variables: { count: 42 },
        lifecycle: 'running',
        schemaVersion: 2,
      }),
    ).toThrow();
  });

  it('accepts empty variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_STATE,
      variables: {},
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.variables).toEqual({});
  });

  it('accepts string-only variables map', () => {
    const parsed = RunbookStateSchema.parse({
      ...BASE_STATE,
      variables: { env: 'staging', version: '1.2.3' },
      lifecycle: 'running',
      schemaVersion: 2,
    });
    expect(parsed.variables).toEqual({ env: 'staging', version: '1.2.3' });
  });
});
