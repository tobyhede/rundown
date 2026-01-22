import { jest } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// Mock only what is necessary and external to the logic we want to test
jest.unstable_mockModule('../src/context.js', () => ({
  injectContext: jest.fn().mockResolvedValue('injected context'),
}));

jest.unstable_mockModule('../src/gate-loader.js', () => ({
  executeGate: jest.fn().mockResolvedValue({ passed: true, result: 'gate result' }),
}));

jest.unstable_mockModule('../src/workflow/context.js', () => ({
  getWorkflowContext: jest.fn().mockReturnValue('workflow context'),
}));

// Now we can import the module under test using dynamic import
const { dispatch, gateMatchesFilePattern } = await import('../src/dispatcher.js');
const { Session } = await import('../src/session.js');
const { detectSyntheticEvents } = await import('../src/synthetic-events/detector.js');

describe('Dispatcher Coverage Extensions', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-coverage-'));
    // Ensure .claude directory exists for Session
    await fs.mkdir(path.join(testDir, '.claude', 'session'), { recursive: true });
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('updateSessionState coverage', () => {
    it('handles all session state events', async () => {
      const session = new Session(testDir);
      
      // SlashCommandStart
      await dispatch({ hook_event_name: 'SlashCommandStart', cwd: testDir, command: 'cmd1' } as any);
      expect(await session.get('active_command')).toBe('cmd1');

      // SlashCommandEnd (via Stop synthetic event)
      await dispatch({ hook_event_name: 'Stop', cwd: testDir } as any);
      expect(await session.get('active_command')).toBeNull();

      // SkillStart
      await dispatch({ hook_event_name: 'SkillStart', cwd: testDir, skill: 'skill1' } as any);
      expect(await session.get('active_skill')).toBe('skill1');

      // SkillEnd
      await dispatch({ hook_event_name: 'SkillEnd', cwd: testDir } as any);
      expect(await session.get('active_skill')).toBeNull();

      // SubagentStart
      await dispatch({ hook_event_name: 'SubagentStart', cwd: testDir, tool_use_id: 't1', step_id: 's1' } as any);
      const metadata = await session.get('metadata');
      expect(metadata.toolUseIdToStepId).toMatchObject({ t1: 's1' });

      // PostToolUse with extension
      await dispatch({ hook_event_name: 'PostToolUse', cwd: testDir, file_path: 'test.ts' } as any);
      expect(await session.contains('edited_files', 'test.ts')).toBe(true);
      expect(await session.contains('file_extensions', 'ts')).toBe(true);
    });

    it('handles session errors gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const sessionDir = path.join(testDir, '.claude', 'session');
      await fs.mkdir(path.join(sessionDir, 'state.json'), { recursive: true });
      await dispatch({ hook_event_name: 'SlashCommandStart', cwd: testDir, command: 'test' } as any);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[Session Error]'));
      consoleSpy.mockRestore();
    });
  });

  describe('gateMatchesFilePattern coverage', () => {
    it('covers path jail and error handling', async () => {
      const config = { file_patterns: ['**/*.ts'] } as any;
      expect(await gateMatchesFilePattern(config, '/outside/path.ts', testDir)).toBe(false);
      expect(await gateMatchesFilePattern({ file_patterns: [null as any] } as any, 'test.ts', testDir)).toBe(false);
    });
  });

  describe('dispatch coverage', () => {
    it('covers various dispatch branches', async () => {
      // No config
      const res1 = await dispatch({ hook_event_name: 'UserPromptSubmit', cwd: testDir } as any);
      expect(res1.context).toBeDefined();

      // Config with missing hook
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify({ hooks: {}, gates: {} }));
      const res2 = await dispatch({ hook_event_name: 'UserPromptSubmit', cwd: testDir } as any);
      expect(res2.context).toBeDefined();

      // Config with filtered hook
      const config3 = { 
        hooks: { PostToolUse: { enabled_tools: ['Write'], gates: ['g1'] } },
        gates: { g1: { command: 'echo' } }
      };
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(config3));
      const res3 = await dispatch({ hook_event_name: 'PostToolUse', tool_name: 'Read', cwd: testDir } as any);
      expect(res3.context).toBeDefined();

      // Keyword skip
      const configKeyword = {
        hooks: { UserPromptSubmit: { gates: ['g1'] } },
        gates: { g1: { command: 'echo', keywords: ['important'] } }
      };
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configKeyword));
      const resKeyword = await dispatch({ hook_event_name: 'UserPromptSubmit', user_message: 'not related', cwd: testDir } as any);
      expect(resKeyword.context).not.toContain('gate result');

      // File pattern skip
      const configPattern = {
        hooks: { PostToolUse: { gates: ['g1'] } },
        gates: { g1: { command: 'echo', file_patterns: ['src/**'] } }
      };
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(configPattern));
      const resPattern = await dispatch({ hook_event_name: 'PostToolUse', file_path: 'README.md', cwd: testDir } as any);
      expect(resPattern.context).not.toContain('gate result');

      // Chained gate
      const config5 = { 
        hooks: { UserPromptSubmit: { gates: ['g1'] } },
        gates: { g1: { command: 'echo', on_pass: 'g2' }, g2: { command: 'echo' } }
      };
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(config5));
      const res5 = await dispatch({ hook_event_name: 'UserPromptSubmit', cwd: testDir } as any);
      expect(res5).toBeDefined();
    });

    it('handles circuit breaker', async () => {
      const config = {
        hooks: { UserPromptSubmit: { gates: ['g1'] } },
        gates: {
          g1: { command: 'echo', on_pass: 'g1' } // Self-chain
        }
      };
      await fs.writeFile(path.join(testDir, 'rundown-plugin.json'), JSON.stringify(config));
      const res = await dispatch({ hook_event_name: 'UserPromptSubmit', cwd: testDir } as any);
      expect(res.blockReason).toContain('Exceeded max gate chain depth');
    });

    it('handles synthetic events thoroughly', async () => {
      // UserPromptSubmit -> SlashCommandStart
      const res1 = await dispatch({ hook_event_name: 'UserPromptSubmit', user_message: '/test', cwd: testDir } as any);
      expect(res1).toBeDefined();

      // PreToolUse Skill -> SkillStart
      const res2 = await dispatch({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 's' }, cwd: testDir } as any);
      expect(res2).toBeDefined();

      // PostToolUse Skill -> SkillEnd
      const res3 = await dispatch({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 's' }, cwd: testDir } as any);
      expect(res3).toBeDefined();

      // PostToolUse Step -> SubagentStart
      const res4 = await dispatch({ hook_event_name: 'PostToolUse', tool_name: 'Step', tool_input: { description: '1 - d' }, cwd: testDir } as any);
      expect(res4).toBeDefined();
    });
  });

  describe('detector coverage', () => {
    it('covers all detector branches', () => {
      expect(detectSyntheticEvents({ hook_event_name: 'UserPromptSubmit', user_message: '/cmd' } as any)).toHaveLength(1);
      expect(detectSyntheticEvents({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 's' } } as any)).toHaveLength(1);
      expect(detectSyntheticEvents({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 's' } } as any)).toHaveLength(1);
      expect(detectSyntheticEvents({ hook_event_name: 'PostToolUse', tool_name: 'Step', tool_input: { description: '1.1 - d' } } as any)).toHaveLength(1);
      expect(detectSyntheticEvents({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: { description: '2 - d' } } as any)).toHaveLength(1);
    });
  });
});
