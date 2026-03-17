import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assemblePath, findFiles } from '../src/rdpath-core.js';

describe('assemblePath', () => {
  it('returns dir when only dir provided', () => {
    expect(assemblePath({ dir: '.work' })).toBe('.work');
  });

  it('appends .rd-<ctx> subdirectory when ctx provided', () => {
    const result = assemblePath({ dir: '.work', ctx: 'abc123' });
    expect(result).toBe(path.join('.work', '.rd-abc123'));
  });

  it('prepends YYYY-MM-DD to filename when file provided', () => {
    const result = assemblePath({ dir: '.work', file: 'plan.md' });
    // Verify date prefix pattern
    expect(result).toMatch(new RegExp(`^\\.work\\${path.sep}\\d{4}-\\d{2}-\\d{2}-plan\\.md$`));
  });

  it('combines dir, ctx, and file correctly', () => {
    const result = assemblePath({ dir: '.work', ctx: 'abc123', file: 'review.md' });
    // Verify structure: .work/.rd-abc123/YYYY-MM-DD-review.md
    expect(result).toMatch(
      new RegExp(`^\\.work\\${path.sep}\\.rd-abc123\\${path.sep}\\d{4}-\\d{2}-\\d{2}-review\\.md$`),
    );
  });

  it('uses current date for date prefix', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T12:00:00Z'));
    try {
      const result = assemblePath({ dir: '.work', file: 'test.md' });
      expect(result).toBe(path.join('.work', '2026-06-15-test.md'));
    } finally {
      jest.useRealTimers();
    }
  });

  describe('input validation', () => {
    it('rejects ctx with path separators', () => {
      expect(() => assemblePath({ dir: '.work', ctx: 'foo/bar' })).toThrow('Invalid ctx');
      expect(() => assemblePath({ dir: '.work', ctx: 'foo\\bar' })).toThrow('Invalid ctx');
    });

    it('rejects ctx with traversal', () => {
      expect(() => assemblePath({ dir: '.work', ctx: '..' })).toThrow('Invalid ctx');
      expect(() => assemblePath({ dir: '.work', ctx: '../escape' })).toThrow('Invalid ctx');
    });

    it('rejects file with path separators', () => {
      expect(() => assemblePath({ dir: '.work', file: 'sub/file.md' })).toThrow('Invalid file');
      expect(() => assemblePath({ dir: '.work', file: 'sub\\file.md' })).toThrow('Invalid file');
    });

    it('rejects file that is exactly ..', () => {
      expect(() => assemblePath({ dir: '.work', file: '..' })).toThrow('Invalid file');
    });

    it('rejects file that is exactly .', () => {
      expect(() => assemblePath({ dir: '.work', file: '.' })).toThrow('Invalid file');
    });

    it('accepts valid ctx with alphanumeric, hyphens, and underscores', () => {
      expect(() => assemblePath({ dir: '.work', ctx: 'abc-123_XYZ' })).not.toThrow();
    });

    it('accepts valid file with dots', () => {
      expect(() => assemblePath({ dir: '.work', file: 'plan.v2.md' })).not.toThrow();
    });
  });
});

describe('findFiles', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdpath-find-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns matching files for simple glob', async () => {
    await fs.writeFile(path.join(testDir, '2026-03-17-pass1.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-pass2.md'), '');
    await fs.writeFile(path.join(testDir, '2026-03-17-fail.md'), '');

    const results = await findFiles({ dir: testDir }, '*-pass*.md');

    expect(results).toHaveLength(2);
    expect(results).toEqual([
      path.join(testDir, '2026-03-17-pass1.md'),
      path.join(testDir, '2026-03-17-pass2.md'),
    ]);
  });

  it('returns empty array when no files match', async () => {
    await fs.writeFile(path.join(testDir, 'something.txt'), '');

    const results = await findFiles({ dir: testDir }, '*.md');

    expect(results).toEqual([]);
  });

  it('throws for nonexistent directory', async () => {
    await expect(findFiles({ dir: path.join(testDir, 'nope') }, '*.md')).rejects.toThrow(
      'Directory not found',
    );
  });

  it('handles ctx scoping', async () => {
    const ctxDir = path.join(testDir, '.rd-ctx1');
    await fs.mkdir(ctxDir);
    await fs.writeFile(path.join(ctxDir, 'match.md'), '');
    // File outside ctx dir should not match
    await fs.writeFile(path.join(testDir, 'match.md'), '');

    const results = await findFiles({ dir: testDir, ctx: 'ctx1' }, '*.md');

    expect(results).toEqual([path.join(testDir, '.rd-ctx1', 'match.md')]);
  });

  it('returns assembled paths with dir prefix', async () => {
    await fs.writeFile(path.join(testDir, 'file.md'), '');

    const results = await findFiles({ dir: testDir }, '*.md');

    expect(results).toEqual([path.join(testDir, 'file.md')]);
  });

  it('returns results sorted lexicographically', async () => {
    await fs.writeFile(path.join(testDir, 'charlie.md'), '');
    await fs.writeFile(path.join(testDir, 'alpha.md'), '');
    await fs.writeFile(path.join(testDir, 'bravo.md'), '');

    const results = await findFiles({ dir: testDir }, '*.md');

    expect(results).toEqual([
      path.join(testDir, 'alpha.md'),
      path.join(testDir, 'bravo.md'),
      path.join(testDir, 'charlie.md'),
    ]);
  });

  it('rejects pattern with .. traversal segments', async () => {
    await expect(findFiles({ dir: testDir }, '../*.md')).rejects.toThrow(
      'Invalid pattern: must not contain ".." path segments',
    );
    await expect(findFiles({ dir: testDir }, 'sub/../../*.md')).rejects.toThrow(
      'Invalid pattern: must not contain ".." path segments',
    );
  });

  it('rejects invalid ctx', async () => {
    await expect(findFiles({ dir: testDir, ctx: '../escape' }, '*.md')).rejects.toThrow(
      'Invalid ctx',
    );
  });

  it('returns empty array for empty directory', async () => {
    const results = await findFiles({ dir: testDir }, '*.md');
    expect(results).toEqual([]);
  });

  it('handles recursive glob pattern', async () => {
    const subDir = path.join(testDir, 'sub');
    await fs.mkdir(subDir);
    await fs.writeFile(path.join(testDir, 'top.md'), '');
    await fs.writeFile(path.join(subDir, 'nested.md'), '');

    const results = await findFiles({ dir: testDir }, '**/*.md');

    expect(results).toEqual([
      path.join(testDir, 'sub', 'nested.md'),
      path.join(testDir, 'top.md'),
    ]);
  });

  it('handles exact filename match', async () => {
    await fs.writeFile(path.join(testDir, 'exact.md'), '');
    await fs.writeFile(path.join(testDir, 'other.md'), '');

    const results = await findFiles({ dir: testDir }, 'exact.md');

    expect(results).toEqual([path.join(testDir, 'exact.md')]);
  });
});
