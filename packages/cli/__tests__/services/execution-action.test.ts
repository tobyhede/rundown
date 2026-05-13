import { describe, it, expect } from '@jest/globals';
import { formatActionForDisplay, extractLastAction, extractLastMessage } from '@rundown-org/core';

describe('execution action helpers', () => {
  describe('extractLastAction', () => {
    it('extracts lastAction from valid snapshot', () => {
      const snapshot = {
        context: {
          lastAction: { type: 'CONTINUE' },
          retryCount: 0,
        },
      };
      expect(extractLastAction(snapshot)).toEqual({ type: 'CONTINUE' });
    });

    it('returns undefined for snapshot without context', () => {
      const snapshot = {};
      expect(extractLastAction(snapshot)).toBeUndefined();
    });

    it('returns undefined for snapshot with null context', () => {
      const snapshot = { context: null };
      expect(extractLastAction(snapshot)).toBeUndefined();
    });

    it('returns undefined for snapshot without lastAction', () => {
      const snapshot = {
        context: {
          retryCount: 0,
        },
      };
      expect(extractLastAction(snapshot)).toBeUndefined();
    });

    it('returns undefined for non-object snapshot', () => {
      expect(extractLastAction(null)).toBeUndefined();
      expect(extractLastAction(undefined)).toBeUndefined();
      expect(extractLastAction('string')).toBeUndefined();
      expect(extractLastAction(123)).toBeUndefined();
    });

    it('extracts various action types', () => {
      expect(extractLastAction({ context: { lastAction: { type: 'STOP' } } })).toEqual({
        type: 'STOP',
      });
      expect(extractLastAction({ context: { lastAction: { type: 'COMPLETE' } } })).toEqual({
        type: 'COMPLETE',
      });
      expect(extractLastAction({ context: { lastAction: { type: 'RETRY' } } })).toEqual({
        type: 'RETRY',
      });
      expect(
        extractLastAction({ context: { lastAction: { type: 'GOTO', target: 'ErrorHandler' } } }),
      ).toEqual({ type: 'GOTO', target: 'ErrorHandler' });
    });

    it('rejects malformed lastAction shapes', () => {
      expect(extractLastAction({ context: { lastAction: { type: 'GOTO' } } })).toBeUndefined();
      expect(
        extractLastAction({ context: { lastAction: { type: 'GOTO', target: 42 } } }),
      ).toBeUndefined();
      expect(
        extractLastAction({
          context: { lastAction: { type: 'GOTO', target: '3', at: { bad: true } } },
        }),
      ).toBeUndefined();
      expect(extractLastAction({ context: { lastAction: { type: 'NOT_REAL' } } })).toBeUndefined();
    });
  });

  describe('formatActionForDisplay', () => {
    describe('basic action types', () => {
      it('returns CONTINUE when lastAction is CONTINUE', () => {
        expect(formatActionForDisplay({ type: 'CONTINUE' }, 0, 3)).toBe('CONTINUE');
      });

      it('returns STOP when lastAction is STOP', () => {
        expect(formatActionForDisplay({ type: 'STOP' }, 0, 3)).toBe('STOP');
      });

      it('returns COMPLETE when lastAction is COMPLETE', () => {
        expect(formatActionForDisplay({ type: 'COMPLETE' }, 0, 3)).toBe('COMPLETE');
      });

      it('returns CONTINUE as default when lastAction is undefined', () => {
        expect(formatActionForDisplay(undefined, 0, 3)).toBe('CONTINUE');
      });
    });

    describe('RETRY formatting', () => {
      it('formats RETRY with count details', () => {
        expect(formatActionForDisplay({ type: 'RETRY' }, 1, 3)).toBe('RETRY (1/3)');
        expect(formatActionForDisplay({ type: 'RETRY' }, 2, 3)).toBe('RETRY (2/3)');
        expect(formatActionForDisplay({ type: 'RETRY' }, 3, 3)).toBe('RETRY (3/3)');
      });

      it('formats RETRY with different max values', () => {
        expect(formatActionForDisplay({ type: 'RETRY' }, 1, 5)).toBe('RETRY (1/5)');
        expect(formatActionForDisplay({ type: 'RETRY' }, 1, 10)).toBe('RETRY (1/10)');
      });
    });

    describe('GOTO formatting', () => {
      it('formats GOTO with named step', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: 'ErrorHandler' }, 0, 3)).toBe(
          'GOTO ErrorHandler',
        );
      });

      it('formats GOTO with numbered step', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '3' }, 0, 3)).toBe('GOTO 3');
      });

      it('formats GOTO with substep', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '2', substep: '3' }, 0, 3)).toBe(
          'GOTO 2.3',
        );
      });

      it('formats GOTO with AT qualifier', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '3', at: 2 }, 0, 3)).toBe(
          'GOTO 3 AT 2',
        );
      });

      it('formats GOTO with substep and AT qualifier', () => {
        expect(
          formatActionForDisplay({ type: 'GOTO', target: '3', substep: '1', at: 5 }, 0, 3),
        ).toBe('GOTO 3.1 AT 5');
      });

      it('formats GOTO with template variable AT qualifier', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '3', at: '{{Index}}' }, 0, 3)).toBe(
          'GOTO 3 AT {{Index}}',
        );
      });
    });

    describe('edge cases', () => {
      it('handles zero retry count', () => {
        expect(formatActionForDisplay({ type: 'RETRY' }, 0, 3)).toBe('RETRY (0/3)');
      });
    });
  });

  describe('extractLastMessage', () => {
    it('extracts string lastMessage from valid snapshot', () => {
      const snapshot = { context: { lastMessage: 'Step completed successfully' } };
      expect(extractLastMessage(snapshot)).toBe('Step completed successfully');
    });

    it('returns undefined for non-string lastMessage', () => {
      const snapshot = { context: { lastMessage: 42 } };
      expect(extractLastMessage(snapshot)).toBeUndefined();
    });

    it('returns undefined when lastMessage field is absent', () => {
      const snapshot = { context: { retryCount: 0 } };
      expect(extractLastMessage(snapshot)).toBeUndefined();
    });

    it('returns undefined when context is absent', () => {
      const snapshot = {};
      expect(extractLastMessage(snapshot)).toBeUndefined();
    });

    it('returns undefined for null snapshot', () => {
      expect(extractLastMessage(null)).toBeUndefined();
    });

    it('returns undefined for undefined snapshot', () => {
      expect(extractLastMessage(undefined)).toBeUndefined();
    });
  });
});
