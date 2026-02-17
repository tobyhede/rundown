import { describe, it, expect } from '@jest/globals';
import {
  isListOutput,
  isDetailOutput,
  isStatusOutput,
  isActionOutput,
  isMessageOutput,
  isErrorOutput,
} from '../../src/output/types.js';
import type { OutputEvent } from '../../src/output/types.js';

describe('output type guards', () => {
  describe('isListOutput', () => {
    it('returns true and narrows to ListOutput', () => {
      const event = { type: 'list', items: ['a'], columns: [] } as OutputEvent;
      expect(isListOutput(event)).toBe(true);
      if (isListOutput(event)) {
        expect(event.items).toEqual(['a']);
      }
    });

    it('returns false for non-list event', () => {
      const event = { type: 'error', message: 'fail' } as OutputEvent;
      expect(isListOutput(event)).toBe(false);
    });
  });

  describe('isDetailOutput', () => {
    it('returns true and narrows to DetailOutput', () => {
      const event = { type: 'detail', format: 'custom', data: { k: 'v' } } as OutputEvent;
      expect(isDetailOutput(event)).toBe(true);
      if (isDetailOutput(event)) {
        expect(event.format).toBe('custom');
        expect(event.data).toEqual({ k: 'v' });
      }
    });

    it('returns false for non-detail event', () => {
      const event = { type: 'list', items: [], columns: [] } as OutputEvent;
      expect(isDetailOutput(event)).toBe(false);
    });
  });

  describe('isStatusOutput', () => {
    it('returns true and narrows to StatusOutput', () => {
      const event = { type: 'status', result: true, action: 'pass' } as OutputEvent;
      expect(isStatusOutput(event)).toBe(true);
      if (isStatusOutput(event)) {
        expect(event.result).toBe(true);
        expect(event.action).toBe('pass');
      }
    });

    it('returns false for non-status event', () => {
      const event = { type: 'error', message: 'fail' } as OutputEvent;
      expect(isStatusOutput(event)).toBe(false);
    });
  });

  describe('isActionOutput', () => {
    it('returns true and narrows to ActionOutput', () => {
      const event = { type: 'action', block: { action: 'PASS' } } as OutputEvent;
      expect(isActionOutput(event)).toBe(true);
      if (isActionOutput(event)) {
        expect(event.block.action).toBe('PASS');
      }
    });

    it('returns false for non-action event', () => {
      const event = { type: 'message', text: 'hi', level: 'info' } as OutputEvent;
      expect(isActionOutput(event)).toBe(false);
    });
  });

  describe('isMessageOutput', () => {
    it('returns true and narrows to MessageOutput', () => {
      const event = { type: 'message', text: 'hello', level: 'info' } as OutputEvent;
      expect(isMessageOutput(event)).toBe(true);
      if (isMessageOutput(event)) {
        expect(event.text).toBe('hello');
        expect(event.level).toBe('info');
      }
    });

    it('returns false for non-message event', () => {
      const event = { type: 'error', message: 'fail' } as OutputEvent;
      expect(isMessageOutput(event)).toBe(false);
    });
  });

  describe('isErrorOutput', () => {
    it('returns true and narrows to ErrorOutput', () => {
      const event = { type: 'error', message: 'fail', code: 'E001' } as OutputEvent;
      expect(isErrorOutput(event)).toBe(true);
      if (isErrorOutput(event)) {
        expect(event.message).toBe('fail');
        expect(event.code).toBe('E001');
      }
    });

    it('returns false for non-error event', () => {
      const event = { type: 'message', text: 'hi', level: 'info' } as OutputEvent;
      expect(isErrorOutput(event)).toBe(false);
    });
  });
});
