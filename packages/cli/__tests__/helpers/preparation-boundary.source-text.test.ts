import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('CLI preparation boundary', () => {
  it('runbook-pipeline delegates parsed runbook preparation to core', async () => {
    const source = await readFile('src/helpers/runbook-pipeline.ts', 'utf8');

    expect(source).toContain('prepareParsedRunbook');
    expect(source).not.toContain('function buildTemplateVars');
    expect(source).not.toContain('function validateForVariables');
    expect(source).not.toContain('resolveForBounds(rawRunbook');
    expect(source).not.toContain('substituteRunbookVariables(resolvedRunbook');
  });

  it('CLI template-renderer is a compatibility wrapper around core', async () => {
    const source = await readFile('src/services/template-renderer.ts', 'utf8');

    expect(source).toContain("from '@rundown-org/core'");
    expect(source).not.toContain('const TEMPLATE_PATH_REGEX');
    expect(source).not.toContain('function resolveDottedPath');
  });
});
