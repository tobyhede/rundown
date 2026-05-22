import { describe, expect, it } from '@jest/globals';
import { assertSafeRelativeArtifactPath } from '../../src/helpers/artifact-path.js';

describe('assertSafeRelativeArtifactPath', () => {
  it('allows filenames that contain dot-dot without parent traversal', () => {
    expect(() => {
      assertSafeRelativeArtifactPath('schemas/..schema.json', 'unsafe');
    }).not.toThrow();
  });

  it.each([
    '../schema.json',
    'schemas/../review.schema.json',
    './schema.json',
    'schemas//x.json',
  ])('rejects unsafe path segments in %s', (ref) => {
    expect(() => {
      assertSafeRelativeArtifactPath(ref, 'unsafe');
    }).toThrow('unsafe');
  });
});
