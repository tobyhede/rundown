import { describe, expect, it } from '@jest/globals';
import { isLaunchDir, launchDirFor, resolveLaunchDir } from '../../src/runbook/launch-dir.js';

describe('launch directory', () => {
  it('records the project root itself as "."', () => {
    expect(launchDirFor('/repo', '/repo')).toBe('.');
  });

  it('records a sub-package relative to the project root', () => {
    expect(launchDirFor('/repo', '/repo/packages/svc')).toBe('packages/svc');
  });

  it('refuses an invocation directory outside the project root', () => {
    expect(() => launchDirFor('/repo', '/elsewhere')).toThrow('is not inside project root');
  });

  it('resolves a persisted launch directory under whichever root continues the run', () => {
    expect(resolveLaunchDir('/moved/repo', 'packages/svc')).toBe('/moved/repo/packages/svc');
    expect(resolveLaunchDir('/repo', '.')).toBe('/repo');
  });

  it.each(['.', 'packages/svc', 'a'])('accepts %p', (value) => {
    expect(isLaunchDir(value)).toBe(true);
  });

  it.each(['', '/abs', '..', '../x', 'a/../b', './a', 'a/'])('rejects %p', (value) => {
    expect(isLaunchDir(value)).toBe(false);
  });
});
