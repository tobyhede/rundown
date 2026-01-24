// packages/claude-code-plugin/__tests__/synthetic-events/integration.test.ts
import { dispatch } from '../../src/dispatcher.js';
import { Session } from '../../src/session.js';
import type { HookInput } from '../../src/shared/index.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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
        tool_input: { skill: 'rundown:verify' }
      };

      await dispatch(input);

      const session = new Session(testDir);
      expect(await session.get('active_skill')).toBe('rundown:verify');
    });
  });

  describe('SubagentStart', () => {
    it('PostToolUse Step → SubagentStart → stores correlation mapping', async () => {
      const input = {
        hook_event_name: 'PostToolUse',
        cwd: testDir,
        tool_name: 'Step',
        tool_input: {
          description: '1.1 - Review code',
          subagent_type: 'code-review-agent'
        },
        tool_use_id: 'toolu_abc123'
      } as HookInput;

      await dispatch(input);

      const session = new Session(testDir);
      const metadata = await session.get('metadata');
      expect(metadata).toEqual(
        expect.objectContaining({
          toolUseIdToStepId: { toolu_abc123: '1.1' }
        })
      );
    });

    it('accumulates correlation mappings for multiple subagents', async () => {
      const input1 = {
        hook_event_name: 'PostToolUse',
        cwd: testDir,
        tool_name: 'Step',
        tool_input: { description: '1.1 - First step' },
        tool_use_id: 'toolu_1'
      } as HookInput;

      const input2 = {
        hook_event_name: 'PostToolUse',
        cwd: testDir,
        tool_name: 'Step',
        tool_input: { description: '1.2 - Second step' },
        tool_use_id: 'toolu_2'
      } as HookInput;

      await dispatch(input1);
      await dispatch(input2);

      const session = new Session(testDir);
      const metadata = await session.get('metadata');
      expect(metadata.toolUseIdToStepId).toEqual({
        toolu_1: '1.1',
        toolu_2: '1.2'
      });
    });
  });
});
