import { describe, expect, it } from '@jest/globals';
import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';

const forbiddenProductionPatterns = [
  ['CLI-owned execution loop', /\brunExecutionLoop\s*\(/],
  ['CLI-owned completion drain', /\bdrainResolvedCompletions\s*\(/],
  ['refusal hand-back overload', /\breturnRefusals\s*[:=]/],
  ['unfenced actor mutation', /(?:\.|\basync\s+)sendAndSync\s*\(/],
  ['legacy inline parent callable', /\bAdvanceInlineParent\b/],
  ['legacy upward propagation', /\bpropagateTerminalChildUpward\b/],
  ['legacy upward result contract', /\bTerminalUpwardPropagationResult\b/],
  ['temporary manual-abort bridge event', /\bMANUAL_DELEGATION_ABORT_PREPARED\b/],
  ['frontend inline flow-back decision', /\bflowBackInlineTerminal\s*\(/, 'cli'],
  ['frontend delegated-report decision', /\breportDelegatedTerminal\s*\(/, 'cli'],
] as const;

describe('Run Progression architecture (#858)', () => {
  it('keeps deleted progression paths out of production sources', async () => {
    const packageRoot = path.resolve(import.meta.dirname, '../..');
    const repoRoot = path.resolve(packageRoot, '../..');
    const files: string[] = [];
    for await (const file of glob('packages/{cli,core}/src/**/*.ts', { cwd: repoRoot })) {
      files.push(file);
    }

    const violations: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(repoRoot, file), 'utf8');
      const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const [name, pattern, scope] of forbiddenProductionPatterns) {
        if (scope === 'cli' && !file.startsWith('packages/cli/')) continue;
        if (pattern.test(executableSource)) violations.push(`${file}: ${name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
