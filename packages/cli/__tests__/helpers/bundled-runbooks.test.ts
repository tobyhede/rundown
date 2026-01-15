import { describe, it, expect } from '@jest/globals';
import { getBundledRunbooksPath } from '../../src/helpers/bundled-runbooks.js';

describe('getBundledRunbooksPath', () => {
  it('returns path ending with runbooks directory', () => {
    const bundledPath = getBundledRunbooksPath();
    expect(bundledPath).toMatch(/runbooks$/);
  });

  it('returns absolute path', () => {
    const bundledPath = getBundledRunbooksPath();
    expect(bundledPath.startsWith('/')).toBe(true);
  });

  describe('environment variable override', () => {
    it('uses BUNDLED_RUNBOOKS_PATH when set', () => {
      const originalPath = process.env.BUNDLED_RUNBOOKS_PATH;
      process.env.BUNDLED_RUNBOOKS_PATH = '/custom/path/runbooks';

      try {
        const bundledPath = getBundledRunbooksPath();
        expect(bundledPath).toBe('/custom/path/runbooks');
      } finally {
        if (originalPath) {
          process.env.BUNDLED_RUNBOOKS_PATH = originalPath;
        } else {
          delete process.env.BUNDLED_RUNBOOKS_PATH;
        }
      }
    });
  });
});
