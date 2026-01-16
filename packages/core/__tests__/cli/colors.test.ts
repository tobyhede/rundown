import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  isColorEnabled,
  setColorEnabled,
  resetColorCache,
  success,
  failure,
  warning,
  info,
  dim,
  bold,
  colorizeStatus,
  colorizeResult,
} from '../../src/cli/colors.js';

describe('colors', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetColorCache();
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetColorCache();
  });

  describe('isColorEnabled', () => {
    it('returns false when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      expect(isColorEnabled()).toBe(false);
    });

    it('returns false when NO_COLOR is empty string', () => {
      process.env.NO_COLOR = '';
      expect(isColorEnabled()).toBe(false);
    });

    it('respects FORCE_COLOR=1', () => {
      process.env.FORCE_COLOR = '1';
      expect(isColorEnabled()).toBe(true);
    });

    it('respects FORCE_COLOR=0', () => {
      process.env.FORCE_COLOR = '0';
      expect(isColorEnabled()).toBe(false);
    });

    it('NO_COLOR takes precedence over FORCE_COLOR', () => {
      process.env.NO_COLOR = '1';
      process.env.FORCE_COLOR = '1';
      expect(isColorEnabled()).toBe(false);
    });
  });

  describe('setColorEnabled', () => {
    it('can programmatically enable colors', () => {
      setColorEnabled(true);
      expect(isColorEnabled()).toBe(true);
    });

    it('can programmatically disable colors', () => {
      setColorEnabled(false);
      expect(isColorEnabled()).toBe(false);
    });
  });

  describe('color functions with colors enabled', () => {
    beforeEach(() => {
      setColorEnabled(true);
    });

    it('success adds green color', () => {
      expect(success('PASS')).toContain('\x1b[32m');
      expect(success('PASS')).toContain('\x1b[0m');
    });

    it('failure adds red color', () => {
      expect(failure('FAIL')).toContain('\x1b[31m');
    });

    it('warning adds yellow color', () => {
      expect(warning('warning')).toContain('\x1b[33m');
    });

    it('info adds cyan color', () => {
      expect(info('info')).toContain('\x1b[36m');
    });

    it('dim adds gray color', () => {
      expect(dim('dimmed')).toContain('\x1b[90m');
    });

    it('bold adds bold style', () => {
      expect(bold('bold')).toContain('\x1b[1m');
    });
  });

  describe('color functions with colors disabled', () => {
    beforeEach(() => {
      setColorEnabled(false);
    });

    it('success returns plain text', () => {
      expect(success('PASS')).toBe('PASS');
    });

    it('failure returns plain text', () => {
      expect(failure('FAIL')).toBe('FAIL');
    });
  });

  describe('colorizeStatus', () => {
    beforeEach(() => {
      setColorEnabled(true);
    });

    it('colors active status green', () => {
      expect(colorizeStatus('active')).toContain('\x1b[32m');
    });

    it('colors running status green', () => {
      expect(colorizeStatus('running')).toContain('\x1b[32m');
    });

    it('colors stashed status yellow', () => {
      expect(colorizeStatus('stashed')).toContain('\x1b[33m');
    });

    it('colors complete status green', () => {
      expect(colorizeStatus('complete')).toContain('\x1b[32m');
    });

    it('colors stopped status red', () => {
      expect(colorizeStatus('stopped')).toContain('\x1b[31m');
    });

    it('colors inactive status gray', () => {
      expect(colorizeStatus('inactive')).toContain('\x1b[90m');
    });

    it('colors unknown status gray', () => {
      expect(colorizeStatus('unknown')).toContain('\x1b[90m');
    });

    it('is case insensitive', () => {
      expect(colorizeStatus('ACTIVE')).toContain('\x1b[32m');
      expect(colorizeStatus('Active')).toContain('\x1b[32m');
    });
  });

  describe('colorizeResult', () => {
    beforeEach(() => {
      setColorEnabled(true);
    });

    it('colors PASS green', () => {
      expect(colorizeResult('PASS')).toContain('\x1b[32m');
    });

    it('colors FAIL red', () => {
      expect(colorizeResult('FAIL')).toContain('\x1b[31m');
    });

    it('is case insensitive for matching', () => {
      expect(colorizeResult('pass')).toContain('\x1b[32m');
      expect(colorizeResult('fail')).toContain('\x1b[31m');
    });

    it('returns unknown results unchanged', () => {
      expect(colorizeResult('SKIP')).toBe('SKIP');
    });
  });
});
