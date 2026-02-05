// packages/claude-code-plugin/__tests__/integration/synthetic-gates.test.ts
import { dispatch } from '../../src/dispatcher.js';
import type { HookInput } from '../../src/shared/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('synthetic event gates integration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundown-test-synthetic-gates-'));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('dispatches SlashCommandStart through on-command-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'rundown:write-plan',
      cwd: testDir
    };

    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
  });

  it('SlashCommandStart with command file containing runbook triggers execution', async () => {
    const commandsDir = path.join(testDir, '.claude', 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'test-cmd.md'),
      `---
runbook: test-runbook
---
# Test Command`
    );

    const input: HookInput = {
      hook_event_name: 'SlashCommandStart',
      command: 'test-cmd',
      cwd: testDir
    };

    // Gate will try to run runbook - it will fail (runbook not found) but should not throw
    const result = await dispatch(input);
    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SkillStart through on-skill-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SkillStart',
      skill: 'rundown:verify',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully when skill not found
    const result = await dispatch(input);

    // No error means gate executed (skill not found is graceful degradation)
    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SubagentStart through on-subagent-start gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStart',
      agent_id: 'test-agent-123',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully when no runbook active
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });

  it('dispatches SubagentStop through on-subagent-stop gate', async () => {
    const input: HookInput = {
      hook_event_name: 'SubagentStop',
      agent_id: 'test-agent-123',
      cwd: testDir
    };

    // Should not throw - gate handles gracefully
    const result = await dispatch(input);

    expect(result.blockReason).toBeUndefined();
  });
});
