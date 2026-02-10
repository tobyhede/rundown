import { describe, it, expect } from '@jest/globals';
import {
  isRunbookComplete,
  isRunbookStopped,
  isValidResult,
  getStepRetryMax,
  deriveAction,
} from '../../src/services/execution.js';
import type { Step } from '@rundown-org/core';

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

  describe('deriveAction', () => {
    // deriveAction params:
    // prevStep, newStep, prevSubstep, newSubstep, prevRetry, newRetry, retryMax, isComplete, isStopped, instance, substepInstance

    it('returns COMPLETE if runbook is complete', () => {
      expect(deriveAction('1', '1', undefined, undefined, 0, 0, 0, true, false)).toBe('COMPLETE');
    });

    it('returns STOP if runbook is stopped', () => {
      expect(deriveAction('1', '1', undefined, undefined, 0, 0, 0, false, true)).toBe('STOP');
    });

    it('returns RETRY if retry count increased', () => {
      expect(deriveAction('1', '1', undefined, undefined, 0, 1, 3, false, false)).toBe('RETRY (1/3)');
    });

    it('returns CONTINUE if sequential step', () => {
      expect(deriveAction('1', '2', undefined, undefined, 0, 0, 0, false, false)).toBe('CONTINUE');
    });

    it('returns GOTO if non-sequential step', () => {
      expect(deriveAction('1', '3', undefined, undefined, 0, 0, 0, false, false)).toBe('GOTO 3');
    });

    it('returns GOTO if steps are not numbers', () => {
      expect(deriveAction('Start', 'End', undefined, undefined, 0, 0, 0, false, false)).toBe('GOTO End');
    });

    it('returns CONTINUE for sequential substeps', () => {
      expect(deriveAction('1', '1', '1', '2', 0, 0, 0, false, false)).toBe('CONTINUE');
    });

    it('returns GOTO for non-sequential substeps', () => {
      expect(deriveAction('1', '1', '1', '3', 0, 0, 0, false, false)).toBe('GOTO 1.3');
    });
  });
});
