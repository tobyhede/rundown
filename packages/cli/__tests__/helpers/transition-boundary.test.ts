import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('CLI transition boundary', () => {
  it('does not use raw actor send or updateFromActor in runbook transition helpers', async () => {
    const files = [
      new URL('../../src/helpers/transitions.ts', import.meta.url),
      new URL('../../src/helpers/goto-workflow.ts', import.meta.url),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/\bactor\.send\s*\(/);
      expect(source).not.toMatch(/\bupdateFromActor\s*\(/);
    }
  });

  it('does not write semantic launch initialization in runbook-pipeline', async () => {
    const source = await readFile(
      new URL('../../src/helpers/runbook-pipeline.ts', import.meta.url),
      'utf8',
    );

    expect(source).not.toMatch(/\bensureActiveEntry\s*\(/);
    expect(source).not.toMatch(/\binitializeSubsteps\s*\(/);
    expect(source).not.toMatch(/lastAction\s*:\s*\{\s*type\s*:\s*['"]START['"]/);
  });
});
