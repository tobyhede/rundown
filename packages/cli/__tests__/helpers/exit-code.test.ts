import { describe, expect, it } from '@jest/globals';
import { assertExitCodeClean, takeExitCode } from './exit-code.js';

describe('assertExitCodeClean', () => {
  it('accepts an unset exit code', () => {
    expect(() => {
      assertExitCodeClean(undefined, 'some test');
    }).not.toThrow();
  });

  it('accepts a null exit code, which also means unset', () => {
    expect(() => {
      assertExitCodeClean(null, 'some test');
    }).not.toThrow();
  });

  it('rejects a failure exit code', () => {
    expect(() => {
      assertExitCodeClean(1, 'some test');
    }).toThrow(/left process\.exitCode = 1/);
  });

  it('rejects a zero exit code, which is still an uncleaned assignment', () => {
    expect(() => {
      assertExitCodeClean(0, 'some test');
    }).toThrow(/left process\.exitCode = 0/);
  });

  it('rejects a string exit code', () => {
    expect(() => {
      assertExitCodeClean('1', 'some test');
    }).toThrow(/left process\.exitCode = 1/);
  });

  it('names the offending test and the remedy', () => {
    expect(() => {
      assertExitCodeClean(1, 'claim rejects a malformed bearer');
    }).toThrow(/"claim rejects a malformed bearer"/);

    expect(() => {
      assertExitCodeClean(1, 'some test');
    }).toThrow(/takeExitCode\(\)/);
  });
});

describe('takeExitCode', () => {
  it('returns undefined and leaves the process clean when nothing was assigned', () => {
    expect(takeExitCode()).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it('returns the assigned code and clears it', () => {
    process.exitCode = 1;

    expect(takeExitCode()).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('normalises a string exit code to a number', () => {
    process.exitCode = '2';

    expect(takeExitCode()).toBe(2);
    expect(process.exitCode).toBeUndefined();
  });
});
