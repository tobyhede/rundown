import { describe, it, expect } from '@jest/globals';
import { getRunbookFromState } from '../../src/helpers/runbook-loader.js';
import type { RunbookState } from '@rundown-org/core';

describe('getRunbookFromState', () => {
  it('should parse from runbookSrc when available', () => {
    const runbookSrc = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
echo hello
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
echo done
\`\`\`
`;
    const state: Partial<RunbookState> = {
      id: 'test-id',
      runbook: 'test.runbook.md',
      runbookSrc,
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('1');
    expect(steps[1].name).toBe('2');
  });

  it('applies templateVars when runbookSrc contains placeholders', () => {
    const runbookSrc = `# Templated Runbook

## 1. Deploy {{Service}}
- PASS: COMPLETE

\`\`\`bash
echo {{Service}}
\`\`\`
`;

    const state: Partial<RunbookState> = {
      id: 'templated-id',
      runbook: 'templated.runbook.md',
      runbookSrc,
      templateVars: {
        Service: 'api-server',
      },
      sources: {},
    };

    const steps = getRunbookFromState(state as RunbookState, '/unused');

    expect(steps).toHaveLength(1);
    expect(steps[0].description).toContain('Deploy api-server');
    expect(steps[0].command?.code).toContain('echo api-server');
  });

  it('should throw when runbookSrc is missing (corrupted state)', () => {
    const state: Partial<RunbookState> = {
      id: 'corrupted-id',
      runbook: 'test.runbook.md',
      // runbookSrc is undefined
    };

    expect(() => {
      getRunbookFromState(state as RunbookState, '/unused');
    }).toThrow('State file corrupted-id is missing runbookSrc');
  });

  it('should not attempt disk fallback', () => {
    const state: Partial<RunbookState> = {
      id: 'missing-src-id',
      runbook: 'nonexistent.runbook.md',
      // runbookSrc is undefined
    };

    // Should throw immediately without checking disk
    expect(() => {
      getRunbookFromState(state as RunbookState, '/some/cwd');
    }).toThrow('State file missing-src-id is missing runbookSrc');
  });
});
