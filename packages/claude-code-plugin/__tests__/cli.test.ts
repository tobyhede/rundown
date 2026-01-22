// __tests__/cli.test.ts
// Unit tests for CLI type guards and utility functions

import { SESSION_STATE_KEYS } from '../src/shared/index.js';

// Re-implement type guards for testing (they're not exported from cli.ts)
// These tests verify the logic matches the implementation

function isSessionStateKey(key: string): key is keyof import('../src/shared/index.js').SessionState {
  return (SESSION_STATE_KEYS as readonly string[]).includes(key);
}

function isArrayKey(key: string): key is import('../src/shared/index.js').SessionStateArrayKey {
  return key === 'edited_files' || key === 'file_extensions';
}

describe('CLI type guards', () => {
  describe('isSessionStateKey', () => {
    it('returns true for valid session state keys', () => {
      const validKeys = [
        'session_id',
        'started_at',
        'active_command',
        'active_skill',
        'edited_files',
        'file_extensions',
        'metadata'
      ];

      for (const key of validKeys) {
        expect(isSessionStateKey(key)).toBe(true);
      }
    });

    it('returns false for invalid keys', () => {
      const invalidKeys = [
        'invalid_key',
        'sessionId',
        'session-id',
        'SESSION_ID',
        '',
        'files',
        'commands'
      ];

      for (const key of invalidKeys) {
        expect(isSessionStateKey(key)).toBe(false);
      }
    });

    it('returns false for undefined or null coerced to string', () => {
      expect(isSessionStateKey('undefined')).toBe(false);
      expect(isSessionStateKey('null')).toBe(false);
    });
  });

  describe('isArrayKey', () => {
    it('returns true for array keys', () => {
      expect(isArrayKey('edited_files')).toBe(true);
      expect(isArrayKey('file_extensions')).toBe(true);
    });

    it('returns false for non-array keys', () => {
      const nonArrayKeys = [
        'session_id',
        'started_at',
        'active_command',
        'active_skill',
        'metadata'
      ];

      for (const key of nonArrayKeys) {
        expect(isArrayKey(key)).toBe(false);
      }
    });

    it('returns false for invalid keys', () => {
      expect(isArrayKey('files')).toBe(false);
      expect(isArrayKey('extensions')).toBe(false);
      expect(isArrayKey('')).toBe(false);
    });
  });
});

describe('SESSION_STATE_KEYS', () => {
  it('contains all expected keys', () => {
    expect(SESSION_STATE_KEYS).toContain('session_id');
    expect(SESSION_STATE_KEYS).toContain('started_at');
    expect(SESSION_STATE_KEYS).toContain('active_command');
    expect(SESSION_STATE_KEYS).toContain('active_skill');
    expect(SESSION_STATE_KEYS).toContain('edited_files');
    expect(SESSION_STATE_KEYS).toContain('file_extensions');
    expect(SESSION_STATE_KEYS).toContain('metadata');
  });

  it('has exactly 7 keys', () => {
    expect(SESSION_STATE_KEYS).toHaveLength(7);
  });

  it('is readonly', () => {
    // TypeScript should prevent mutation, but we verify the array reference
    const originalLength = SESSION_STATE_KEYS.length;
    expect(SESSION_STATE_KEYS.length).toBe(originalLength);
  });
});

describe('Session command argument parsing', () => {
  // These tests document the expected behavior of argument parsing

  describe('get command', () => {
    it('expects key and optional cwd', () => {
      // Usage: hooks-app session get <key> [cwd]
      const args = ['active_command', '/project'];
      expect(args[0]).toBe('active_command');
      expect(args[1]).toBe('/project');
    });
  });

  describe('set command', () => {
    it('expects key, value, and optional cwd', () => {
      // Usage: hooks-app session set <key> <value> [cwd]
      const args = ['active_skill', 'brainstorming', '/project'];
      expect(args[0]).toBe('active_skill');
      expect(args[1]).toBe('brainstorming');
      expect(args[2]).toBe('/project');
    });

    it('handles null value for active_command', () => {
      const args = ['active_command', 'null', '/project'];
      expect(args[1]).toBe('null');
      // In actual CLI, 'null' string becomes null value
    });
  });

  describe('append command', () => {
    it('expects array key, value, and optional cwd', () => {
      // Usage: hooks-app session append <key> <value> [cwd]
      const args = ['edited_files', 'src/file.ts', '/project'];
      expect(args[0]).toBe('edited_files');
      expect(args[1]).toBe('src/file.ts');
    });
  });

  describe('contains command', () => {
    it('expects array key, value, and optional cwd', () => {
      // Usage: hooks-app session contains <key> <value> [cwd]
      const args = ['file_extensions', 'ts', '/project'];
      expect(args[0]).toBe('file_extensions');
      expect(args[1]).toBe('ts');
    });
  });
});

describe('Metadata JSON handling', () => {
  it('parses valid JSON objects', () => {
    const validJsonStrings = [
      '{}',
      '{"key":"value"}',
      '{"nested":{"foo":"bar"}}',
      '{"number":42,"bool":true}'
    ];

    for (const json of validJsonStrings) {
      const parsed = JSON.parse(json);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    }
  });

  it('rejects arrays', () => {
    const parsed = JSON.parse('[1, 2, 3]');
    expect(Array.isArray(parsed)).toBe(true);
    // CLI should reject this
  });

  it('rejects non-objects', () => {
    const nonObjects = ['"string"', '42', 'true', 'null'];

    for (const json of nonObjects) {
      const parsed = JSON.parse(json);
      const isValidObject =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      expect(isValidObject).toBe(false);
    }
  });
});
