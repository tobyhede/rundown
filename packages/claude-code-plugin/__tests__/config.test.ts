// packages/claude-code-plugin/__tests__/config.test.ts
import { loadConfig, resolvePluginPath } from '../src/shared/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set CLAUDE_PLUGIN_ROOT for tests to point to plugin directory
// __dirname = packages/claude-code-plugin/__tests__, plugin root = packages/claude-code-plugin/ (1 level up)
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

describe('Config Loading', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('returns plugin defaults when no project config exists', async () => {
    // Config loader now returns plugin defaults when no project config exists
    // This provides fallback behavior without requiring every project to have rundown-plugin.json
    const config = await loadConfig(testDir);
    expect(config).not.toBeNull();
    // Verify it's actually plugin defaults by checking for expected structure
    expect(config?.hooks).toBeDefined();
    expect(config?.gates).toBeDefined();
  });

  test('loads .claude/rundown-plugin.json with highest priority', async () => {
    const claudeDir = path.join(testDir, '.claude');
    await fs.mkdir(claudeDir);

    const config1 = { hooks: {}, gates: { test: { command: 'claude-config' } } };
    const config2 = { hooks: {}, gates: { test: { command: 'root-config' } } };

    await fs.writeFile(path.join(claudeDir, 'rundown-plugin.json'), JSON.stringify(config1));
    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(config2));

    const config = await loadConfig(testDir);
    expect(config?.gates.test.command).toBe('claude-config');
  });

  test('loads rundown-plugin.json from root when .claude does not exist', async () => {
    const config1 = { hooks: {}, gates: { test: { command: 'root-config' } } };
    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(config1));

    const config = await loadConfig(testDir);
    expect(config?.gates.test.command).toBe('root-config');
  });

  test('parses valid JSON config', async () => {
    const configObj = {
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit', 'Write'],
          gates: ['format', 'test'],
        },
      },
      gates: {
        format: { command: 'npm run format', on_pass: 'CONTINUE' },
        test: { command: 'npm test', on_pass: 'CONTINUE' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(testDir);
    expect(config?.hooks.PostToolUse.enabled_tools).toEqual(['Edit', 'Write']);
    expect(config?.gates.format.command).toBe('npm run format');
  });

  test('rejects unknown hook event', async () => {
    const configObj = {
      hooks: {
        UnknownEvent: { gates: [] },
      },
      gates: {},
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow('Unknown hook event');
  });

  test('accepts modern Claude hook events', async () => {
    const configObj = {
      hooks: {
        PostToolUseFailure: { gates: ['test'] },
        ConfigChange: { gates: ['test'] },
      },
      gates: {
        test: { command: 'echo test', on_pass: 'CONTINUE' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(testDir);
    expect(config?.hooks.PostToolUseFailure.gates).toEqual(['test']);
    expect(config?.hooks.ConfigChange.gates).toEqual(['test']);
  });

  test('rejects undefined gate reference', async () => {
    const configObj = {
      hooks: {
        PostToolUse: { gates: ['nonexistent'] },
      },
      gates: {},
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow('references undefined gate');
  });

  test('rejects invalid action', async () => {
    const configObj = {
      hooks: {
        PostToolUse: { gates: ['test'] },
      },
      gates: {
        test: { command: 'echo test', on_pass: 'INVALID' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow(
      'is not CONTINUE/BLOCK/STOP or valid gate name',
    );
  });
});

describe('Plugin Path Resolution', () => {
  test('resolves sibling plugin using CLAUDE_PLUGIN_ROOT', () => {
    const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/home/user/.claude/plugins/rundown';

    try {
      const result = resolvePluginPath('cipherpowers');
      expect(result).toBe('/home/user/.claude/plugins/cipherpowers');
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    }
  });

  test('throws when CLAUDE_PLUGIN_ROOT not set', () => {
    const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;

    try {
      expect(() => resolvePluginPath('cipherpowers')).toThrow(
        'Cannot resolve plugin path: CLAUDE_PLUGIN_ROOT not set',
      );
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    }
  });

  test('rejects plugin names with path separators', () => {
    const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/home/user/.claude/plugins/rundown';

    try {
      expect(() => resolvePluginPath('../etc')).toThrow(
        "Invalid plugin name: '../etc' (must not contain path separators)",
      );
      expect(() => resolvePluginPath('foo/bar')).toThrow(
        "Invalid plugin name: 'foo/bar' (must not contain path separators)",
      );
      expect(() => resolvePluginPath('foo\\bar')).toThrow(
        "Invalid plugin name: 'foo\\bar' (must not contain path separators)",
      );
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    }
  });

  test('rejects plugin names with parent directory references', () => {
    const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/home/user/.claude/plugins/rundown';

    try {
      expect(() => resolvePluginPath('..')).toThrow(
        "Invalid plugin name: '..' (must not contain path separators)",
      );
      expect(() => resolvePluginPath('..foo')).toThrow(
        "Invalid plugin name: '..foo' (must not contain path separators)",
      );
    } finally {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    }
  });
});

describe('Hook manifest layout', () => {
  const pluginRoot = path.resolve(__dirname, '..');

  test('plugin manifest points to hooks/hooks.json', async () => {
    const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent) as { hooks?: string };

    expect(manifest.hooks).toBe('./hooks/hooks.json');
  });

  test('package files include hooks directory and exclude root hooks.json', async () => {
    const packageJsonPath = path.join(pluginRoot, 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent) as { files?: string[] };

    expect(packageJson.files).toContain('hooks');
    expect(packageJson.files).not.toContain('hooks.json');
  });

  test('canonical hooks file exists and root hooks.json is absent', async () => {
    await expect(fs.access(path.join(pluginRoot, 'hooks', 'hooks.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(pluginRoot, 'hooks.json'))).rejects.toThrow();
  });
});

describe('Gate Config Validation', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('rejects gate with plugin but no gate name', async () => {
    const configObj = {
      hooks: { PostToolUse: { gates: ['test'] } },
      gates: {
        test: { plugin: 'cipherpowers' }, // Missing gate field
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));
    await expect(loadConfig(testDir)).rejects.toThrow(
      "Gate 'test' has 'plugin' but missing 'gate' field",
    );
  });

  test('rejects gate with gate name but no plugin', async () => {
    const configObj = {
      hooks: { PostToolUse: { gates: ['test'] } },
      gates: {
        test: { gate: 'plan-compliance' }, // Missing plugin field
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));
    await expect(loadConfig(testDir)).rejects.toThrow(
      "Gate 'test' has 'gate' but missing 'plugin' field",
    );
  });

  test('rejects gate with both command and plugin', async () => {
    const configObj = {
      hooks: { PostToolUse: { gates: ['test'] } },
      gates: {
        test: {
          plugin: 'cipherpowers',
          gate: 'plan-compliance',
          command: 'npm run lint', // Conflicting
        },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));
    await expect(loadConfig(testDir)).rejects.toThrow(
      "Gate 'test' cannot have both 'command' and 'plugin/gate'",
    );
  });

  test('accepts valid plugin gate reference', async () => {
    const configObj = {
      hooks: {},
      gates: {
        test: { plugin: 'cipherpowers', gate: 'plan-compliance' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));
    // Should not throw validation error for structure
    // (May fail later when trying to resolve plugin, which is acceptable)
    const config = await loadConfig(testDir);
    expect(config).not.toBeNull();
    expect(config?.gates.test.plugin).toBe('cipherpowers');
    expect(config?.gates.test.gate).toBe('plan-compliance');
  });
});

describe('Config Loading - Additional Edge Cases', () => {
  let testDir: string;
  let originalPluginRoot: string | undefined;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
    // Save and clear CLAUDE_PLUGIN_ROOT to test project config in isolation
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(async () => {
    process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('handles malformed JSON gracefully', async () => {
    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), '{invalid json');

    await expect(loadConfig(testDir)).rejects.toThrow();
  });

  test('handles empty JSON file', async () => {
    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), '{}');

    // {} has no hooks property, so validateConfig calls Object.keys(undefined) which throws
    await expect(loadConfig(testDir)).rejects.toThrow();
  });

  test('validates hooks is an object', async () => {
    const configObj = {
      hooks: 'not an object',
      gates: {},
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow();
  });

  test('rejects non-object gates value', async () => {
    const configObj = {
      hooks: {},
      gates: 'not an object',
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow();
  });

  test('accepts hooks with no gates configured', async () => {
    const configObj = {
      hooks: {
        PostToolUse: {
          enabled_tools: ['Edit'],
        },
      },
      gates: {},
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(testDir);
    expect(config?.hooks.PostToolUse.enabled_tools).toEqual(['Edit']);
  });

  test('does not detect circular references during config load', async () => {
    const configObj = {
      hooks: {
        PostToolUse: { gates: ['gate-a'] },
      },
      gates: {
        'gate-a': { command: 'echo a', on_pass: 'gate-b' },
        'gate-b': { command: 'echo b', on_pass: 'gate-c' },
        'gate-c': { command: 'echo c', on_pass: 'gate-a' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    // Note: Circular detection happens at runtime in dispatcher, not at config load time
    // This test documents that config loading doesn't prevent circular references
    const config = await loadConfig(testDir);
    expect(config).not.toBeNull();
  });

  test('handles nested directory structure for .claude location', async () => {
    const nestedDir = path.join(testDir, 'deep', 'nested', 'project');
    await fs.mkdir(nestedDir, { recursive: true });

    const claudeDir = path.join(nestedDir, '.claude');
    await fs.mkdir(claudeDir);

    const configObj = {
      hooks: {},
      gates: { test: { command: 'echo nested' } },
    };

    await fs.writeFile(path.join(claudeDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(nestedDir);
    expect(config?.gates.test.command).toBe('echo nested');
  });

  test('prioritizes .claude over root when both exist', async () => {
    const claudeDir = path.join(testDir, '.claude');
    await fs.mkdir(claudeDir);

    const claudeConfig = {
      hooks: {},
      gates: { test: { command: 'echo claude' } },
    };
    const rootConfig = {
      hooks: {},
      gates: { test: { command: 'echo root' } },
    };

    await fs.writeFile(path.join(claudeDir, 'rundown-plugin.json'), JSON.stringify(claudeConfig));
    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(rootConfig));

    const config = await loadConfig(testDir);
    expect(config?.gates.test.command).toBe('echo claude');
  });

  test('accepts multiple hook events', async () => {
    const configObj = {
      hooks: {
        PreToolUse: { gates: ['pre-gate'] },
        PostToolUse: { gates: ['post-gate'] },
        PostToolUseFailure: { gates: ['failure-gate'] },
        UserPromptSubmit: { gates: ['prompt-gate'] },
        SubagentStart: { gates: ['start-gate'] },
        SubagentStop: { gates: ['stop-gate'] },
      },
      gates: {
        'pre-gate': { command: 'echo pre' },
        'post-gate': { command: 'echo post' },
        'failure-gate': { command: 'echo failure' },
        'prompt-gate': { command: 'echo prompt' },
        'start-gate': { command: 'echo start' },
        'stop-gate': { command: 'echo stop' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(testDir);
    expect(config?.hooks.PreToolUse.gates).toEqual(['pre-gate']);
    expect(config?.hooks.PostToolUse.gates).toEqual(['post-gate']);
    expect(config?.hooks.PostToolUseFailure.gates).toEqual(['failure-gate']);
    expect(config?.hooks.UserPromptSubmit.gates).toEqual(['prompt-gate']);
    expect(config?.hooks.SubagentStart.gates).toEqual(['start-gate']);
    expect(config?.hooks.SubagentStop.gates).toEqual(['stop-gate']);
  });

  test('rejects gate with invalid action in on_fail', async () => {
    const configObj = {
      hooks: {
        PostToolUse: { gates: ['test'] },
      },
      gates: {
        test: { command: 'echo test', on_pass: 'CONTINUE', on_fail: 'INVALID' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    await expect(loadConfig(testDir)).rejects.toThrow();
  });

  test('accepts gate with STOP action', async () => {
    const configObj = {
      hooks: {},
      gates: {
        test: { command: 'echo test', on_pass: 'STOP' },
      },
    };

    await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configObj));

    const config = await loadConfig(testDir);
    expect(config?.gates.test.on_pass).toBe('STOP');
  });
});
