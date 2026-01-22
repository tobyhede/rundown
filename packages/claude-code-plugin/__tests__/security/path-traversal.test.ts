// __tests__/security/path-traversal.test.ts
// Security tests for path traversal prevention

import { resolvePluginPath, validateConfig } from '../../src/shared/config.js';
import { createMockConfig } from '../helpers/test-utils.js';

describe('Path Jail Security', () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  beforeEach(() => {
    process.env.CLAUDE_PLUGIN_ROOT = '/plugins/rundown';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  describe('resolvePluginPath', () => {
    /**
     * Malicious path patterns that attempt to escape the plugin root.
     * These should ALL be blocked by the path resolution logic.
     */
    const MALICIOUS_PATHS = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32',
      'valid/../../../escape',
      '....//....//etc/passwd',
      'plugin/../../../etc',
      '..',
      '../',
      '..\\',
      'foo/bar/../../../etc',
      'valid/./../../etc'
    ];

    MALICIOUS_PATHS.forEach((maliciousPath) => {
      it(`blocks path traversal attempt: ${maliciousPath}`, () => {
        // resolvePluginPath validates plugin names, not paths
        // Path traversal in plugin names is blocked
        if (maliciousPath.includes('/') || maliciousPath.includes('\\') || maliciousPath.includes('..')) {
          expect(() => resolvePluginPath(maliciousPath)).toThrow(/path separators|invalid/i);
        }
      });
    });

    it('rejects plugin names with forward slashes', () => {
      expect(() => resolvePluginPath('evil/plugin')).toThrow(/path separators/i);
    });

    it('rejects plugin names with backslashes', () => {
      expect(() => resolvePluginPath('evil\\plugin')).toThrow(/path separators/i);
    });

    it('rejects plugin names with parent directory references', () => {
      expect(() => resolvePluginPath('..')).toThrow(/path separators/i);
      expect(() => resolvePluginPath('..plugin')).toThrow(/path separators/i);
    });

    it('allows valid plugin names', () => {
      expect(() => resolvePluginPath('valid-plugin')).not.toThrow();
      expect(() => resolvePluginPath('plugin_name')).not.toThrow();
      expect(() => resolvePluginPath('plugin123')).not.toThrow();
    });

    it('returns sibling plugin path', () => {
      const result = resolvePluginPath('other-plugin');
      expect(result).toContain('other-plugin');
      expect(result).not.toContain('..');
    });

    it('throws when CLAUDE_PLUGIN_ROOT not set', () => {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      expect(() => resolvePluginPath('plugin')).toThrow(/CLAUDE_PLUGIN_ROOT not set/i);
    });
  });

  describe('config validation security', () => {
    it('validates all gate references exist', () => {
      const config = createMockConfig({
        hooks: {
          PostToolUse: {
            gates: ['existing-gate', 'non-existent-gate']
          }
        },
        gates: {
          'existing-gate': { command: 'echo ok' }
        }
      });

      expect(() => validateConfig(config)).toThrow(/undefined gate.*non-existent-gate/i);
    });

    it('validates gate action references', () => {
      const config = createMockConfig({
        hooks: {
          PostToolUse: {
            gates: ['test-gate']
          }
        },
        gates: {
          'test-gate': {
            command: 'echo ok',
            on_pass: 'non-existent-gate' // Invalid gate reference
          }
        }
      });

      expect(() => validateConfig(config)).toThrow(/not CONTINUE\/BLOCK\/STOP or valid gate/i);
    });

    it('rejects unknown hook event names', () => {
      const config = {
        hooks: {
          UnknownEvent: { gates: [] }
        },
        gates: {}
      };

      expect(() => validateConfig(config)).toThrow(/Unknown hook event: UnknownEvent/i);
    });
  });

  describe('gate configuration security', () => {
    it('rejects gate with plugin but no gate name', () => {
      const config = createMockConfig({
        hooks: {},
        gates: {
          'incomplete': {
            plugin: 'other-plugin'
            // Missing 'gate' field
          }
        }
      });

      expect(() => validateConfig(config)).toThrow(/has 'plugin' but missing 'gate'/i);
    });

    it('rejects gate with gate name but no plugin', () => {
      const config = createMockConfig({
        hooks: {},
        gates: {
          'incomplete': {
            gate: 'some-gate'
            // Missing 'plugin' field
          }
        }
      });

      expect(() => validateConfig(config)).toThrow(/has 'gate' but missing 'plugin'/i);
    });

    it('rejects gate with both command and plugin/gate', () => {
      const config = createMockConfig({
        hooks: {},
        gates: {
          'conflicting': {
            command: 'echo test',
            plugin: 'other-plugin',
            gate: 'some-gate'
          }
        }
      });

      expect(() => validateConfig(config)).toThrow(/cannot have both 'command' and 'plugin\/gate'/i);
    });
  });

  describe('file pattern security', () => {
    it('validates file patterns are strings', () => {
      const config = createMockConfig({
        hooks: {
          PostToolUse: {
            gates: ['pattern-gate']
          }
        },
        gates: {
          'pattern-gate': {
            command: 'echo test',
            file_patterns: ['valid', 123 as unknown as string]
          }
        }
      });

      expect(() => validateConfig(config)).toThrow(/expected string/i);
    });

    it('accepts valid glob patterns', () => {
      const config = createMockConfig({
        hooks: {
          PostToolUse: {
            gates: ['pattern-gate']
          }
        },
        gates: {
          'pattern-gate': {
            command: 'echo test',
            file_patterns: ['packages/**', 'src/**/*.ts', '*.json']
          }
        }
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });

  describe('input validation', () => {
    it('does not evaluate dynamic patterns as code', () => {
      // Ensure glob patterns are treated as strings, not code
      const dangerousPatterns = [
        '$(whoami)',
        '`rm -rf /`',
        '${process.env.SECRET}',
        'a; rm -rf /',
        'a && cat /etc/passwd'
      ];

      for (const pattern of dangerousPatterns) {
        const config = createMockConfig({
          hooks: {
            PostToolUse: {
              gates: ['test-gate']
            }
          },
          gates: {
            'test-gate': {
              command: 'echo test',
              file_patterns: [pattern]
            }
          }
        });

        // Should not throw - patterns are strings, not evaluated
        expect(() => validateConfig(config)).not.toThrow();
      }
    });
  });
});

describe('Cross-Plugin Security', () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  beforeEach(() => {
    process.env.CLAUDE_PLUGIN_ROOT = '/home/user/.claude/plugins/rundown';
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  it('resolves sibling plugins correctly', () => {
    const result = resolvePluginPath('cipherpowers');
    // Should resolve to /home/user/.claude/plugins/cipherpowers
    expect(result).toContain('cipherpowers');
    expect(result).toContain('plugins');
  });

  it('prevents escaping to parent directories', () => {
    // These should all fail validation
    expect(() => resolvePluginPath('..')).toThrow();
    expect(() => resolvePluginPath('../secret')).toThrow();
    expect(() => resolvePluginPath('plugin/..')).toThrow();
  });
});
