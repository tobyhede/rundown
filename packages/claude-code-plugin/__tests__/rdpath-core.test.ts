import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { assemblePath } from '../src/rdpath-core.js';

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
    const today = new Date().toISOString().slice(0, 10);
    const result = assemblePath({ dir: '.work', file: 'test.md' });
    expect(result).toBe(path.join('.work', `${today}-test.md`));
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

    it('accepts valid ctx with alphanumeric, hyphens, and underscores', () => {
      expect(() => assemblePath({ dir: '.work', ctx: 'abc-123_XYZ' })).not.toThrow();
    });

    it('accepts valid file with dots', () => {
      expect(() => assemblePath({ dir: '.work', file: 'plan.v2.md' })).not.toThrow();
    });
  });
});
