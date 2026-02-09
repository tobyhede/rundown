import { describe, it, expect } from '@jest/globals';
import {
  formatActionForDisplay,
  extractLastAction,
} from '../../src/services/execution.js';

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
      expect(extractLastAction({ context: { lastAction: { type: 'STOP' } } })).toEqual({ type: 'STOP' });
      expect(extractLastAction({ context: { lastAction: { type: 'COMPLETE' } } })).toEqual({ type: 'COMPLETE' });
      expect(extractLastAction({ context: { lastAction: { type: 'RETRY' } } })).toEqual({ type: 'RETRY' });
      expect(extractLastAction({ context: { lastAction: { type: 'GOTO', target: 'ErrorHandler' } } })).toEqual({ type: 'GOTO', target: 'ErrorHandler' });
      expect(extractLastAction({ context: { lastAction: { type: 'GOTO_NEXT' } } })).toEqual({ type: 'GOTO_NEXT' });
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
        expect(formatActionForDisplay({ type: 'GOTO', target: 'ErrorHandler' }, 0, 3)).toBe('GOTO ErrorHandler');
      });

      it('formats GOTO with numbered step', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '3' }, 0, 3)).toBe('GOTO 3');
      });

      it('formats GOTO with substep', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '2', substep: '3' }, 0, 3)).toBe('GOTO 2.3');
      });

      it('formats GOTO_NEXT', () => {
        expect(formatActionForDisplay({ type: 'GOTO_NEXT' }, 0, 3)).toBe('GOTO NEXT');
      });
    });

    describe('placeholder resolution', () => {
      it('resolves {N} placeholder with instance number', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '{N}', substep: '3' }, 0, 3, 5)).toBe('GOTO 5.3');
        expect(formatActionForDisplay({ type: 'GOTO', target: '{N}' }, 0, 3, 1)).toBe('GOTO 1');
      });

      it('resolves {n} placeholder with substep instance number', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '1', substep: '{n}' }, 0, 3, undefined, 3)).toBe('GOTO 1.3');
        expect(formatActionForDisplay({ type: 'GOTO', target: '{N}', substep: '{n}' }, 0, 3, 2, 5)).toBe('GOTO 2.5');
      });

      it('resolves multiple placeholders', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '{N}', substep: '{n}' }, 0, 3, 10, 20)).toBe('GOTO 10.20');
      });

      it('leaves placeholders unresolved when instance not provided', () => {
        expect(formatActionForDisplay({ type: 'GOTO', target: '{N}', substep: '3' }, 0, 3)).toBe('GOTO {N}.3');
        expect(formatActionForDisplay({ type: 'GOTO', target: '1', substep: '{n}' }, 0, 3)).toBe('GOTO 1.{n}');
      });

      it('does not resolve placeholders in non-GOTO actions', () => {
        expect(formatActionForDisplay({ type: 'CONTINUE' }, 0, 3, 5, 10)).toBe('CONTINUE');
        expect(formatActionForDisplay({ type: 'STOP' }, 0, 3, 5, 10)).toBe('STOP');
      });
    });

    describe('edge cases', () => {
      it('handles zero retry count', () => {
        expect(formatActionForDisplay({ type: 'RETRY' }, 0, 3)).toBe('RETRY (0/3)');
      });
    });
  });
});
