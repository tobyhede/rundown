import { describe, expect, it } from '@jest/globals';
import {
  extractLastAction,
  extractRetryMax,
  extractRetryDisplayCount,
  extractLastMessage,
  formatActionForDisplay,
  formatTransitionAction,
  parseActionType,
  deriveTransitionMessage,
} from '../../src/runbook/transition-kernel.js';
import type { Step, LastAction } from '../../src/runbook/types.js';

describe('transition-kernel', () => {
  describe('extractLastAction', () => {
    describe('valid action types', () => {
      it('extracts START action', () => {
        const snapshot = { context: { lastAction: { type: 'START' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'START' });
      });

      it('extracts CONTINUE action', () => {
        const snapshot = { context: { lastAction: { type: 'CONTINUE' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'CONTINUE' });
      });

      it('extracts COMPLETE action', () => {
        const snapshot = { context: { lastAction: { type: 'COMPLETE' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'COMPLETE' });
      });

      it('extracts STOP action', () => {
        const snapshot = { context: { lastAction: { type: 'STOP' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'STOP' });
      });

      it('extracts RETRY action', () => {
        const snapshot = { context: { lastAction: { type: 'RETRY' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'RETRY' });
      });

      it('extracts NEXT action', () => {
        const snapshot = { context: { lastAction: { type: 'NEXT' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'NEXT' });
      });

      it('extracts BREAK action', () => {
        const snapshot = { context: { lastAction: { type: 'BREAK' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'BREAK' });
      });
    });

    describe('GOTO action variants', () => {
      it('extracts GOTO with target only', () => {
        const snapshot = { context: { lastAction: { type: 'GOTO', target: '5' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', target: '5' });
      });

      it('extracts GOTO with substep', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', target: '3', substep: 'a' } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', target: '3', substep: 'a' });
      });

      it('extracts GOTO with at number', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', target: '2', at: 1000 } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', target: '2', at: 1000 });
      });

      it('extracts GOTO with at string template', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', target: '4', at: '{{delay}}' },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', target: '4', at: '{{delay}}' });
      });

      it('extracts GOTO with all properties', () => {
        const snapshot = {
          context: {
            lastAction: {
              type: 'GOTO',
              target: '6',
              substep: 'b',
              at: 500,
            },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({
          type: 'GOTO',
          target: '6',
          substep: 'b',
          at: 500,
        });
      });
    });

    describe('invalid snapshots', () => {
      it('returns undefined for null snapshot', () => {
        const result = extractLastAction(null);
        expect(result).toBeUndefined();
      });

      it('returns undefined for undefined snapshot', () => {
        const result = extractLastAction(undefined);
        expect(result).toBeUndefined();
      });

      it('returns undefined for non-object snapshot', () => {
        const result = extractLastAction('not an object');
        expect(result).toBeUndefined();
      });

      it('returns undefined when context is missing', () => {
        const snapshot = { noContext: true };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('returns undefined when context is not an object', () => {
        const snapshot = { context: 'not an object' };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('returns undefined when lastAction is missing', () => {
        const snapshot = { context: { otherField: 'value' } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });
    });

    describe('isLastAction guard (tested via extractLastAction)', () => {
      it('rejects GOTO without target', () => {
        const snapshot = { context: { lastAction: { type: 'GOTO' } } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-string target', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', target: 123 } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-string substep', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', target: '5', substep: 123 },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-number/non-string at', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', target: '5', at: true },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects unknown action type', () => {
        const snapshot = { context: { lastAction: { type: 'UNKNOWN' } } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects non-object lastAction value', () => {
        const snapshot = { context: { lastAction: 'not an object' } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects array value', () => {
        const snapshot = { context: { lastAction: [] } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects null value', () => {
        const snapshot = { context: { lastAction: null } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects non-string type field', () => {
        const snapshot = { context: { lastAction: { type: 123 } } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });
    });
  });

  describe('extractRetryMax', () => {
    it('returns retryMax from snapshot context', () => {
      const snapshot = { context: { retryMax: 5 } };
      const result = extractRetryMax(snapshot);
      expect(result).toBe(5);
    });

    it('returns 0 when context is missing', () => {
      const snapshot = {};
      const result = extractRetryMax(snapshot);
      expect(result).toBe(0);
    });

    it('returns 0 when retryMax is missing', () => {
      const snapshot = { context: { otherField: 'value' } };
      const result = extractRetryMax(snapshot);
      expect(result).toBe(0);
    });

    it('returns 0 when retryMax is undefined', () => {
      const snapshot = { context: { retryMax: undefined } };
      const result = extractRetryMax(snapshot);
      expect(result).toBe(0);
    });

    it('returns 0 for null snapshot', () => {
      const result = extractRetryMax(null);
      expect(result).toBe(0);
    });

    it('returns 0 when context is not an object', () => {
      const snapshot = { context: 'not an object' };
      const result = extractRetryMax(snapshot);
      expect(result).toBe(0);
    });
  });

  describe('extractRetryDisplayCount', () => {
    it('returns iterationRetryCount when greater than 0', () => {
      const snapshot = { context: { iterationRetryCount: 3 } };
      const result = extractRetryDisplayCount(snapshot, 1);
      expect(result).toBe(3);
    });

    it('falls through to retryCount when iterationRetryCount is 0', () => {
      const snapshot = { context: { iterationRetryCount: 0 } };
      const result = extractRetryDisplayCount(snapshot, 2);
      expect(result).toBe(2);
    });

    it('falls through to retryCount when iterationRetryCount is undefined', () => {
      const snapshot = { context: { iterationRetryCount: undefined } };
      const result = extractRetryDisplayCount(snapshot, 4);
      expect(result).toBe(4);
    });

    it('falls through to retryCount when context is missing', () => {
      const snapshot = {};
      const result = extractRetryDisplayCount(snapshot, 5);
      expect(result).toBe(5);
    });

    it('falls through to retryCount when context is not an object', () => {
      const snapshot = { context: 'not an object' };
      const result = extractRetryDisplayCount(snapshot, 3);
      expect(result).toBe(3);
    });

    it('falls through to retryCount for null snapshot', () => {
      const result = extractRetryDisplayCount(null, 2);
      expect(result).toBe(2);
    });
  });

  describe('extractLastMessage', () => {
    it('extracts valid string message', () => {
      const snapshot = { context: { lastMessage: 'Operation failed' } };
      const result = extractLastMessage(snapshot);
      expect(result).toBe('Operation failed');
    });

    it('returns undefined when lastMessage is not a string', () => {
      const snapshot = { context: { lastMessage: 123 } };
      const result = extractLastMessage(snapshot);
      expect(result).toBeUndefined();
    });

    it('returns undefined when context is missing', () => {
      const snapshot = {};
      const result = extractLastMessage(snapshot);
      expect(result).toBeUndefined();
    });

    it('returns undefined when lastMessage is missing', () => {
      const snapshot = { context: { otherField: 'value' } };
      const result = extractLastMessage(snapshot);
      expect(result).toBeUndefined();
    });

    it('returns undefined when context is not an object', () => {
      const snapshot = { context: 'not an object' };
      const result = extractLastMessage(snapshot);
      expect(result).toBeUndefined();
    });

    it('returns undefined for null snapshot', () => {
      const result = extractLastMessage(null);
      expect(result).toBeUndefined();
    });
  });

  describe('formatActionForDisplay', () => {
    it('returns CONTINUE when lastAction is undefined', () => {
      const result = formatActionForDisplay(undefined, 0, 0);
      expect(result).toBe('CONTINUE');
    });

    it('formats RETRY with counts', () => {
      const action: LastAction = { type: 'RETRY' };
      const result = formatActionForDisplay(action, 2, 3);
      expect(result).toBe('RETRY (2/3)');
    });

    it('formats GOTO with target only', () => {
      const action: LastAction = { type: 'GOTO', target: '5' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 5');
    });

    it('formats GOTO with substep', () => {
      const action: LastAction = { type: 'GOTO', target: '3', substep: 'a' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 3.a');
    });

    it('formats GOTO with at number', () => {
      const action: LastAction = { type: 'GOTO', target: '2', at: 1000 };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 2 AT 1000');
    });

    it('formats GOTO with at string template', () => {
      const action: LastAction = { type: 'GOTO', target: '4', at: '{{delay}}' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 4 AT {{delay}}');
    });

    it('formats GOTO with substep and at', () => {
      const action: LastAction = {
        type: 'GOTO',
        target: '6',
        substep: 'b',
        at: 500,
      };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 6.b AT 500');
    });

    it('pass through START action', () => {
      const action: LastAction = { type: 'START' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('START');
    });

    it('pass through COMPLETE action', () => {
      const action: LastAction = { type: 'COMPLETE' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('COMPLETE');
    });

    it('pass through STOP action', () => {
      const action: LastAction = { type: 'STOP' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('STOP');
    });

    it('pass through CONTINUE action', () => {
      const action: LastAction = { type: 'CONTINUE' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('CONTINUE');
    });

    it('pass through NEXT action', () => {
      const action: LastAction = { type: 'NEXT' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('NEXT');
    });

    it('pass through BREAK action', () => {
      const action: LastAction = { type: 'BREAK' };
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('BREAK');
    });
  });

  describe('formatTransitionAction', () => {
    it('returns CONTINUE for CONTINUE action', () => {
      expect(formatTransitionAction('CONTINUE')).toBe('CONTINUE');
    });

    it('returns COMPLETE for COMPLETE action', () => {
      expect(formatTransitionAction('COMPLETE')).toBe('COMPLETE');
    });

    it('returns STOP for STOP action', () => {
      expect(formatTransitionAction('STOP')).toBe('STOP');
    });

    it('returns NEXT for NEXT action', () => {
      expect(formatTransitionAction('NEXT')).toBe('NEXT');
    });

    it('returns BREAK for BREAK action', () => {
      expect(formatTransitionAction('BREAK')).toBe('BREAK');
    });

    it('formats RETRY with attempt and max', () => {
      expect(formatTransitionAction('RETRY', undefined, 2, 3)).toBe('RETRY (2/3)');
    });

    it('formats RETRY without attempt/max', () => {
      expect(formatTransitionAction('RETRY')).toBe('RETRY');
    });

    it('formats GOTO with destination', () => {
      expect(formatTransitionAction('GOTO', '5')).toBe('GOTO 5');
    });

    it('formats GOTO without destination', () => {
      expect(formatTransitionAction('GOTO')).toBe('GOTO');
    });

    it('formats GOTO with forIndex', () => {
      expect(formatTransitionAction('GOTO', '2', undefined, undefined, 3)).toBe('GOTO 2 AT 3');
    });
  });

  describe('parseActionType', () => {
    it('returns CONTINUE for undefined action', () => {
      const result = parseActionType(undefined);
      expect(result).toBe('CONTINUE');
    });

    it('returns GOTO for GOTO action', () => {
      const action: LastAction = { type: 'GOTO', target: '5' };
      const result = parseActionType(action);
      expect(result).toBe('GOTO');
    });

    it('returns RETRY for RETRY action', () => {
      const action: LastAction = { type: 'RETRY' };
      const result = parseActionType(action);
      expect(result).toBe('RETRY');
    });

    it('returns COMPLETE for COMPLETE action', () => {
      const action: LastAction = { type: 'COMPLETE' };
      const result = parseActionType(action);
      expect(result).toBe('COMPLETE');
    });

    it('returns STOP for STOP action', () => {
      const action: LastAction = { type: 'STOP' };
      const result = parseActionType(action);
      expect(result).toBe('STOP');
    });

    it('returns CONTINUE for START action', () => {
      const action: LastAction = { type: 'START' };
      const result = parseActionType(action);
      expect(result).toBe('CONTINUE');
    });

    it('returns CONTINUE for CONTINUE action', () => {
      const action: LastAction = { type: 'CONTINUE' };
      const result = parseActionType(action);
      expect(result).toBe('CONTINUE');
    });

    it('returns NEXT for NEXT action', () => {
      const action: LastAction = { type: 'NEXT' };
      const result = parseActionType(action);
      expect(result).toBe('NEXT');
    });

    it('returns BREAK for BREAK action', () => {
      const action: LastAction = { type: 'BREAK' };
      const result = parseActionType(action);
      expect(result).toBe('BREAK');
    });
  });

  describe('deriveTransitionMessage', () => {
    it('returns pass transition message for pass result', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
          aggregation: 'ANY',
          pass: {
            kind: 'pass',
            retry: 0,
            action: { type: 'STOP', message: 'passed' },
          },
          fail: {
            kind: 'fail',
            retry: 0,
            action: { type: 'STOP', message: 'failed' },
          },
        },
      };
      const result = deriveTransitionMessage('pass', step, 0);
      expect(result).toBe('passed');
    });

    it('returns fail transition message for fail result', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
          aggregation: 'ANY',
          pass: {
            kind: 'pass',
            retry: 0,
            action: { type: 'STOP', message: 'passed' },
          },
          fail: {
            kind: 'fail',
            retry: 0,
            action: { type: 'STOP', message: 'failed' },
          },
        },
      };
      const result = deriveTransitionMessage('fail', step, 0);
      expect(result).toBe('failed');
    });

    it('returns undefined when pass transition has no message', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
          aggregation: 'ANY',
          pass: {
            kind: 'pass',
            retry: 0,
            action: { type: 'STOP' },
          },
          fail: {
            kind: 'fail',
            retry: 0,
            action: { type: 'STOP' },
          },
        },
      };
      const result = deriveTransitionMessage('pass', step, 0);
      expect(result).toBeUndefined();
    });

    it('returns undefined when fail transition has no message', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
          aggregation: 'ANY',
          pass: {
            kind: 'pass',
            retry: 0,
            action: { type: 'STOP' },
          },
          fail: {
            kind: 'fail',
            retry: 0,
            action: { type: 'STOP' },
          },
        },
      };
      const result = deriveTransitionMessage('fail', step, 0);
      expect(result).toBeUndefined();
    });

    it('uses retryCount when deriving message', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
          aggregation: 'ANY',
          pass: {
            kind: 'pass',
            retry: 0,
            action: { type: 'STOP', message: 'success after retry' },
          },
          fail: {
            kind: 'fail',
            retry: 0,
            action: { type: 'STOP' },
          },
        },
      };
      const result = deriveTransitionMessage('pass', step, 2);
      expect(result).toBe('success after retry');
    });
  });
});
