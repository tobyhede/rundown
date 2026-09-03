import { describe, it, expect } from '@jest/globals';
import { formatActionForDisplay, extractLastAction, extractLastMessage } from '@rundown-org/core';

describe('execution action helpers', () => {
  describe('extractLastAction', () => {
    it('extracts lastAction from valid snapshot', () => {
      const snapshot = {
        context: {
          lastAction: { type: 'CONTINUE', origin: 'direct' },
          retryCount: 0,
        },
      };
      expect(extractLastAction(snapshot)).toEqual({ type: 'CONTINUE', origin: 'direct' });
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
      expect(
        extractLastAction({ context: { lastAction: { type: 'STOP', origin: 'direct' } } }),
      ).toEqual({
        type: 'STOP',
        origin: 'direct',
      });
      expect(
        extractLastAction({ context: { lastAction: { type: 'COMPLETE', origin: 'direct' } } }),
      ).toEqual({
        type: 'COMPLETE',
        origin: 'direct',
      });
      expect(
        extractLastAction({ context: { lastAction: { type: 'RETRY', origin: 'direct' } } }),
      ).toEqual({
        type: 'RETRY',
        origin: 'direct',
      });
      expect(
        extractLastAction({
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: 'ErrorHandler' } },
        }),
      ).toEqual({ type: 'GOTO', origin: 'direct', target: 'ErrorHandler' });
    });

    it('rejects malformed lastAction shapes', () => {
      expect(
        extractLastAction({ context: { lastAction: { type: 'GOTO', origin: 'direct' } } }),
      ).toBeUndefined();
      expect(
        extractLastAction({
          context: { lastAction: { type: 'GOTO', origin: 'direct', target: 42 } },
        }),
      ).toBeUndefined();
      expect(
        extractLastAction({
          context: {
            lastAction: { type: 'GOTO', origin: 'direct', target: '3', at: { bad: true } },
          },
        }),
      ).toBeUndefined();
      expect(
        extractLastAction({ context: { lastAction: { type: 'NOT_REAL', origin: 'direct' } } }),
      ).toBeUndefined();
    });
  });

  describe('formatActionForDisplay', () => {
    describe('basic action types', () => {
      it('returns CONTINUE when lastAction is CONTINUE', () => {
        expect(formatActionForDisplay({ type: 'CONTINUE', origin: 'direct' }, 0, 3)).toBe(
          'CONTINUE',
        );
      });

      it('returns STOP when lastAction is STOP', () => {
        expect(formatActionForDisplay({ type: 'STOP', origin: 'direct' }, 0, 3)).toBe('STOP');
      });

      it('returns COMPLETE when lastAction is COMPLETE', () => {
        expect(formatActionForDisplay({ type: 'COMPLETE', origin: 'direct' }, 0, 3)).toBe(
          'COMPLETE',
        );
      });

      it('returns CONTINUE as default when lastAction is undefined', () => {
        expect(formatActionForDisplay(undefined, 0, 3)).toBe('CONTINUE');
      });
    });

    describe('RETRY formatting', () => {
      it('formats RETRY with count details', () => {
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 1, 3)).toBe(
          'RETRY (1/3)',
        );
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 2, 3)).toBe(
          'RETRY (2/3)',
        );
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 3, 3)).toBe(
          'RETRY (3/3)',
        );
      });

      it('formats RETRY with different max values', () => {
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 1, 5)).toBe(
          'RETRY (1/5)',
        );
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 1, 10)).toBe(
          'RETRY (1/10)',
        );
      });
    });

    describe('GOTO formatting', () => {
      it('formats GOTO with named step', () => {
        expect(
          formatActionForDisplay({ type: 'GOTO', origin: 'direct', target: 'ErrorHandler' }, 0, 3),
        ).toBe('GOTO ErrorHandler');
      });

      it('formats GOTO with numbered step', () => {
        expect(formatActionForDisplay({ type: 'GOTO', origin: 'direct', target: '3' }, 0, 3)).toBe(
          'GOTO 3',
        );
      });

      it('formats GOTO with substep', () => {
        expect(
          formatActionForDisplay(
            { type: 'GOTO', origin: 'direct', target: '2', substep: '3' },
            0,
            3,
          ),
        ).toBe('GOTO 2.3');
      });

      it('formats GOTO with AT qualifier', () => {
        expect(
          formatActionForDisplay({ type: 'GOTO', origin: 'direct', target: '3', at: 2 }, 0, 3),
        ).toBe('GOTO 3 AT 2');
      });

      it('formats GOTO with substep and AT qualifier', () => {
        expect(
          formatActionForDisplay(
            { type: 'GOTO', origin: 'direct', target: '3', substep: '1', at: 5 },
            0,
            3,
          ),
        ).toBe('GOTO 3.1 AT 5');
      });

      it('formats GOTO with template variable AT qualifier', () => {
        expect(
          formatActionForDisplay(
            { type: 'GOTO', origin: 'direct', target: '3', at: '{{Index}}' },
            0,
            3,
          ),
        ).toBe('GOTO 3 AT {{Index}}');
      });
    });

    describe('edge cases', () => {
      it('handles zero retry count', () => {
        expect(formatActionForDisplay({ type: 'RETRY', origin: 'direct' }, 0, 3)).toBe(
          'RETRY (0/3)',
        );
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

describe('CONTENTION_LAUNCH_CODES', () => {
  it('classifies the registered run-start CAS code as contention', async () => {
    // The set is keyed by REGISTERED code values, not symbolic names: the codes
    // that reach the launch-refusal arm are `ErrorCodes.*.code` strings
    // (RD-NNN). Pinned against the registry so a code remap cannot silently
    // turn every contention-shaped launch loss permanent (#853 review F4) —
    // when the #777 fix surfaces CONCURRENT_STATE_MODIFICATION from the
    // run-start pipeline, this membership is what makes that arm retryable
    // with no further change.
    const { CONTENTION_LAUNCH_CODES } = await import('../../src/services/execution.js');
    const { ErrorCodes, TRANSACTIONAL_REFUSAL_CODE_BY_KIND } = await import('@rundown-org/core');
    expect(CONTENTION_LAUNCH_CODES.has(ErrorCodes.CONCURRENT_STATE_MODIFICATION.code)).toBe(true);
    expect(
      CONTENTION_LAUNCH_CODES.has(TRANSACTIONAL_REFUSAL_CODE_BY_KIND.concurrent_modification),
    ).toBe(true);
    // LAUNCH_FAILED remains the pipeline's catch-all for everything it cannot
    // classify, and must stay permanent: a generic init failure has no retry
    // to offer, and admitting it here would tell every such caller to retry.
    expect(CONTENTION_LAUNCH_CODES.has(ErrorCodes.LAUNCH_FAILED.code)).toBe(false);
  });
});
