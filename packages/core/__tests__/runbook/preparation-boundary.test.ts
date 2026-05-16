import { describe, expect, it } from '@jest/globals';
import { parseRunbookDocument } from '@rundown-org/parser';
import { prepareParsedRunbook } from '../../src/runbook/index.js';

describe('preparation boundary hygiene', () => {
  it('does not return helper functions inside prepared template variables', () => {
    const parsed = parseRunbookDocument(
      '# Workflow\n\n## 1. Start\n{{ upper env }}',
      'workflow.md',
    );

    const result = prepareParsedRunbook({
      rawRunbook: parsed.runbook,
      frontmatter: parsed.frontmatter,
      diagnostics: parsed.diagnostics,
      templateVars: { env: 'prod' },
      providedKeys: new Set(['env']),
      runbookRef: { source: 'project', path: 'workflow.md' },
      helperRegistry: new Map([['upper', (value: string) => value.toUpperCase()]]),
      identity: { kind: 'prepared' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.values(result.templateVars).some((value) => typeof value === 'function')).toBe(
        false,
      );
    }
  });
});
