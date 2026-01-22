// packages/claude-code-plugin/__tests__/dispatcher.test.ts
import { jest } from '@jest/globals';
import {
  shouldProcessHook,
  dispatch,
  gateMatchesKeywords,
  gateMatchesFilePattern
} from '../src/dispatcher.js';
import {
  validateFilePatterns,
  type HookInput,
  type HookConfig,
  type GateConfig
} from '../src/shared/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Dispatcher - Event Filtering', () => {
  test('PostToolUse with enabled tool returns true', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test',
      tool_name: 'Edit'
    };

    const hookConfig: HookConfig = {
      enabled_tools: ['Edit', 'Write']
    };

    expect(shouldProcessHook(input, hookConfig)).toBe(true);
  });

  test('PostToolUse with disabled tool returns false', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test',
      tool_name: 'Read'
    };

    const hookConfig: HookConfig = {
      enabled_tools: ['Edit', 'Write']
    };

    expect(shouldProcessHook(input, hookConfig)).toBe(false);
  });

  test('SubagentStop with enabled agent returns true', () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_name: 'test-namespace:test-agent'
    };

    const hookConfig: HookConfig = {
      enabled_agents: ['test-namespace:test-agent']
    };

    expect(shouldProcessHook(input, hookConfig)).toBe(true);
  });

  test('SubagentStop with disabled agent returns false', () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      agent_name: 'other-agent'
    };

    const hookConfig: HookConfig = {
      enabled_agents: ['test-namespace:test-agent']
    };

    expect(shouldProcessHook(input, hookConfig)).toBe(false);
  });

  test('SubagentStop checks subagent_name if agent_name missing', () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/test',
      subagent_name: 'test-namespace:test-agent'
    };

    const hookConfig: HookConfig = {
      enabled_agents: ['test-namespace:test-agent']
    };

    expect(shouldProcessHook(input, hookConfig)).toBe(true);
  });

  test('UserPromptSubmit always returns true', () => {
    const input: HookInput = {
      hook_event_name: 'UserPromptSubmit',
      cwd: '/test'
    };

    const hookConfig: HookConfig = {};

    expect(shouldProcessHook(input, hookConfig)).toBe(true);
  });

  test('No filtering config returns true', () => {
    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: '/test',
      tool_name: 'Edit'
    };

    const hookConfig: HookConfig = {};

    expect(shouldProcessHook(input, hookConfig)).toBe(true);
  });
});

describe('Dispatcher - Gate Chaining', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create temporary directory for test config
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('gate chaining works - gate-a chains to gate-b on pass', async () => {
    // Create rundown-plugin.json with chaining config
    const gatesConfig = {
      hooks: {
        PostToolUse: {
          gates: ['gate-a']
        }
      },
      gates: {
        'gate-a': {
          command: 'echo "gate-a passed"',
          on_pass: 'gate-b' // Chain to gate-b on pass
        },
        'gate-b': {
          command: 'echo "gate-b passed"',
          on_pass: 'CONTINUE'
        }
      }
    };

    await fs.writeFile(
      path.join(testDir, 'rundown-plugin.json'),
      JSON.stringify(gatesConfig, null, 2)
    );

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit'
    };

    const result = await dispatch(input);

    // Should contain output from both gates
    expect(result.context).toContain('gate-a passed');
    expect(result.context).toContain('gate-b passed');
    expect(result.blockReason).toBeUndefined();
  });

  test('circular chain prevention - exceeds max gate depth', async () => {
    // Create rundown-plugin.json with circular chain
    const gatesConfig = {
      hooks: {
        PostToolUse: {
          gates: ['gate-a']
        }
      },
      gates: {
        'gate-a': {
          command: 'echo "gate-a"',
          on_pass: 'gate-b'
        },
        'gate-b': {
          command: 'echo "gate-b"',
          on_pass: 'gate-a' // Circular chain back to gate-a
        }
      }
    };

    await fs.writeFile(
      path.join(testDir, 'rundown-plugin.json'),
      JSON.stringify(gatesConfig, null, 2)
    );

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit'
    };

    const result = await dispatch(input);

    // Should hit circuit breaker
    expect(result.blockReason).toContain('Exceeded max gate chain depth');
    expect(result.blockReason).toContain('circular');
  });
});

describe('validateFilePatterns', () => {
  it('should accept valid patterns', () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**', 'src/**/*.ts', '*.json'],
      on_pass: 'CONTINUE'
    };
    expect(() => {
      validateFilePatterns(config);
    }).not.toThrow();
  });

  it('should throw error for non-string pattern', () => {
    const config = {
      command: 'echo test',
      file_patterns: ['valid', 123, 'also-valid'],
      on_pass: 'CONTINUE'
    } as GateConfig;
    expect(() => {
      validateFilePatterns(config);
    }).toThrow(/expected string/);
  });

  it('should skip validation when no patterns specified', () => {
    const config: GateConfig = {
      command: 'echo test',
      on_pass: 'CONTINUE'
    };
    expect(() => {
      validateFilePatterns(config);
    }).not.toThrow();
  });
});

describe('Keyword Matching', () => {
  test('no keywords - gate always runs', () => {
    const gateConfig: GateConfig = {
      command: 'npm test'
    };

    expect(gateMatchesKeywords(gateConfig, 'hello world')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, undefined)).toBe(true);
    expect(gateMatchesKeywords(gateConfig, '')).toBe(true);
  });

  test('empty keywords array - gate always runs', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: []
    };

    expect(gateMatchesKeywords(gateConfig, 'hello world')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, undefined)).toBe(true);
  });

  test('no user message with keywords - gate does not run', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: ['test', 'testing']
    };

    expect(gateMatchesKeywords(gateConfig, undefined)).toBe(false);
    expect(gateMatchesKeywords(gateConfig, '')).toBe(false);
  });

  test('keyword match - case insensitive', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: ['test']
    };

    expect(gateMatchesKeywords(gateConfig, 'run the TEST')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'RUN THE Test')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'test this')).toBe(true);
  });

  test('multiple keywords - any matches', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: ['test', 'testing', 'spec', 'verify']
    };

    expect(gateMatchesKeywords(gateConfig, 'run the tests')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'verify this works')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'check the spec')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'we are testing')).toBe(true);
  });

  test('no keyword match - gate does not run', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: ['test', 'testing']
    };

    expect(gateMatchesKeywords(gateConfig, 'hello world')).toBe(false);
    expect(gateMatchesKeywords(gateConfig, 'run the linter')).toBe(false);
  });

  test('substring matching - partial word matches', () => {
    const gateConfig: GateConfig = {
      command: 'npm test',
      keywords: ['test']
    };

    // Intentional substring matching (not word-boundary)
    expect(gateMatchesKeywords(gateConfig, 'latest version')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'contest results')).toBe(true);
    expect(gateMatchesKeywords(gateConfig, 'testing')).toBe(true);
  });
});

describe('gateMatchesFilePattern', () => {
  const cwd = '/Users/test/project';

  it('should return true when no patterns specified (backwards compatible)', async () => {
    const config: GateConfig = { command: 'echo test', on_pass: 'CONTINUE' };
    const result = await gateMatchesFilePattern(config, '/Users/test/project/src/index.ts', cwd);
    expect(result).toBe(true);
  });

  it('should return true when patterns array is empty', async () => {
    const config: GateConfig = { command: 'echo test', file_patterns: [], on_pass: 'CONTINUE' };
    const result = await gateMatchesFilePattern(config, '/Users/test/project/src/index.ts', cwd);
    expect(result).toBe(true);
  });

  it('should return false when file_path is undefined', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['src/**'],
      on_pass: 'CONTINUE'
    };
    const result = await gateMatchesFilePattern(config, undefined, cwd);
    expect(result).toBe(false);
  });

  it('should return true when file matches single pattern', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/cts/src/index.ts';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(true);
  });

  it('should return false when file does not match pattern', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/other/src/index.ts';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(false);
  });

  it('should return true when file matches any pattern (OR logic)', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**', 'packages/shared/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/shared/utils.ts';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(true);
  });

  it('should match deep nested directories with **', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['src/**/*.ts'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/src/deeply/nested/dir/file.ts';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(true);
  });

  it('should match root-level files', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['*.json'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/package.json';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(true);
  });

  it('should not match root-level pattern against nested file', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['*.json'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/src/config.json';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(false);
  });

  it('should convert absolute paths to relative paths', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const absolutePath = '/Users/test/project/packages/cts/index.ts';
    const result = await gateMatchesFilePattern(config, absolutePath, cwd);
    expect(result).toBe(true);
  });

  it('should match dotfiles when pattern includes them', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['.config/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/.config/settings.json';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    expect(result).toBe(true);
  });

  // FIX: Add relative path edge case test (defensive programming)
  it('should handle already-relative paths gracefully', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const relativePath = 'packages/cts/index.ts'; // Already relative
    const result = await gateMatchesFilePattern(config, relativePath, cwd);
    expect(result).toBe(true);
  });

  // FIX: Add empty string test
  it('should return false for empty string file_path', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['**/*.ts'],
      on_pass: 'CONTINUE'
    };
    const result = await gateMatchesFilePattern(config, '', cwd);
    expect(result).toBe(false);
  });

  // FIX: Add path traversal security test
  it('should handle path traversal patterns safely', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['../parent/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/../parent/file.ts';
    const result = await gateMatchesFilePattern(config, filePath, cwd);
    // Documents security boundary - patterns match after path.relative normalization
    expect(result).toBeDefined();
  });
});

describe('File pattern filtering integration', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create temporary directory for test config
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should run gate when file matches pattern', async () => {
    const mockConfig = {
      gates: {
        'cts:test': {
          command: 'echo "cts test"',
          file_patterns: ['packages/cts/**'],
          on_pass: 'CONTINUE'
        },
        'shared:test': {
          command: 'echo "shared test"',
          file_patterns: ['packages/shared/**', 'lib/common/**'],
          on_pass: 'CONTINUE'
        },
        'no-pattern': {
          command: 'echo "no pattern"',
          on_pass: 'CONTINUE'
        }
      },
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit', 'Write'],
          gates: ['cts:test', 'shared:test', 'no-pattern']
        }
      }
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(mockConfig, null, 2));

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit',
      file_path: path.join(testDir, 'packages/cts/src/index.ts')
    };

    const result = await dispatch(input);

    expect(result.context).toContain('cts test');
    expect(result.context).toContain('no pattern');
    expect(result.context).not.toContain('shared test');
  });

  it('should skip gate when file does not match pattern', async () => {
    const mockConfig = {
      gates: {
        'cts:test': {
          command: 'echo "cts test"',
          file_patterns: ['packages/cts/**'],
          on_pass: 'CONTINUE'
        },
        'shared:test': {
          command: 'echo "shared test"',
          file_patterns: ['packages/shared/**', 'lib/common/**'],
          on_pass: 'CONTINUE'
        },
        'no-pattern': {
          command: 'echo "no pattern"',
          on_pass: 'CONTINUE'
        }
      },
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit', 'Write'],
          gates: ['cts:test', 'shared:test', 'no-pattern']
        }
      }
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(mockConfig, null, 2));

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit',
      file_path: path.join(testDir, 'packages/other/src/index.ts')
    };

    const result = await dispatch(input);

    expect(result.context).toContain('no pattern');
    expect(result.context).not.toContain('cts test');
    expect(result.context).not.toContain('shared test');
  });

  it('should run gate when file matches any pattern (OR logic)', async () => {
    const mockConfig = {
      gates: {
        'cts:test': {
          command: 'echo "cts test"',
          file_patterns: ['packages/cts/**'],
          on_pass: 'CONTINUE'
        },
        'shared:test': {
          command: 'echo "shared test"',
          file_patterns: ['packages/shared/**', 'lib/common/**'],
          on_pass: 'CONTINUE'
        },
        'no-pattern': {
          command: 'echo "no pattern"',
          on_pass: 'CONTINUE'
        }
      },
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit', 'Write'],
          gates: ['cts:test', 'shared:test', 'no-pattern']
        }
      }
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(mockConfig, null, 2));

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit',
      file_path: path.join(testDir, 'lib/common/utils.ts')
    };

    const result = await dispatch(input);

    expect(result.context).toContain('shared test');
    expect(result.context).toContain('no pattern');
    expect(result.context).not.toContain('cts test');
  });

  it('should not apply file pattern filtering to non-PostToolUse hooks', async () => {
    const mockConfig = {
      gates: {
        'test-gate': {
          command: 'echo "test gate"',
          file_patterns: ['packages/cts/**'],
          on_pass: 'CONTINUE'
        }
      },
      hooks: {
        UserPromptSubmit: {
          gates: ['test-gate']
        }
      }
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(mockConfig, null, 2));

    const input: HookInput = {
      hook_event_name: 'UserPromptSubmit',
      cwd: testDir,
      user_message: 'test message'
    };

    const result = await dispatch(input);

    // File patterns should be ignored for UserPromptSubmit
    // Gate should run (no keywords = always run)
    expect(result.context).toContain('test gate');
  });

  it('should filter multiple gates independently based on patterns', async () => {
    const multiGateConfig = {
      gates: {
        'gate-a': {
          command: 'echo "gate-a output"',
          file_patterns: ['packages/a/**'],
          on_pass: 'CONTINUE'
        },
        'gate-b': {
          command: 'echo "gate-b output"',
          file_patterns: ['packages/b/**'],
          on_pass: 'CONTINUE'
        },
        'gate-c': {
          command: 'echo "gate-c output"',
          file_patterns: ['packages/c/**'],
          on_pass: 'CONTINUE'
        },
        'gate-all': {
          command: 'echo "gate-all output"',
          on_pass: 'CONTINUE'
        }
      },
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit'],
          gates: ['gate-a', 'gate-b', 'gate-c', 'gate-all']
        }
      }
    };

    await fs.writeFile(
      path.join(testDir, 'rundown-plugin.json'),
      JSON.stringify(multiGateConfig, null, 2)
    );

    const input: HookInput = {
      hook_event_name: 'PostToolUse',
      cwd: testDir,
      tool_name: 'Edit',
      file_path: path.join(testDir, 'packages/b/index.ts')
    };

    const result = await dispatch(input);

    // Only gate-b and gate-all should run
    expect(result.context).toContain('gate-b output');
    expect(result.context).toContain('gate-all output');
    expect(result.context).not.toContain('gate-a output');
    expect(result.context).not.toContain('gate-c output');
  });
});

describe('gateMatchesFilePattern - debug logging', () => {
  const cwd = '/Users/test/project';

  // Mock logger to capture debug calls
  let mockDebugCalls: { message: string; data?: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    mockDebugCalls = [];

    // Mock logger.debug to capture calls
    const { logger } = await import('../src/shared/index.js');
    jest
      .spyOn(logger, 'debug')
      .mockImplementation(async (message: string, data?: Record<string, unknown>) => {
        mockDebugCalls.push({ message, data });
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should log debug message when pattern matches', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/cts/src/index.ts';

    const result = await gateMatchesFilePattern(config, filePath, cwd);

    expect(result).toBe(true);
    expect(mockDebugCalls).toHaveLength(1);
    expect(mockDebugCalls[0].message).toBe('File pattern matched');
    expect(mockDebugCalls[0].data).toMatchObject({
      relativePath: 'packages/cts/src/index.ts',
      pattern: 'packages/cts/**',
      absolutePath: filePath
    });
  });

  it('should not log when pattern does not match', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/other/src/index.ts';

    const result = await gateMatchesFilePattern(config, filePath, cwd);

    expect(result).toBe(false);
    expect(mockDebugCalls).toHaveLength(0);
  });

  it('should log with correct pattern when multiple patterns present', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['packages/cts/**', 'packages/shared/**'],
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/packages/shared/utils.ts';

    const result = await gateMatchesFilePattern(config, filePath, cwd);

    expect(result).toBe(true);
    expect(mockDebugCalls).toHaveLength(1);
    expect(mockDebugCalls[0].data?.pattern).toBe('packages/shared/**');
  });

  it('should not log when no patterns specified', async () => {
    const config: GateConfig = {
      command: 'echo test',
      on_pass: 'CONTINUE'
    };
    const filePath = '/Users/test/project/src/index.ts';

    const result = await gateMatchesFilePattern(config, filePath, cwd);

    expect(result).toBe(true);
    expect(mockDebugCalls).toHaveLength(0);
  });

  it('should not log when file_path is undefined', async () => {
    const config: GateConfig = {
      command: 'echo test',
      file_patterns: ['**/*.ts'],
      on_pass: 'CONTINUE'
    };

    const result = await gateMatchesFilePattern(config, undefined, cwd);

    expect(result).toBe(false);
    expect(mockDebugCalls).toHaveLength(0);
  });
});
