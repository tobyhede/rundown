// __tests__/security/path-traversal.test.ts
// Security tests for the surviving path-utility helpers.

import { isPathInside, safeJoin, sanitizePathSegment } from '../../src/shared/utils.js';
import * as path from 'node:path';

describe('Path Jail Security', () => {
  describe('path utilities', () => {
    describe('isPathInside', () => {
      it('returns true for paths inside base', () => {
        expect(isPathInside('/base', '/base/file.txt')).toBe(true);
        expect(isPathInside('/base', '/base/subdir/file.txt')).toBe(true);
      });

      it('returns false for paths outside base', () => {
        expect(isPathInside('/base', '/base/../outside.txt')).toBe(false);
        expect(isPathInside('/base', '/outside.txt')).toBe(false);
        expect(isPathInside('/base', '/base-extra/file.txt')).toBe(false);
      });

      it('returns false for base itself (empty relative path)', () => {
        expect(isPathInside('/base', '/base')).toBe(false);
      });
    });

    describe('safeJoin', () => {
      it('joins paths inside base', () => {
        expect(safeJoin('/base', 'file.txt')).toBe(path.join('/base', 'file.txt'));
        expect(safeJoin('/base', 'subdir', 'file.txt')).toBe(
          path.join('/base', 'subdir', 'file.txt'),
        );
      });

      it('throws for path traversal', () => {
        expect(() => safeJoin('/base', '../outside.txt')).toThrow(/security violation/i);
        expect(() => safeJoin('/base', 'subdir', '../../outside.txt')).toThrow(
          /security violation/i,
        );
      });
    });

    describe('sanitizePathSegment', () => {
      it('removes path separators', () => {
        expect(sanitizePathSegment('foo/bar')).toBe('foo_bar');
        expect(sanitizePathSegment('foo\\bar')).toBe('foo_bar');
      });

      it('removes parent references', () => {
        expect(sanitizePathSegment('..')).toBe('__');
        expect(sanitizePathSegment('../../etc/passwd')).toBe('______etc_passwd');
      });
    });
  });
});
