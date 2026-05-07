import { describe, it, expect } from '@jest/globals';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import type { RunbookState } from '@rundown-org/core';
import { brandInitialTemplateVarsForTest } from './brand-helpers.js';

describe('getRunbookFromState', () => {
  it('should parse from runbookSrc when available', () => {
    const runbookSrc = `# Test Runbook

## 1. First Step
- PASS CONTINUE

\`\`\`bash
echo hello
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
echo done
\`\`\`
`;
    const state: Partial<RunbookState> = {
      id: 'test-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'test.runbook.md' },
      runbookSrc,
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('1');
    expect(steps[1].name).toBe('2');
  });

  it('should throw when runbookSrc is missing (corrupted state)', () => {
    const state: Partial<RunbookState> = {
      id: 'corrupted-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'test.runbook.md' },
      // runbookSrc is undefined
    };

    expect(() => {
      getRunbookFromState(state as RunbookState, '/unused');
    }).toThrow('State file corrupted-id is missing runbookSrc');
  });

  it('should substitute templateVars when present in state', () => {
    const runbookSrc = `# Template Runbook

## 1. Deploy
- PASS COMPLETE

Deploy to {{ env }}.
`;
    const state: Partial<RunbookState> = {
      id: 'template-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'template.runbook.md' },
      runbookSrc,
      templateVars: brandInitialTemplateVarsForTest({ env: 'staging' }),
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('1');
    expect(steps[0].prompt).toContain('staging');
  });

  it('should not attempt disk fallback', () => {
    const state: Partial<RunbookState> = {
      id: 'missing-src-id' as RunbookState['id'],
      runbook: { source: 'project', path: 'nonexistent.runbook.md' },
      // runbookSrc is undefined
    };

    // Should throw immediately without checking disk
    expect(() => {
      getRunbookFromState(state as RunbookState, '/some/cwd');
    }).toThrow('State file missing-src-id is missing runbookSrc');
  });
});
