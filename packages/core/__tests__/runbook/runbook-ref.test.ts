import { describe, expect, it } from '@jest/globals';
import { RUNBOOK_REF_ERROR_TEXT, RunbookRefSchema } from '../../src/runbook/runbook-ref.js';

describe('RunbookRefSchema', () => {
  it('accepts source-root-relative Markdown paths without rewriting the extension', () => {
    const ref = {
      source: 'project',
      path: 'ops/deploy.md',
    };

    expect(RunbookRefSchema.parse(ref)).toEqual(ref);
  });

  it('accepts conventional .runbook.md paths', () => {
    const ref = {
      source: 'plugin',
      path: 'planning/review/review-plan-risk-safety.runbook.md',
    };

    expect(RunbookRefSchema.parse(ref)).toEqual(ref);
  });

  it.each([
    { source: 'external', path: 'planning/review.md' },
    { source: 'external', path: '/tmp/foo\0.md' },
    { source: 'external', path: '/tmp/../bar.md' },
    { source: 'external', path: '/tmp/./bar.md' },
    { source: 'external', path: '/tmp//bar.md' },
    { source: 'external', path: '/tmp/bar.txt' },
    { source: 'plugin', path: '' },
    { source: 'plugin', path: '/planning/review.md' },
    { source: 'plugin', path: '../review.md' },
    { source: 'plugin', path: 'planning//review.md' },
    { source: 'plugin', path: 'planning/review plan.md' },
    { source: 'plugin', path: 'planning/review.txt' },
  ])('rejects invalid runbook ref %#', (ref) => {
    expect(() => RunbookRefSchema.parse(ref)).toThrow(RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF);
  });

  it.each([
    'planning/review.md',
    { path: 'planning/review.md' },
    { source: 'plugin' },
  ])('rejects structurally invalid runbook refs %#', (ref) => {
    expect(() => RunbookRefSchema.parse(ref)).toThrow();
  });
});
