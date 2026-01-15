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
});
