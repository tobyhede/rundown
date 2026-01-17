import { describe, it, expect } from '@jest/globals';
import { extractDisplayCommand } from '../../src/cli/index.js';

describe('extractDisplayCommand', () => {
  it('returns original command for non-echo commands', () => {
    expect(extractDisplayCommand('npm run build')).toBe('npm run build');
    expect(extractDisplayCommand('npm test')).toBe('npm test');
    expect(extractDisplayCommand('git status')).toBe('git status');
  });

  it('extracts command from rd echo with --result flag', () => {
    expect(extractDisplayCommand('rd echo --result fail npm run deploy:check')).toBe(
      'npm run deploy:check'
    );
  });

  it('extracts command from rd echo with -r flag', () => {
    expect(extractDisplayCommand('rd echo -r pass npm test')).toBe('npm test');
  });

  it('extracts command from rundown echo', () => {
    expect(extractDisplayCommand('rundown echo --result pass npm run build')).toBe(
      'npm run build'
    );
  });

  it('handles multiple --result flags', () => {
    expect(
      extractDisplayCommand('rd echo --result fail --result pass npm run deploy:check')
    ).toBe('npm run deploy:check');
  });

  it('handles mixed -r and --result flags', () => {
    expect(extractDisplayCommand('rd echo -r fail --result pass npm test')).toBe('npm test');
  });

  it('handles command with special characters', () => {
    expect(extractDisplayCommand('rd echo --result pass npm run "test:e2e"')).toBe(
      'npm run "test:e2e"'
    );
  });

  it('handles empty result after stripping', () => {
    // Edge case: just rd echo with result flags, no actual command
    expect(extractDisplayCommand('rd echo --result pass')).toBe('');
  });
});
