import { describe, expect, it } from '@jest/globals';
import { RUNBOOK_REF_ERROR_TEXT, RunbookRefSchema } from '../../src/runbook/runbook-ref.js';

describe('RunbookRefSchema', () => {
  it('accepts a canonical local-disk runbook reference', () => {
    const ref = {
      source: 'plugin',
      path: 'planning/review/review-plan-risk-safety.runbook.md',
    };

    expect(RunbookRefSchema.parse(ref)).toEqual(ref);
  });

  it('accepts project refs under .rundown/runbooks', () => {
    const ref = {
      source: 'project',
      path: '.rundown/runbooks/planning/review.runbook.md',
    };

    expect(RunbookRefSchema.parse(ref)).toEqual(ref);
  });

  it.each([
    { source: 'external', path: 'planning/review.runbook.md' },
    { source: 'plugin', path: '' },
    { source: 'plugin', path: '/planning/review.runbook.md' },
    { source: 'plugin', path: '../review.runbook.md' },
    { source: 'plugin', path: 'planning//review.runbook.md' },
    { source: 'plugin', path: 'planning/review plan.runbook.md' },
    { source: 'plugin', path: 'planning/review.md' },
  ])('rejects invalid runbook ref %#', (ref) => {
    expect(() => RunbookRefSchema.parse(ref)).toThrow(RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF);
  });

  it.each([
    'planning/review.runbook.md',
    { path: 'planning/review.runbook.md' },
    { source: 'plugin' },
  ])('rejects structurally invalid runbook refs %#', (ref) => {
    expect(() => RunbookRefSchema.parse(ref)).toThrow();
  });
});
