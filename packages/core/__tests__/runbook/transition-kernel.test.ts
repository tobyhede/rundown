import { describe, expect, it } from '@jest/globals';
import {
  deriveStoppedReason,
  extractInternalFailureMessage,
  extractLastAction,
  extractRetryMax,
  extractRetryDisplayCount,
  extractLastMessage,
  formatActionForDisplay,
  formatTransitionAction,
  isInternalFailureLastAction,
  parseActionType,
  deriveTransitionMessage,
} from '../../src/runbook/transition-kernel.js';
import { makeDirectLastAction } from '../../src/runbook/last-action.js';
import type { Step, LastAction } from '../../src/runbook/types.js';

describe('transition-kernel', () => {
  describe('extractLastAction', () => {
    describe('valid action types', () => {
      it('extracts START action', () => {
        const snapshot = { context: { lastAction: { type: 'START', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'START', origin: 'direct' });
      });

      it('extracts CONTINUE action', () => {
        const snapshot = { context: { lastAction: { type: 'CONTINUE', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'CONTINUE', origin: 'direct' });
      });

      it('extracts COMPLETE action', () => {
        const snapshot = { context: { lastAction: { type: 'COMPLETE', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'COMPLETE', origin: 'direct' });
      });

      it('extracts STOP action', () => {
        const snapshot = { context: { lastAction: { type: 'STOP', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'STOP', origin: 'direct' });
      });

      it('extracts RETRY action', () => {
        const snapshot = { context: { lastAction: { type: 'RETRY', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'RETRY', origin: 'direct' });
      });

      it('extracts NEXT action', () => {
        const snapshot = { context: { lastAction: { type: 'NEXT', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'NEXT', origin: 'direct' });
      });

      it('extracts BREAK action', () => {
        const snapshot = { context: { lastAction: { type: 'BREAK', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'BREAK', origin: 'direct' });
      });
    });

    describe('GOTO action variants', () => {
      it('extracts GOTO with target only', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: '5' } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', origin: 'direct', target: '5' });
      });

      it('extracts GOTO with substep', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: '3', substep: 'a' } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', origin: 'direct', target: '3', substep: 'a' });
      });

      it('extracts GOTO with at number', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: '2', at: 1000 } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', origin: 'direct', target: '2', at: 1000 });
      });

      it('extracts GOTO with at string template', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', origin: 'direct', target: '4', at: '{{delay}}' },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({ type: 'GOTO', origin: 'direct', target: '4', at: '{{delay}}' });
      });

      it('extracts GOTO with all properties', () => {
        const snapshot = {
          context: {
            lastAction: {
              type: 'GOTO',
              origin: 'direct',
              target: '6',
              substep: 'b',
              at: 500,
            },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toEqual({
          type: 'GOTO',
          origin: 'direct',
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
        const snapshot = { context: { lastAction: { type: 'GOTO', origin: 'direct' } } };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-string target', () => {
        const snapshot = {
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: 123 } },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-string substep', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', origin: 'direct', target: '5', substep: 123 },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects GOTO with non-number/non-string at', () => {
        const snapshot = {
          context: {
            lastAction: { type: 'GOTO', origin: 'direct', target: '5', at: true },
          },
        };
        const result = extractLastAction(snapshot);
        expect(result).toBeUndefined();
      });

      it('rejects unknown action type', () => {
        const snapshot = { context: { lastAction: { type: 'UNKNOWN', origin: 'direct' } } };
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
      const action: LastAction = makeDirectLastAction({ type: 'RETRY' });
      const result = formatActionForDisplay(action, 2, 3);
      expect(result).toBe('RETRY (2/3)');
    });

    it('formats GOTO with target only', () => {
      const action: LastAction = makeDirectLastAction({ type: 'GOTO', target: '5' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 5');
    });

    it('formats GOTO with substep', () => {
      const action: LastAction = makeDirectLastAction({ type: 'GOTO', target: '3', substep: 'a' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 3.a');
    });

    it('formats GOTO with at number', () => {
      const action: LastAction = makeDirectLastAction({ type: 'GOTO', target: '2', at: 1000 });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 2 AT 1000');
    });

    it('formats GOTO with at string template', () => {
      const action: LastAction = makeDirectLastAction({
        type: 'GOTO',
        target: '4',
        at: '{{delay}}',
      });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 4 AT {{delay}}');
    });

    it('formats GOTO with substep and at', () => {
      const action: LastAction = makeDirectLastAction({
        type: 'GOTO',
        target: '6',
        substep: 'b',
        at: 500,
      });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('GOTO 6.b AT 500');
    });

    it('pass through START action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'START' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('START');
    });

    it('pass through COMPLETE action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'COMPLETE' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('COMPLETE');
    });

    it('pass through STOP action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'STOP' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('STOP');
    });

    it('pass through CONTINUE action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'CONTINUE' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('CONTINUE');
    });

    it('pass through NEXT action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'NEXT' });
      const result = formatActionForDisplay(action, 0, 0);
      expect(result).toBe('NEXT');
    });

    it('pass through BREAK action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'BREAK' });
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
      const action: LastAction = makeDirectLastAction({ type: 'GOTO', target: '5' });
      const result = parseActionType(action);
      expect(result).toBe('GOTO');
    });

    it('returns RETRY for RETRY action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'RETRY' });
      const result = parseActionType(action);
      expect(result).toBe('RETRY');
    });

    it('returns COMPLETE for COMPLETE action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'COMPLETE' });
      const result = parseActionType(action);
      expect(result).toBe('COMPLETE');
    });

    it('returns STOP for STOP action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'STOP' });
      const result = parseActionType(action);
      expect(result).toBe('STOP');
    });

    it('returns START for START action', () => {
      // Issue 5 regression: parseActionType used to silently fall through
      // 'START' to 'CONTINUE' via the default switch arm. This violates the
      // "no silent action mapping" principle — START is a distinct
      // pre-action category and must propagate as itself.
      const action: LastAction = makeDirectLastAction({ type: 'START' });
      const result = parseActionType(action);
      expect(result).toBe('START');
    });

    it('returns CONTINUE for undefined initial state', () => {
      // The pre-action / initial state still returns 'CONTINUE': absent
      // lastAction is distinct from an explicit START tag and represents
      // the machine's neutral starting position.
      const result = parseActionType(undefined);
      expect(result).toBe('CONTINUE');
    });

    it('returns CONTINUE for CONTINUE action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'CONTINUE' });
      const result = parseActionType(action);
      expect(result).toBe('CONTINUE');
    });

    it('returns NEXT for NEXT action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'NEXT' });
      const result = parseActionType(action);
      expect(result).toBe('NEXT');
    });

    it('returns BREAK for BREAK action', () => {
      const action: LastAction = makeDirectLastAction({ type: 'BREAK' });
      const result = parseActionType(action);
      expect(result).toBe('BREAK');
    });

    it('returns command terminal action types without silent mapping', () => {
      expect(
        parseActionType(makeDirectLastAction({ type: 'POLICY_DENIED', message: 'blocked' })),
      ).toBe('POLICY_DENIED');
      expect(
        parseActionType(
          makeDirectLastAction({
            type: 'COMMAND_EXECUTION_FAILED',
            message: 'spawn failed',
          }),
        ),
      ).toBe('COMMAND_EXECUTION_FAILED');
    });
  });

  describe('deriveTransitionMessage', () => {
    it('returns pass transition message for pass result', () => {
      const step: Step = {
        kind: 'base',
        name: '1',
        description: 'Test step',
        transitions: {
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

  describe('OUTPUT_CAPTURE_FAILED lastAction', () => {
    it('extracts and classifies output-capture failures as internal failures', () => {
      const snapshot = {
        context: {
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED',
            origin: 'direct',
            message: 'failed to read RD_OUTPUTS_Foo',
          },
        },
      };

      const action = extractLastAction(snapshot);
      expect(action).toEqual({
        type: 'OUTPUT_CAPTURE_FAILED',
        origin: 'direct',
        message: 'failed to read RD_OUTPUTS_Foo',
      });
      expect(isInternalFailureLastAction(action)).toBe(true);
      expect(parseActionType(action)).toBe('OUTPUT_CAPTURE_FAILED');
      expect(deriveStoppedReason(action)).toBe('output_capture_failed');
    });

    it('rejects malformed output-capture failure actions', () => {
      expect(
        extractLastAction({
          context: { lastAction: { type: 'OUTPUT_CAPTURE_FAILED', origin: 'direct' } },
        }),
      ).toBeUndefined();
      expect(
        extractLastAction({
          context: { lastAction: { type: 'OUTPUT_CAPTURE_FAILED', origin: 'direct', message: 42 } },
        }),
      ).toBeUndefined();
    });
  });

  describe('ARTIFACT_RESOLUTION_FAILED lastAction', () => {
    it('parses to its own ActionType', () => {
      const lastAction = {
        type: 'ARTIFACT_RESOLUTION_FAILED',
        message: 'bad artifact',
      } as LastAction;

      expect(parseActionType(lastAction)).toBe('ARTIFACT_RESOLUTION_FAILED');
    });

    it('is classified as an internal failure lastAction', () => {
      const lastAction = {
        type: 'ARTIFACT_RESOLUTION_FAILED',
        message: 'bad artifact',
      } as LastAction;

      expect(isInternalFailureLastAction(lastAction)).toBe(true);
    });

    it('derives the public stopped reason and message', () => {
      const lastAction = {
        type: 'ARTIFACT_RESOLUTION_FAILED',
        message: 'bad artifact',
      } as LastAction;

      expect(deriveStoppedReason(lastAction)).toBe('artifact_resolution_failed');
      expect(extractInternalFailureMessage(lastAction)).toBe('bad artifact');
    });
  });

  describe('FOR_RESOLUTION_FAILED lastAction', () => {
    const codes = [
      'undefined-variable',
      'type-mismatch',
      'parse-failure',
      'policy-violation',
      'drift-detected',
    ] as const;

    it.each(codes)('extracts FOR_RESOLUTION_FAILED with code %s', (code) => {
      const snapshot = {
        context: {
          lastAction: {
            type: 'FOR_RESOLUTION_FAILED',
            origin: 'direct',
            code,
            message: 'FOR source failed',
          },
        },
      };

      expect(extractLastAction(snapshot)).toEqual({
        type: 'FOR_RESOLUTION_FAILED',
        origin: 'direct',
        code,
        message: 'FOR source failed',
      });
    });

    it('rejects FOR_RESOLUTION_FAILED missing code', () => {
      expect(
        extractLastAction({
          context: {
            lastAction: { type: 'FOR_RESOLUTION_FAILED', origin: 'direct', message: 'boom' },
          },
        }),
      ).toBeUndefined();
    });

    it('rejects FOR_RESOLUTION_FAILED missing message', () => {
      expect(
        extractLastAction({
          context: {
            lastAction: {
              type: 'FOR_RESOLUTION_FAILED',
              origin: 'direct',
              code: 'policy-violation',
            },
          },
        }),
      ).toBeUndefined();
    });

    it('parses to its own ActionType', () => {
      const lastAction = {
        type: 'FOR_RESOLUTION_FAILED',
        code: 'policy-violation',
        message: 'blocked',
      } as LastAction;

      expect(parseActionType(lastAction)).toBe('FOR_RESOLUTION_FAILED');
    });

    it('is classified as an internal failure lastAction', () => {
      const lastAction = {
        type: 'FOR_RESOLUTION_FAILED',
        code: 'parse-failure',
        message: 'bad json',
      } as LastAction;

      expect(isInternalFailureLastAction(lastAction)).toBe(true);
    });

    it('derives the public stopped reason and message', () => {
      const lastAction = {
        type: 'FOR_RESOLUTION_FAILED',
        code: 'type-mismatch',
        message: 'not iterable',
      } as LastAction;

      expect(deriveStoppedReason(lastAction)).toBe('for_resolution_failed');
      expect(extractInternalFailureMessage(lastAction)).toBe('not iterable');
    });
  });

  describe('RETRY_ERROR lastAction', () => {
    it('extracts and classifies retry hook failures as internal failures', () => {
      const snapshot = {
        context: {
          lastAction: {
            type: 'RETRY_ERROR',
            origin: 'direct',
            code: 'RD-902',
            message: 'retry hook failed',
          },
        },
      };

      const action = extractLastAction(snapshot);
      expect(action).toEqual({
        type: 'RETRY_ERROR',
        origin: 'direct',
        code: 'RD-902',
        message: 'retry hook failed',
      });
      expect(isInternalFailureLastAction(action)).toBe(true);
      expect(parseActionType(action)).toBe('RETRY_ERROR');
      expect(deriveStoppedReason(action)).toBe('retry_error_failed');
    });
  });

  describe('command terminal lastAction variants', () => {
    it('maps policy denial and command execution failure distinctly', () => {
      expect(
        deriveStoppedReason(makeDirectLastAction({ type: 'POLICY_DENIED', message: 'blocked' })),
      ).toBe('policy_denied');
      expect(
        deriveStoppedReason(
          makeDirectLastAction({
            type: 'COMMAND_EXECUTION_FAILED',
            message: 'spawn failed',
          }),
        ),
      ).toBe('command_execution_failed');
      expect(
        isInternalFailureLastAction(
          makeDirectLastAction({ type: 'POLICY_DENIED', message: 'blocked' }),
        ),
      ).toBe(false);
      expect(
        isInternalFailureLastAction(
          makeDirectLastAction({
            type: 'COMMAND_EXECUTION_FAILED',
            message: 'spawn failed',
          }),
        ),
      ).toBe(true);
      expect(
        extractInternalFailureMessage(
          makeDirectLastAction({ type: 'POLICY_DENIED', message: 'blocked' }),
        ),
      ).toBeUndefined();
      expect(
        extractInternalFailureMessage(
          makeDirectLastAction({
            type: 'COMMAND_EXECUTION_FAILED',
            message: 'spawn failed',
          }),
        ),
      ).toBe('spawn failed');
    });
  });
});
