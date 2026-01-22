// __tests__/security/path-traversal.test.ts
// Security tests for path traversal prevention

import { resolvePluginPath, validateConfig } from '../../src/shared/config.js';
import { isPathInside, safeJoin, sanitizePathSegment, shellEscape } from '../../src/shared/utils.js';
import { discoverContextFile } from '../../src/context.js';
import { execute as executeSkillStart } from '../../src/gates/workflow-skill-start.js';
import { createMockConfig, createMockHookInput } from '../helpers/test-utils.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';

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

  describe('path utilities', () => {
    describe('isPathInside', () => {
      it('returns true for paths inside base', () => {
        expect(isPathInside('/base', '/base/file.txt')).toBe(true);
        expect(isPathInside('/base', '/base/subdir/file.txt')).toBe(true);
      });

      it('returns false for paths outside base', () => {
        expect(isPathInside('/base', '/base/../outside.txt')).toBe(false);
        expect(isPathInside('/base', '/outside.txt')).toBe(false);
        expect(isPathInside('/base', '/base-extra/file.txt')).toBe(false);
      });

      it('returns false for base itself (empty relative path)', () => {
        expect(isPathInside('/base', '/base')).toBe(false);
      });
    });

    describe('safeJoin', () => {
      it('joins paths inside base', () => {
        expect(safeJoin('/base', 'file.txt')).toBe(path.join('/base', 'file.txt'));
        expect(safeJoin('/base', 'subdir', 'file.txt')).toBe(path.join('/base', 'subdir', 'file.txt'));
      });

      it('throws for path traversal', () => {
        expect(() => safeJoin('/base', '../outside.txt')).toThrow(/security violation/i);
        expect(() => safeJoin('/base', 'subdir', '../../outside.txt')).toThrow(/security violation/i);
      });
    });

    describe('sanitizePathSegment', () => {
      it('removes path separators', () => {
        expect(sanitizePathSegment('foo/bar')).toBe('foo_bar');
        expect(sanitizePathSegment('foo\\bar')).toBe('foo_bar');
      });

      it('removes parent references', () => {
        expect(sanitizePathSegment('..')).toBe('__');
        expect(sanitizePathSegment('../../etc/passwd')).toBe('______etc_passwd');
      });
    });

    describe('shellEscape', () => {
      it('escapes dangerous characters', () => {
        expect(shellEscape('foo"bar')).toBe('foo\\"bar');
        expect(shellEscape('foo`bar')).toBe('foo\\`bar');
        expect(shellEscape('foo$bar')).toBe('foo\\$bar');
        expect(shellEscape('foo\\bar')).toBe('foo\\\\bar');
      });

      it('handles complex injection attempts', () => {
        const malicious = 'foo"; rm -rf /; echo "';
        expect(shellEscape(malicious)).toBe('foo\\"; rm -rf /; echo \\"');
      });
    });
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

describe('Path Jail Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'rundown-jail-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('discoverContextFile', () => {
    it('prevents name-based path traversal', async () => {
      // name = ../../../etc/passwd
      const maliciousName = '../../../etc/passwd';
      const result = await discoverContextFile(testDir, maliciousName, 'start');

      // Should not find anything and should not throw (sanitized name won't match)
      expect(result).toBeNull();
    });

    it('prevents stage-based path traversal', async () => {
      // stage = ../../../etc/passwd
      const maliciousStage = '../../../etc/passwd';
      const result = await discoverContextFile(testDir, 'name', maliciousStage);

      expect(result).toBeNull();
    });
  });

  describe('workflow-skill-start', () => {
    it('prevents skill-name-based path traversal', async () => {
      const input = createMockHookInput('SkillStart', {
        cwd: testDir,
        skill: 'evil:../../../etc/passwd'
      });

      // Should not crash and should not access outside paths
      const result = await executeSkillStart(input);
      expect(result).toEqual({});
    });
  });
});
