import { describe, it, expect } from '@jest/globals';
import { isActionResponse } from '../../src/output/schema.js';
import type {
  ActionResponse,
  StashResponse,
  PopResponse,
  CLIResponse,
} from '../../src/output/schema.js';

describe('isActionResponse type guard', () => {
  describe('correctly identifies ActionResponse', () => {
    it('returns true for ActionResponse with pass action', () => {
      const response: ActionResponse = {
        result: true,
        action: 'CONTINUE',
        command: 'pass',
        from: '1',
        at: '2',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with fail action', () => {
      const response: ActionResponse = {
        result: false,
        action: 'RETRY',
        command: 'fail',
        from: '1',
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with complete', () => {
      const response: ActionResponse = {
        result: true,
        action: 'COMPLETE',
        complete: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });

    it('returns true for ActionResponse with stopped', () => {
      const response: ActionResponse = {
        result: false,
        action: 'STOP',
        stopped: true,
      };

      expect(isActionResponse(response)).toBe(true);
    });
  });

  describe('correctly rejects StashResponse and PopResponse', () => {
    it('returns false for StashResponse', () => {
      const response: StashResponse = {
        result: true,
        action: 'stash',
        stashedId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // StashResponse has stashedId which is not present in ActionResponse
      // The type guard should distinguish these
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });

    it('returns false for PopResponse', () => {
      const response: PopResponse = {
        result: true,
        action: 'pop',
        restoredId: 'abc-123',
        runbook: { file: 'test.md', state: 'test-state.json' },
      };

      // PopResponse has restoredId which is not present in ActionResponse
      // The type guard should distinguish these
      expect(isActionResponse(response as CLIResponse)).toBe(false);
    });
  });
});
