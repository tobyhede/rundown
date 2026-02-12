// packages/claude-code-plugin/__tests__/plugin-gates.integration.test.ts
import { dispatch } from '../src/dispatcher.js';
import type { HookInput } from '../src/shared/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('Plugin Gate Composition Integration', () => {
  let mockPluginsDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    // Create mock plugins directory with two plugins
    mockPluginsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-mock-plugins-'));

    // Create mock cipherpowers plugin
    const cipherpowersDir = path.join(mockPluginsDir, 'cipherpowers');
    await fs.mkdir(cipherpowersDir, { recursive: true });
    await fs.writeFile(
      path.join(cipherpowersDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          'plan-compliance': {
            command: 'echo "plan-compliance check passed"',
            on_fail: 'BLOCK',
          },
        },
      }),
    );

    // Create mock rundown plugin (current plugin)
    const rundownDir = path.join(mockPluginsDir, 'rundown');
    await fs.mkdir(rundownDir, { recursive: true });
    await fs.writeFile(
      path.join(rundownDir, 'rundown-plugin.json'),
      JSON.stringify({ hooks: {}, gates: {} }),
    );

    // Create test project directory
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-project-'));
    const claudeDir = path.join(projectDir, '.claude');
    await fs.mkdir(claudeDir);

    // Project config references cipherpowers gate
    await fs.writeFile(
      path.join(claudeDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {
          SubagentStop: {
            gates: ['plan-compliance', 'check'],
          },
        },
        gates: {
          'plan-compliance': {
            plugin: 'cipherpowers',
            gate: 'plan-compliance',
          },
          check: {
            command: 'echo "project check passed"',
          },
        },
      }),
    );

    // Set CLAUDE_PLUGIN_ROOT
    originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = path.join(mockPluginsDir, 'rundown');
  });

  afterEach(async () => {
    process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    await fs.rm(mockPluginsDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  test('executes plugin gate followed by project gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: projectDir,
      agent_name: 'test-agent',
    };

    const result = await dispatch(input);

    // Both gates should pass (no blockReason or stopMessage)
    expect(result.blockReason).toBeUndefined();
    expect(result.stopMessage).toBeUndefined();

    // Should have output from both gates
    expect(result.context).toContain('plan-compliance check passed');
    expect(result.context).toContain('project check passed');
  });

  test('plugin gate BLOCK stops execution', async () => {
    // Update cipherpowers gate to fail
    const cipherpowersDir = path.join(mockPluginsDir, 'cipherpowers');
    await fs.writeFile(
      path.join(cipherpowersDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          'plan-compliance': {
            command: 'exit 1',
            on_fail: 'BLOCK',
          },
        },
      }),
    );

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: projectDir,
      agent_name: 'test-agent',
    };

    const result = await dispatch(input);

    // Should be stopped (blockReason will be set)
    expect(result.blockReason).toBeDefined();
  });

  test('prevents circular gate references', async () => {
    // Create circular reference: pluginA -> pluginB -> pluginA
    const pluginADir = path.join(mockPluginsDir, 'pluginA');
    const pluginBDir = path.join(mockPluginsDir, 'pluginB');
    await fs.mkdir(pluginADir, { recursive: true });
    await fs.mkdir(pluginBDir, { recursive: true });

    // PluginA has gate that references pluginB
    await fs.writeFile(
      path.join(pluginADir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          gateA: {
            plugin: 'pluginB',
            gate: 'gateB',
          },
        },
      }),
    );

    // PluginB has gate that references pluginA (circular)
    await fs.writeFile(
      path.join(pluginBDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          gateB: {
            plugin: 'pluginA',
            gate: 'gateA',
          },
        },
      }),
    );

    // Project config references pluginA gate
    const claudeDir = path.join(projectDir, '.claude');
    await fs.writeFile(
      path.join(claudeDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {
          SubagentStop: {
            gates: ['test-circular'],
          },
        },
        gates: {
          'test-circular': {
            plugin: 'pluginA',
            gate: 'gateA',
          },
        },
      }),
    );

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: projectDir,
      agent_name: 'test-agent',
    };

    // Should error or handle gracefully (not infinite loop)
    // Implementation decision: error on circular reference
    await expect(dispatch(input)).rejects.toThrow(/circular|depth|recursion/i);
  });

  test('handles plugin self-reference', async () => {
    // Plugin references its own gate
    const selfRefDir = path.join(mockPluginsDir, 'selfref');
    await fs.mkdir(selfRefDir, { recursive: true });
    await fs.writeFile(
      path.join(selfRefDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {},
        gates: {
          gate1: {
            command: 'echo "gate1"',
          },
          gate2: {
            plugin: 'selfref',
            gate: 'gate1',
          },
        },
      }),
    );

    // Project references the self-referencing gate
    const claudeDir = path.join(projectDir, '.claude');
    await fs.writeFile(
      path.join(claudeDir, 'rundown-plugin.json'),
      JSON.stringify({
        hooks: {
          SubagentStop: {
            gates: ['test-self'],
          },
        },
        gates: {
          'test-self': {
            plugin: 'selfref',
            gate: 'gate2',
          },
        },
      }),
    );

    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      cwd: projectDir,
      agent_name: 'test-agent',
    };

    // Should work - self-reference to a different gate is valid
    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
    expect(result.context).toContain('gate1');
  });
});
