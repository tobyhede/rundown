import { describe, it, expect } from '@jest/globals';
import { resolveHelperPath } from '../../src/sandbox/linux.js';

describe('resolveHelperPath', () => {
  it('maps x64 to linux-x64', () => {
    expect(resolveHelperPath('x64', '/pkg/dist')).toBe('/pkg/dist/native/linux-x64/rd-landlock');
  });

  it('maps arm64 to linux-arm64', () => {
    expect(resolveHelperPath('arm64', '/pkg/dist')).toBe(
      '/pkg/dist/native/linux-arm64/rd-landlock',
    );
  });

  it('returns null for unsupported arches (never falls back to x64)', () => {
    expect(resolveHelperPath('ppc64', '/pkg/dist')).toBeNull();
    expect(resolveHelperPath('s390x', '/pkg/dist')).toBeNull();
    expect(resolveHelperPath('ia32', '/pkg/dist')).toBeNull();
  });
});
