import { describe, expect, it } from '@jest/globals';
import { assertContainedPath } from '../../src/helpers/path-containment.js';

describe('assertContainedPath', () => {
  it('treats the filesystem root as containing absolute child paths', () => {
    expect(() => {
      assertContainedPath('/', '/tmp/file.txt', 'escaped');
    }).not.toThrow();
  });

  it('rejects sibling paths with a shared prefix', () => {
    expect(() => {
      assertContainedPath('/tmp/root', '/tmp/root-other/file.txt', 'escaped');
    }).toThrow('escaped');
  });
});
