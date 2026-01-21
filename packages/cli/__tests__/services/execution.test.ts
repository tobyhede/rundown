import { describe, it, expect, jest } from '@jest/globals';
import {
  isRunbookComplete,
  isRunbookStopped,
  isValidResult,
  getStepRetryMax,
  deriveAction,
  handleNextInstanceFlags,
} from '../../src/services/execution.js';
// We mock RunbookStateManager
import type { RunbookStateManager, Step, Substep, RunbookState } from '@rundown-org/core';

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

    it('resolves placeholders in GOTO', () => {
      // deriveAction(prevStep, newStep, prevSubstep, newSubstep, ...)
      // instance=5
      expect(deriveAction('1', '{N}', undefined, undefined, 0, 0, 0, false, false, 5)).toBe('GOTO 5');
    });

     it('resolves placeholders in GOTO substep', () => {
       // instance=5, substepInstance=2
       // GOTO {N}.{n} -> GOTO 5.2
       expect(deriveAction('1', '{N}', '1', '{n}', 0, 0, 0, false, false, 5, 2)).toBe('GOTO 5.2');
    });
  });

  describe('handleNextInstanceFlags', () => {
    let mockManager: jest.Mocked<RunbookStateManager>;
    let mockState: RunbookState;

    beforeEach(() => {
      mockManager = {
        update: jest.fn(),
        addDynamicSubstep: jest.fn(),
      } as unknown as jest.Mocked<RunbookStateManager>;
      
      mockState = {
        step: '{N}',
        instance: 1,
        runbook: 'test.md',
        runbookPath: '/path/to/test.md',
        id: 'run-1',
        status: 'running',
        variables: {},
        retryCount: 0,
        substepStates: []
      } as RunbookState;
    });

    it('increments instance when nextInstance is true', async () => {
      const snapshot = { context: { nextInstance: true } };
      mockManager.update.mockResolvedValue({ ...mockState, instance: 2 });

      await handleNextInstanceFlags(
        snapshot,
        mockState,
        mockManager,
        'run-1',
        [],
        false,
        false
      );

      expect(mockManager.update).toHaveBeenCalledWith('run-1', {
        instance: 2,
        substep: '1'
      });
    });

    it('does not increment instance if runbook complete', async () => {
      const snapshot = { context: { nextInstance: true } };
      await handleNextInstanceFlags(
        snapshot,
        mockState,
        mockManager,
        'run-1',
        [],
        true, // isComplete
        false
      );
      expect(mockManager.update).not.toHaveBeenCalled();
    });

    it('handles nextSubstepInstance', async () => {
      const snapshot = { context: { nextSubstepInstance: true } };
      const steps = [
        { name: '{N}', isDynamic: true, substeps: [{ isDynamic: true }] }
      ] as unknown as Step[];

      mockManager.addDynamicSubstep.mockResolvedValue('sub-2');
      mockManager.update.mockResolvedValue({ ...mockState, substep: 'sub-2' });

      await handleNextInstanceFlags(
        snapshot,
        mockState,
        mockManager,
        'run-1',
        steps,
        false,
        false
      );

      expect(mockManager.addDynamicSubstep).toHaveBeenCalledWith('run-1');
      expect(mockManager.update).toHaveBeenCalledWith('run-1', {
        substep: 'sub-2'
      });
    });

    it('ignores nextSubstepInstance if no dynamic substep in definition', async () => {
       const snapshot = { context: { nextSubstepInstance: true } };
       const steps = [
         { name: '{N}', isDynamic: true, substeps: [{ isDynamic: false }] } // No dynamic substep
       ] as unknown as Step[];
 
       await handleNextInstanceFlags(
         snapshot,
         mockState,
         mockManager,
         'run-1',
         steps,
         false,
         false
       );
 
       expect(mockManager.addDynamicSubstep).not.toHaveBeenCalled();
    });
  });
});
