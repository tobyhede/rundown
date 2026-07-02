import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  existsSync: jest.fn(),
}));
const { existsSync } = await import('node:fs');
const { buildSpec } = await import('../../src/sandbox/linux.js');
import type { SandboxOptions } from '../../src/sandbox/types.js';

const base: SandboxOptions = {
  cwd: '/repo',
  repoRoot: '/repo',
  readOnlyPaths: ['/repo'],
  readWritePaths: ['/repo/dist'],
  denyPaths: [],
  denyPatterns: [],
  env: {},
  allowUnsandboxed: false,
};

describe('buildSpec', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies grants and derives strict from allowUnsandboxed', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    const spec = buildSpec('echo hi', base);
    expect(spec.command).toBe('echo hi');
    expect(spec.strict).toBe(true);
    expect(spec.rox).toEqual(expect.arrayContaining(['/usr', '/bin']));
    expect(spec.ro).toEqual(expect.arrayContaining(['/repo', '/etc']));
    expect(spec.rw).toEqual(expect.arrayContaining(['/repo/dist', '/dev/null']));
  });

  it('sets strict=false when allowUnsandboxed', () => {
    (existsSync as jest.Mock).mockReturnValue(true);
    expect(buildSpec('x', { ...base, allowUnsandboxed: true }).strict).toBe(false);
  });

  it('filters non-existent grant paths (Landlock aborts on missing paths)', () => {
    (existsSync as jest.Mock).mockImplementation(
      (p: unknown) => p !== '/lib64' && p !== '/repo/dist' && p !== '/dev/random',
    );
    const spec = buildSpec('x', base);
    expect(spec.rox).not.toContain('/lib64');
    expect(spec.rw).not.toContain('/repo/dist');
    expect(spec.rw).not.toContain('/dev/random');
    expect(spec.rw).toContain('/dev/null');
  });
});
