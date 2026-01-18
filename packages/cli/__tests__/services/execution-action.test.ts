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
          lastAction: 'CONTINUE',
          retryCount: 0,
        },
      };
      expect(extractLastAction(snapshot)).toBe('CONTINUE');
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
      expect(extractLastAction({ context: { lastAction: 'STOP' } })).toBe('STOP');
      expect(extractLastAction({ context: { lastAction: 'COMPLETE' } })).toBe('COMPLETE');
      expect(extractLastAction({ context: { lastAction: 'RETRY' } })).toBe('RETRY');
      expect(extractLastAction({ context: { lastAction: 'GOTO ErrorHandler' } })).toBe('GOTO ErrorHandler');
      expect(extractLastAction({ context: { lastAction: 'GOTO NEXT' } })).toBe('GOTO NEXT');
    });
  });

  describe('formatActionForDisplay', () => {
    describe('basic action types', () => {
      it('returns CONTINUE when lastAction is CONTINUE', () => {
        expect(formatActionForDisplay('CONTINUE', 0, 3)).toBe('CONTINUE');
      });

      it('returns STOP when lastAction is STOP', () => {
        expect(formatActionForDisplay('STOP', 0, 3)).toBe('STOP');
      });

      it('returns COMPLETE when lastAction is COMPLETE', () => {
        expect(formatActionForDisplay('COMPLETE', 0, 3)).toBe('COMPLETE');
      });

      it('returns CONTINUE as default when lastAction is undefined', () => {
        expect(formatActionForDisplay(undefined, 0, 3)).toBe('CONTINUE');
      });
    });

    describe('RETRY formatting', () => {
      it('formats RETRY with count details', () => {
        expect(formatActionForDisplay('RETRY', 1, 3)).toBe('RETRY (1/3)');
        expect(formatActionForDisplay('RETRY', 2, 3)).toBe('RETRY (2/3)');
        expect(formatActionForDisplay('RETRY', 3, 3)).toBe('RETRY (3/3)');
      });

      it('formats RETRY with different max values', () => {
        expect(formatActionForDisplay('RETRY', 1, 5)).toBe('RETRY (1/5)');
        expect(formatActionForDisplay('RETRY', 1, 10)).toBe('RETRY (1/10)');
      });
    });

    describe('GOTO formatting', () => {
      it('passes through GOTO with named step', () => {
        expect(formatActionForDisplay('GOTO ErrorHandler', 0, 3)).toBe('GOTO ErrorHandler');
      });

      it('passes through GOTO with numbered step', () => {
        expect(formatActionForDisplay('GOTO 3', 0, 3)).toBe('GOTO 3');
      });

      it('passes through GOTO with substep', () => {
        expect(formatActionForDisplay('GOTO 2.3', 0, 3)).toBe('GOTO 2.3');
      });

      it('passes through GOTO NEXT', () => {
        expect(formatActionForDisplay('GOTO NEXT', 0, 3)).toBe('GOTO NEXT');
      });
    });

    describe('placeholder resolution', () => {
      it('resolves {N} placeholder with instance number', () => {
        expect(formatActionForDisplay('GOTO {N}.3', 0, 3, 5)).toBe('GOTO 5.3');
        expect(formatActionForDisplay('GOTO {N}', 0, 3, 1)).toBe('GOTO 1');
      });

      it('resolves {n} placeholder with substep instance number', () => {
        expect(formatActionForDisplay('GOTO 1.{n}', 0, 3, undefined, 3)).toBe('GOTO 1.3');
        expect(formatActionForDisplay('GOTO {N}.{n}', 0, 3, 2, 5)).toBe('GOTO 2.5');
      });

      it('resolves multiple placeholders', () => {
        expect(formatActionForDisplay('GOTO {N}.{n}', 0, 3, 10, 20)).toBe('GOTO 10.20');
      });

      it('leaves placeholders unresolved when instance not provided', () => {
        expect(formatActionForDisplay('GOTO {N}.3', 0, 3)).toBe('GOTO {N}.3');
        expect(formatActionForDisplay('GOTO 1.{n}', 0, 3)).toBe('GOTO 1.{n}');
      });

      it('does not resolve placeholders in non-GOTO actions', () => {
        expect(formatActionForDisplay('CONTINUE', 0, 3, 5, 10)).toBe('CONTINUE');
        expect(formatActionForDisplay('STOP', 0, 3, 5, 10)).toBe('STOP');
      });
    });

    describe('edge cases', () => {
      it('handles zero retry count', () => {
        expect(formatActionForDisplay('RETRY', 0, 3)).toBe('RETRY (0/3)');
      });

      it('handles empty string lastAction', () => {
        // Empty string is falsy, should return default
        expect(formatActionForDisplay('', 0, 3)).toBe('CONTINUE');
      });
    });
  });
});
