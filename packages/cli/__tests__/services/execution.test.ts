import { describe, it, expect } from '@jest/globals';
import {
  isRunbookComplete,
  isRunbookStopped,
  isValidResult,
  getStepRetryMax,
  buildStepVariables,
} from '../../src/services/execution.js';
import type { Step, ForContext } from '@rundown-org/core';

describe('execution service', () => {
  describe('isRunbookComplete', () => {
    it('returns true when status is done and value is COMPLETE', () => {
      expect(isRunbookComplete({ status: 'done', value: 'COMPLETE' })).toBe(true);
    });

    it('returns false when status is not done', () => {
      expect(isRunbookComplete({ status: 'active', value: 'COMPLETE' })).toBe(false);
    });

    it('returns false when value is not COMPLETE', () => {
      expect(isRunbookComplete({ status: 'done', value: 'STOPPED' })).toBe(false);
    });
  });

  describe('isRunbookStopped', () => {
    it('returns true when status is done and value is STOPPED', () => {
      expect(isRunbookStopped({ status: 'done', value: 'STOPPED' })).toBe(true);
    });

    it('returns false when status is not done', () => {
      expect(isRunbookStopped({ status: 'active', value: 'STOPPED' })).toBe(false);
    });

    it('returns false when value is not STOPPED', () => {
      expect(isRunbookStopped({ status: 'done', value: 'COMPLETE' })).toBe(false);
    });
  });

  describe('isValidResult', () => {
    it('returns true for pass', () => {
      expect(isValidResult('pass')).toBe(true);
    });
    it('returns true for fail', () => {
      expect(isValidResult('fail')).toBe(true);
    });
    it('returns false for other strings', () => {
      expect(isValidResult('other')).toBe(false);
      expect(isValidResult('')).toBe(false);
    });
  });

  describe('getStepRetryMax', () => {
    it('returns fail retry count if present', () => {
      const step = {
        transitions: {
          fail: { retry: 3 },
          pass: { retry: 0 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(3);
    });

    it('returns pass retry count if fail retry is 0', () => {
      const step = {
        transitions: {
          fail: { retry: 0 },
          pass: { retry: 2 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(2);
    });

    it('returns 0 if no retry', () => {
      const step = {
        transitions: {
          fail: { retry: 0 },
          pass: { retry: 0 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(0);
    });

    it('returns 0 if transitions missing', () => {
      const step = {} as unknown as Step;
      expect(getStepRetryMax(step)).toBe(0);
    });
  });

  describe('buildStepVariables', () => {
    it('returns Step for simple step', () => {
      const vars = buildStepVariables('3', undefined);
      expect(vars).toEqual({ Step: '3' });
    });

    it('returns Step for substep', () => {
      const vars = buildStepVariables('3', '1');
      expect(vars).toEqual({ Step: '3.1' });
    });

    it('returns Step for named step', () => {
      const vars = buildStepVariables('ErrorHandler', undefined);
      expect(vars).toEqual({ Step: 'ErrorHandler' });
    });

    it('returns Index and named variable from forStack', () => {
      const vars = buildStepVariables('1', '1', [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'batch',
          implicit: false,
          source: { kind: 'range' },
        },
      ]);
      expect(vars).toMatchObject({ Step: '1.1', Index: '2', batch: '2' });
    });

    it('omits Index for implicit ForContext', () => {
      const vars = buildStepVariables('1', '1', [
        { stepId: '1', iteration: 1, start: 1, end: 1, implicit: true },
      ]);
      expect(vars).toEqual({ Step: '1.1' });
      expect(vars).not.toHaveProperty('Index');
    });

    it('falls back to forClause when forStack empty', () => {
      const vars = buildStepVariables('1', '1', [], { start: 1, end: 3 });
      expect(vars).toMatchObject({ Step: '1.1', Index: '1' });
    });
  });

  describe('buildStepVariables with data sources', () => {
    it('resolves array source value from currentValue', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'server',
          implicit: false,
          source: { kind: 'array', items: ['alpha', 'beta', 'gamma'] },
          currentValue: 'beta',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.server).toBe('beta');
      expect(vars.Index).toBe('2');
    });

    it('resolves range source value as iteration number (unchanged behavior)', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          variable: 'i',
          implicit: false,
          source: { kind: 'range' },
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.i).toBe('3');
      expect(vars.Index).toBe('3');
    });

    it('resolves file source value from currentValue', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'host',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/hosts.txt',
            format: 'text' as const,
            snapshot: { line: 1, size: 10, mtimeMs: 100 },
          },
          currentValue: 'web-server-01',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.host).toBe('web-server-01');
      expect(vars.Index).toBe('1');
    });
  });
});
