import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PathLike } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fs = await import('node:fs/promises');
type RealpathString = (target: PathLike) => Promise<string>;
let realpathImpl: RealpathString = (target) => fs.realpath(target);
const realpathMock = jest.fn<RealpathString>((target) => realpathImpl(target));

jest.unstable_mockModule('node:fs/promises', () => ({
  ...fs,
  realpath: realpathMock,
}));

const {
  assembleArtifactPath,
  assembleRdPath,
  findRdPathFiles,
  resolveRdPathBaseDir,
  validateRdPathCtx,
  validateRdPathFile,
} = await import('../../src/runbook/index.js');

describe('core rdpath utilities', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-core-'));
  });

  afterEach(async () => {
    realpathImpl = (target) => fs.realpath(target);
    realpathMock.mockClear();
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
        path.join('.work', '.rd-ctx_1', '2026-06-15-plan.json'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [{ dir: '.work', ctx: '.' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: '..' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: '../escape' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'ctx/slash' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'ctx\\slash' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'has space' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'has.dot' }, 'Invalid ctx'],
    [{ dir: '.work', ctx: 'bang!' }, 'Invalid ctx'],
    [{ dir: '.work', file: '../plan.md' }, 'Invalid file'],
    [{ dir: '.work', file: '.' }, 'Invalid file'],
  ])('rejects unsafe path options %#', (input, message) => {
    expect(() => assembleRdPath(input)).toThrow(message);
  });

  it('rejects dotted ctx values even though artifact ctx allows dots', () => {
    expect(() => assembleArtifactPath('.work', 'has.dot', 'plan.json')).not.toThrow();
    expect(() => assembleRdPath({ dir: '.work', ctx: 'has.dot' })).toThrow('Invalid ctx');
  });

  it('validates rdpath ctx ids directly', () => {
    expect(() => {
      validateRdPathCtx('abc-123_XYZ');
    }).not.toThrow();
    for (const ctx of ['.', '..', 'has.dot', 'has space', 'ctx/slash', 'ctx\\slash', 'bang!']) {
      expect(() => {
        validateRdPathCtx(ctx);
      }).toThrow('Invalid ctx');
    }
  });

  it('validates rdpath file names directly', () => {
    expect(() => {
      validateRdPathFile('plan.v2.md');
    }).not.toThrow();
    for (const file of ['.', '..', '../plan.md', 'sub/plan.md', 'sub\\plan.md']) {
      expect(() => {
        validateRdPathFile(file);
      }).toThrow('Invalid file');
    }
  });

  it('resolves rdpath base directories directly', () => {
    expect(resolveRdPathBaseDir('.work')).toBe('.work');
    expect(resolveRdPathBaseDir('.work', 'abc-123_XYZ')).toBe(
      path.join('.work', '.rd-abc-123_XYZ'),
    );
    expect(() => resolveRdPathBaseDir('.work', 'has.dot')).toThrow('Invalid ctx');
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

  it('throws when the search dir is a file path', async () => {
    const filePath = path.join(testDir, 'not-a-dir.md');
    await fs.writeFile(filePath, 'x');

    await expect(findRdPathFiles({ dir: filePath }, '*.md')).rejects.toThrow(
      `Not a directory: ${filePath}`,
    );
  });

  it('skips glob matches whose realpath cannot be read with ignored error codes', async () => {
    await fs.writeFile(path.join(testDir, 'ok.md'), 'ok');
    await fs.writeFile(path.join(testDir, 'skip-eacces.md'), 'skip');
    await fs.writeFile(path.join(testDir, 'skip-eperm.md'), 'skip');
    await fs.writeFile(path.join(testDir, 'skip-eloop.md'), 'skip');

    realpathImpl = async (target) => {
      const targetString = String(target);
      const basename = path.basename(targetString);
      const codeByName: Partial<Record<string, string>> = {
        'skip-eacces.md': 'EACCES',
        'skip-eperm.md': 'EPERM',
        'skip-eloop.md': 'ELOOP',
      };
      const code = codeByName[basename];
      if (code !== undefined) {
        throw Object.assign(new Error(code), { code });
      }
      return fs.realpath(target);
    };

    await expect(findRdPathFiles({ dir: testDir }, '*.md')).resolves.toEqual([
      path.join(testDir, 'ok.md'),
    ]);
  });
});
