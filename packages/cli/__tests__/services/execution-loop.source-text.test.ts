import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('execution.ts FOR boundary (Batch 4)', () => {
  it('does not construct or import ForIterationService', async () => {
    const source = await readFile(new URL('../../src/services/execution.ts', import.meta.url), {
      encoding: 'utf8',
    });

    expect(source).toContain('runExecutionLoop');
    expect(source).not.toMatch(/ForIterationService/);
    expect(source).not.toMatch(/iterationService\s*\.\s*prepareIteration/);
  });

  it('does not catch ForResolutionError', async () => {
    const source = await readFile(new URL('../../src/services/execution.ts', import.meta.url), {
      encoding: 'utf8',
    });

    expect(source).toContain('runExecutionLoop');
    expect(source).not.toMatch(/instanceof\s+ForResolutionError/);
    expect(source).not.toMatch(/err\.code\s*===\s*'policy-violation'/);
  });
});
