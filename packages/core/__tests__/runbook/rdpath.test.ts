import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assembleArtifactPath, assembleRdPath, findRdPathFiles } from '../../src/runbook/index.js';

describe('core rdpath utilities', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-core-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('assembles dir-only, ctx, and date-prefixed file paths', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00Z'));
    try {
      expect(assembleRdPath({ dir: '.work' })).toBe('.work');
      expect(assembleRdPath({ dir: '.work', ctx: 'ctx_1' })).toBe(path.join('.work', '.rd-ctx_1'));
      expect(assembleRdPath({ dir: '.work', file: 'plan.json' })).toBe(
        path.join('.work', '2026-06-15-plan.json'),
      );
      expect(assembleRdPath({ dir: '.work', ctx: 'ctx_1', file: 'plan.json' })).toBe(
        assembleArtifactPath('.work', 'ctx_1', 'plan.json'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [{ dir: '.work', ctx: '../escape' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'ctx/slash' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'has.dot' }, 'Invalid ctx'],
    [{ dir: '.work', file: '../plan.md' }, 'Invalid file'],
    [{ dir: '.work', file: '.' }, 'Invalid file'],
  ])('rejects unsafe path options %#', (input, message) => {
    expect(() => assembleRdPath(input)).toThrow(message);
  });

  it('rejects dotted ctx values even though artifact ctx allows dots', () => {
    expect(() => assembleArtifactPath('.work', 'has.dot', 'plan.json')).not.toThrow();
    expect(() => assembleRdPath({ dir: '.work', ctx: 'has.dot' })).toThrow('Invalid ctx');
  });

  it('finds files under an optional context directory and filters symlink escapes', async () => {
    const ctxDir = path.join(testDir, '.rd-ctx1');
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-outside-'));
    try {
      await fs.mkdir(ctxDir);
      await fs.writeFile(path.join(ctxDir, 'match.md'), 'ok');
      await fs.writeFile(path.join(outsideDir, 'secret.md'), 'no');
      await fs.symlink(path.join(outsideDir, 'secret.md'), path.join(ctxDir, 'leak.md'));

      await expect(findRdPathFiles({ dir: testDir, ctx: 'ctx1' }, '*.md')).resolves.toEqual([
        path.join(testDir, '.rd-ctx1', 'match.md'),
      ]);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects traversal and absolute glob patterns', async () => {
    await fs.writeFile(path.join(testDir, 'ok.md'), 'ok');

    await expect(findRdPathFiles({ dir: testDir }, '../*.md')).rejects.toThrow(
      'Invalid pattern: must not contain ".." path segments',
    );
    await expect(findRdPathFiles({ dir: testDir }, '/tmp/*.md')).rejects.toThrow(
      'Invalid pattern: must be relative to the target directory',
    );
  });
});
