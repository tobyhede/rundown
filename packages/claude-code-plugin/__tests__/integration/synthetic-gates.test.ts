// packages/claude-code-plugin/__tests__/integration/synthetic-gates.test.ts
import { dispatch } from '../../src/dispatcher.js';
import type { HookInput } from '../../src/shared/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('synthetic event gates integration', () => {
  let testDir: string;
  let originalPluginRoot: string | undefined;

  /**
   * Helper to write plugin config enabling SlashCommandStart gate
   */
  function writePluginConfig(): void {
    fs.writeFileSync(
      path.join(testDir, 'rundown-plugin.json'),
      JSON.stringify({
        gates: { 'on-command-start': {} },
        hooks: { SlashCommandStart: { gates: ['on-command-start'] } },
      }),
    );
  }

  /**
   * Helper to create a command file with runbook frontmatter
   */
  function createCommandFile(name: string, runbook: string): void {
    const commandsDir = path.join(testDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, `${name}.md`),
      `---
runbook: ${runbook}
---
# Test Command`,
    );
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-test-synthetic-gates-'));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    if (originalPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  it('dispatches SlashCommandStart through on-command-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'rundown:write-plan',
      cwd: testDir,
    };

    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
  });

  it('SlashCommandStart with command file containing runbook triggers execution', async () => {
    writePluginConfig();
    createCommandFile('test-cmd', 'test-runbook');

    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'test-cmd',
      cwd: testDir,
    };

    // Gate executes - runbook not found results in error output (not a block)
    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
    // Gate returns formatted error output
    expect(result.context).toBeDefined();
    expect(result.context).toMatch(/RUNBOOK ERROR/);
  });

  it('gate output includes rd usage instructions on error', async () => {
    writePluginConfig();
    createCommandFile('test-cmd', 'nonexistent-runbook');

    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'test-cmd',
      cwd: testDir,
    };

    const result = await dispatch(input);
    expect(result.context).toBeDefined();
    // Error output includes manual recovery instructions
    expect(result.context).toContain('Manual Recovery');
    expect(result.context).toContain('rd run nonexistent-runbook');
  });

  it('context injection appears before gate output', async () => {
    writePluginConfig();
    createCommandFile('test-cmd', 'test-runbook');

    // Create context injection file
    const contextDir = path.join(testDir, '.claude', 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(
      path.join(contextDir, 'test-cmd-start.md'),
      '## INJECTED CONTEXT\nThis should appear first.',
    );

    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'test-cmd',
      cwd: testDir,
    };

    const result = await dispatch(input);
    expect(result.context).toBeDefined();

    // Find positions of content markers
    const injectedPos = result.context!.indexOf('INJECTED CONTEXT');
    const runbookPos = result.context!.indexOf('RUNBOOK');

    // Context injection should appear before gate output
    expect(injectedPos).toBeGreaterThanOrEqual(0);
    expect(runbookPos).toBeGreaterThanOrEqual(0);
    expect(injectedPos).toBeLessThan(runbookPos);
  });

  it('dispatches SkillStart through on-skill-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SkillStart',
      skill: 'rundown:verify',
      cwd: testDir,
    };

    // Should not throw - gate handles gracefully when skill not found
    const result = await dispatch(input);

    // No error means gate executed (skill not found is graceful degradation)
    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches PreToolUse(Task) through on-delegation-dispatch gate', async () => {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_input: { prompt: 'No delegation marker here', description: 'Just a task' },
      cwd: testDir,
    };

    // Should not block - no delegation marker means gate passes through
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SubagentStop through on-subagent-stop gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      agent_id: 'test-agent-123',
      last_assistant_message: 'STATUS: PASS',
      cwd: testDir,
    };

    // Should not throw - gate handles gracefully (no active delegation token)
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });
});
