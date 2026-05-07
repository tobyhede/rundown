import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/helpers/plugin-root.js', () => ({
  getPluginRoot: jest.fn(() => null),
}));

const { resolveRunbookRef } = await import('../../src/helpers/resolve-runbook.js');

describe('resolveRunbookRef plugin context', () => {
  it('reports missing plugin context separately from a missing plugin file', async () => {
    const runbookRef = { source: 'plugin' as const, path: 'planning/write-plan.runbook.md' };

    const result = await resolveRunbookRef('/workspace', runbookRef);

    expect(result).toEqual({
      ok: false,
      reason: 'plugin-context-missing',
      runbookRef,
    });
  });
});
