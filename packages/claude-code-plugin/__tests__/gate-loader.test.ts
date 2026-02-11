// packages/claude-code-plugin/__tests__/gate-loader.test.ts
import { executeShellCommand, executeGate, loadPluginGate } from '../src/gate-loader.js';
import type { GateConfig, HookInput } from '../src/shared/index.js';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Gate Loader - Shell Commands', () => {
  test('executes shell command and returns exit code', async () => {
    const result = await executeShellCommand('echo "test"', process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('test');
  });

  test('captures non-zero exit code', async () => {
    const result = await executeShellCommand('exit 1', process.cwd());
    expect(result.exitCode).toBe(1);
  });

  test('captures stdout', async () => {
    const result = await executeShellCommand('echo "hello world"', process.cwd());
    expect(result.output).toContain('hello world');
  });

  test('captures stderr', async () => {
    const result = await executeShellCommand('echo "error" >&2', process.cwd());
    expect(result.output).toContain('error');
  });

  test('executes in specified directory', async () => {
    const tmpDir = os.tmpdir();
    const result = await executeShellCommand('pwd', tmpDir);
    // macOS may prepend /private to paths
    expect(result.output.trim()).toMatch(new RegExp(tmpDir.replace('/var/', '(/private)?/var/')));
  });

  test('timeout returns exit code 124 and timeout message', async () => {
    const result = await executeShellCommand('sleep 1', process.cwd(), 100);
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain('timed out');
  });
});

describe('Gate Loader - executeGate', () => {
  const mockInput: HookInput = {
    hook_event_name: 'PostToolUse',
    cwd: process.cwd(),
  };

  test('shell command gate with exit 0 returns passed=true', async () => {
    const gateConfig: GateConfig = {
      command: 'echo "success"',
    };

    const result = await executeGate('test-gate', gateConfig, mockInput);

    expect(result.passed).toBe(true);
    expect(result.result.additionalContext).toContain('success');
  });

  test('shell command gate with exit 1 returns passed=false', async () => {
    const gateConfig: GateConfig = {
      command: 'exit 1',
    };

    const result = await executeGate('test-gate', gateConfig, mockInput);

    expect(result.passed).toBe(false);
  });

  test('built-in gate throws error when gate not found', async () => {
    const gateConfig: GateConfig = {
      // No command = built-in gate
    };

    await expect(executeGate('nonexistent-gate', gateConfig, mockInput)).rejects.toThrow(
      'Failed to load built-in gate nonexistent-gate',
    );
  });
});

describe('Plugin Gate Loading', () => {
  let mockPluginDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Create mock plugin directory structure
    mockPluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-mock-plugins-'));
    const cipherpowersDir = path.join(mockPluginDir, 'cipherpowers');
    await fs.mkdir(cipherpowersDir, { recursive: true });

    // Create mock rundown-plugin.json for cipherpowers
    const gatesConfig = {
      hooks: {},
      gates: {
        'plan-compliance': {
          command: 'node dist/gates/plan-compliance.js',
          on_fail: 'BLOCK',
        },
      },
    };
    await fs.writeFile(
      path.join(cipherpowersDir, 'rundown-plugin.json'),
      JSON.stringify(gatesConfig),
    );

    // Set CLAUDE_PLUGIN_ROOT to point to rundown sibling
    originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = path.join(mockPluginDir, 'rundown');
  });

  afterEach(async () => {
    process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    await fs.rm(mockPluginDir, { recursive: true, force: true });
  });

  test('loads gate config from plugin', async () => {
    const result = await loadPluginGate('cipherpowers', 'plan-compliance');

    expect(result.gateConfig.command).toBe('node dist/gates/plan-compliance.js');
    expect(result.gateConfig.on_fail).toBe('BLOCK');
    expect(result.pluginRoot).toBe(path.join(mockPluginDir, 'cipherpowers'));
  });

  test('throws when plugin rundown-plugin.json not found', async () => {
    await expect(loadPluginGate('nonexistent', 'some-gate')).rejects.toThrow(
      "Cannot find rundown-plugin.json for plugin 'nonexistent'",
    );
  });

  test('throws when gate not found in plugin', async () => {
    await expect(loadPluginGate('cipherpowers', 'nonexistent-gate')).rejects.toThrow(
      "Gate 'nonexistent-gate' not found in plugin 'cipherpowers'",
    );
  });

  test('validates loaded plugin config structure', async () => {
    // Create plugin with malformed rundown-plugin.json
    const malformedDir = path.join(mockPluginDir, 'malformed');
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(
      path.join(malformedDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          'bad-gate': {
            // Missing required fields (no command, plugin, or gate)
          },
        },
      }),
    );

    // This should succeed loading but the gate config is invalid
    // Validation happens when the gate is used, not when loading
    const result = await loadPluginGate('malformed', 'bad-gate');
    expect(result.gateConfig).toBeDefined();
  });

  test('executeGate handles plugin gate reference', async () => {
    const gateConfig: GateConfig = {
      plugin: 'cipherpowers',
      gate: 'plan-compliance',
    };

    const mockInput: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: '/some/project',
    };

    // The command from cipherpowers will be executed in cipherpowers plugin dir
    // For this test, the mock plugin has 'node dist/gates/plan-compliance.js'
    // which won't exist, so it will fail - but we can verify the flow
    const result = await executeGate('my-gate', gateConfig, mockInput);

    // Command execution will fail (file doesn't exist) but flow is correct
    expect(result.passed).toBe(false);
  });
});
