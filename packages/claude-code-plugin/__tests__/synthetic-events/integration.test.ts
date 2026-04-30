// packages/claude-code-plugin/__tests__/synthetic-events/integration.test.ts
import { dispatch } from '../../src/dispatcher.js';
import { Session } from '../../src/session.js';
import type { HookInput } from '../../src/shared/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Synthetic Events Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-synthetic-integration-'));
    await fs.mkdir(path.join(testDir, '.claude', 'session'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Skill lifecycle', () => {
    it('PreToolUse Skill → SkillStart → sets active_skill', async () => {
      const input: HookInput = {
        hook_event_name: 'PreToolUse',
        cwd: testDir,
        tool_name: 'Skill',
        tool_input: { skill: 'rundown:verify' },
      };

      await dispatch(input);

      const session = new Session(testDir);
      expect(await session.get('active_skill')).toBe('rundown:verify');
    });
  });

  describe('Slash command lifecycle', () => {
    it('UserPromptSubmit /command → SlashCommandStart → sets active_command', async () => {
      const input: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        cwd: testDir,
        prompt: '/execute the plan',
      };

      await dispatch(input);

      const session = new Session(testDir);
      expect(await session.get('active_command')).toBe('execute');
    });

    it('Stop → SlashCommandEnd → clears active_command', async () => {
      await dispatch({
        hook_event_name: 'UserPromptSubmit',
        cwd: testDir,
        prompt: '/verify',
      });

      await dispatch({
        hook_event_name: 'Stop',
        cwd: testDir,
      });

      const session = new Session(testDir);
      expect(await session.get('active_command')).toBeNull();
    });
  });
});
