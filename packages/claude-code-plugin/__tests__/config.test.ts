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
