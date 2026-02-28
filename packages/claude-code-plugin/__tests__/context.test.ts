// packages/claude-code-plugin/__tests__/context.test.ts
import { discoverContextFile, injectContext } from '../src/context.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Context Injection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('returns null when no context file exists', async () => {
    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBeNull();
  });

  test('discovers flat context file', async () => {
    const contextDir = path.join(testDir, '.claude', 'context');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(path.join(contextDir, 'test-command-start.md'), 'content');

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(contextDir, 'test-command-start.md'));
  });

  test('discovers slash-command subdirectory', async () => {
    const contextDir = path.join(testDir, '.claude', 'context', 'slash-command');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(path.join(contextDir, 'test-command-start.md'), 'content');

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(contextDir, 'test-command-start.md'));
  });

  test('discovers nested slash-command directory', async () => {
    const contextDir = path.join(testDir, '.claude', 'context', 'slash-command', 'test-command');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(path.join(contextDir, 'start.md'), 'content');

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(contextDir, 'start.md'));
  });

  test('discovers skill context', async () => {
    const contextDir = path.join(testDir, '.claude', 'context', 'skill');
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(path.join(contextDir, 'test-skill-start.md'), 'content');

    const result = await discoverContextFile(testDir, 'test-skill', 'start');
    expect(result).toBe(path.join(contextDir, 'test-skill-start.md'));
  });

  test('follows priority order - flat wins', async () => {
    const contextBase = path.join(testDir, '.claude', 'context');
    await fs.mkdir(path.join(contextBase, 'slash-command'), { recursive: true });

    await fs.writeFile(path.join(contextBase, 'test-command-start.md'), 'flat');
    await fs.writeFile(path.join(contextBase, 'slash-command', 'test-command-start.md'), 'subdir');

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(contextBase, 'test-command-start.md'));
  });
});

describe('extractNameAndStage coverage', () => {
  // Note: injectContext internally uses extractNameAndStage
  // We test via injectContext since extractNameAndStage is not exported

  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('handles SlashCommandStart', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '/commit',
    };
    // Creates .claude/context/commit-start.md
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'commit-start.md'),
      'Start content',
    );
    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe('Start content');
  });

  it('handles SlashCommandEnd', async () => {
    const input = {
      hook_event_name: 'SlashCommandEnd',
      cwd: testDir,
      command: '/commit',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.claude', 'context', 'commit-end.md'), 'End content');
    const result = await injectContext('SlashCommandEnd', input as any);
    expect(result).toBe('End content');
  });

  it('handles SkillStart', async () => {
    const input = {
      hook_event_name: 'SkillStart',
      cwd: testDir,
      skill: 'cipherpowers:brainstorm',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'brainstorm-start.md'),
      'Skill start',
    );
    const result = await injectContext('SkillStart', input as any);
    expect(result).toBe('Skill start');
  });

  it('handles UserPromptSubmit', async () => {
    const input = {
      hook_event_name: 'UserPromptSubmit',
      cwd: testDir,
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'prompt-submit.md'),
      'Prompt context',
    );
    const result = await injectContext('UserPromptSubmit', input as any);
    expect(result).toBe('Prompt context');
  });

  it('returns null for unknown hook event', async () => {
    const input = {
      hook_event_name: 'UnknownEvent',
      cwd: testDir,
    };
    const result = await injectContext('UnknownEvent', input as any);
    expect(result).toBeNull();
  });

  it('handles SubagentStop using modern agent_type field', async () => {
    const input = {
      hook_event_name: 'SubagentStop',
      cwd: testDir,
      agent_type: 'cipherpowers:test-agent',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'test-agent-end.md'),
      'Agent end context',
    );

    const result = await injectContext('SubagentStop', input as any);
    expect(result).toBe('Agent end context');
  });
});

describe('Synthetic event context injection', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('handles SlashCommandStart', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: 'cipherpowers:verify',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'verify-start.md'),
      'Verify context',
    );
    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe('Verify context');
  });

  it('handles SlashCommandEnd', async () => {
    const input = {
      hook_event_name: 'SlashCommandEnd',
      cwd: testDir,
      command: 'cipherpowers:brainstorm',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'brainstorm-end.md'),
      'Brainstorm end context',
    );
    const result = await injectContext('SlashCommandEnd', input as any);
    expect(result).toBe('Brainstorm end context');
  });

  it('handles SkillStart', async () => {
    const input = {
      hook_event_name: 'SkillStart',
      cwd: testDir,
      skill: 'rundown:brainstorm',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'brainstorm-start.md'),
      'Brainstorm context',
    );
    const result = await injectContext('SkillStart', input as any);
    expect(result).toBe('Brainstorm context');
  });

  it('handles SkillEnd', async () => {
    const input = {
      hook_event_name: 'SkillEnd',
      cwd: testDir,
      skill: 'cipherpowers:code-review',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'code-review-end.md'),
      'Code review end context',
    );
    const result = await injectContext('SkillEnd', input as any);
    expect(result).toBe('Code review end context');
  });

  it('handles SubagentStart', async () => {
    const input = {
      hook_event_name: 'SubagentStart',
      cwd: testDir,
      agent_type: 'cipherpowers:code-review-agent',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'code-review-agent-start.md'),
      'Review context',
    );
    const result = await injectContext('SubagentStart', input as any);
    expect(result).toBe('Review context');
  });

  it('handles SubagentStart using agent_type from modern payload', async () => {
    const input = {
      hook_event_name: 'SubagentStart',
      cwd: testDir,
      agent_type: 'cipherpowers:analysis-agent',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'analysis-agent-start.md'),
      'Analysis context',
    );

    const result = await injectContext('SubagentStart', input as any);
    expect(result).toBe('Analysis context');
  });

  it('SubagentStart returns null when agent_type is missing', async () => {
    const input = {
      hook_event_name: 'SubagentStart',
      cwd: testDir,
    };
    const result = await injectContext('SubagentStart', input as any);
    expect(result).toBeNull();
  });
});

describe('Context file discovery - Additional Edge Cases', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('returns null when .claude directory does not exist', async () => {
    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBeNull();
  });

  test('returns null when context directory does not exist', async () => {
    const claudeDir = path.join(testDir, '.claude');
    await fs.mkdir(claudeDir);

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBeNull();
  });

  test('returns null when context file does not exist', async () => {
    const contextDir = path.join(testDir, '.claude', 'context');
    await fs.mkdir(contextDir, { recursive: true });

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBeNull();
  });

  test('discovers context with different stages', async () => {
    const contextDir = path.join(testDir, '.claude', 'context');
    await fs.mkdir(contextDir, { recursive: true });

    await fs.writeFile(path.join(contextDir, 'test-command-start.md'), 'start content');
    await fs.writeFile(path.join(contextDir, 'test-command-end.md'), 'end content');

    const startResult = await discoverContextFile(testDir, 'test-command', 'start');
    const endResult = await discoverContextFile(testDir, 'test-command', 'end');

    expect(startResult).toBe(path.join(contextDir, 'test-command-start.md'));
    expect(endResult).toBe(path.join(contextDir, 'test-command-end.md'));
  });

  test('handles command names with special characters', async () => {
    const contextDir = path.join(testDir, '.claude', 'context');
    await fs.mkdir(contextDir, { recursive: true });

    await fs.writeFile(path.join(contextDir, 'my-command-with-dashes-start.md'), 'content');

    const result = await discoverContextFile(testDir, 'my-command-with-dashes', 'start');
    expect(result).toBe(path.join(contextDir, 'my-command-with-dashes-start.md'));
  });

  test('follows priority order - subdirectory wins over flat when both exist', async () => {
    const contextBase = path.join(testDir, '.claude', 'context');
    const slashCommandDir = path.join(contextBase, 'slash-command');
    await fs.mkdir(slashCommandDir, { recursive: true });

    await fs.writeFile(path.join(slashCommandDir, 'test-command-start.md'), 'subdir');

    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(slashCommandDir, 'test-command-start.md'));
  });

  test('follows priority order - subdirectory wins over nested', async () => {
    const contextBase = path.join(testDir, '.claude', 'context');
    const slashCommandDir = path.join(contextBase, 'slash-command');
    const nestedDir = path.join(slashCommandDir, 'test-command');
    await fs.mkdir(nestedDir, { recursive: true });

    await fs.writeFile(path.join(slashCommandDir, 'test-command-start.md'), 'subdir');
    await fs.writeFile(path.join(nestedDir, 'start.md'), 'nested');

    // Priority: flat > slash-command/name-stage.md > slash-command/name/stage.md
    const result = await discoverContextFile(testDir, 'test-command', 'start');
    expect(result).toBe(path.join(slashCommandDir, 'test-command-start.md'));
  });

  test('discovers skill context with namespace prefix', async () => {
    const contextDir = path.join(testDir, '.claude', 'context', 'skill');
    await fs.mkdir(contextDir, { recursive: true });

    await fs.writeFile(path.join(contextDir, 'namespace-skill-name-start.md'), 'skill content');

    const result = await discoverContextFile(testDir, 'namespace-skill-name', 'start');
    expect(result).toBe(path.join(contextDir, 'namespace-skill-name-start.md'));
  });
});

describe('Context injection - Additional Edge Cases', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rundown-test-'));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('handles missing cwd gracefully', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: '/nonexistent/path',
      command: '/test',
    };

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBeNull();
  });

  test('handles empty command name', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '',
    };

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBeNull();
  });

  test('handles command name with leading slash', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '/commit',
    };

    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'commit-start.md'),
      'Commit context',
    );

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe('Commit context');
  });

  test('handles skill name with namespace separator', async () => {
    const input = {
      hook_event_name: 'SkillStart',
      cwd: testDir,
      skill: 'namespace:skill-name',
    };

    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'skill-name-start.md'),
      'Skill context',
    );

    const result = await injectContext('SkillStart', input as any);
    expect(result).toBe('Skill context');
  });

  test('reads full file content including newlines', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '/test',
    };

    const multilineContent = 'Line 1\nLine 2\nLine 3\n\nLine 5';
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.claude', 'context', 'test-start.md'), multilineContent);

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe(multilineContent);
  });

  test('handles empty context file', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '/test',
    };

    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.claude', 'context', 'test-start.md'), '');

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe('');
  });

  test('handles context file with Unicode content', async () => {
    const input = {
      hook_event_name: 'SlashCommandStart',
      cwd: testDir,
      command: '/test',
    };

    const unicodeContent = 'Unicode: 你好 世界 🚀 émoji';
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(path.join(testDir, '.claude', 'context', 'test-start.md'), unicodeContent);

    const result = await injectContext('SlashCommandStart', input as any);
    expect(result).toBe(unicodeContent);
  });

  test('SessionStart returns null (no context injection)', async () => {
    const input = {
      hook_event_name: 'SessionStart',
      cwd: testDir,
    };

    const result = await injectContext('SessionStart', input as any);
    expect(result).toBeNull();
  });

  test('ConfigChange returns null (no context injection)', async () => {
    const input = {
      hook_event_name: 'ConfigChange',
      cwd: testDir,
    };

    const result = await injectContext('ConfigChange', input as any);
    expect(result).toBeNull();
  });

  test('SkillEnd with namespace prefix', async () => {
    const input = {
      hook_event_name: 'SkillEnd',
      cwd: testDir,
      skill: 'namespace:test-skill',
    };

    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'test-skill-end.md'),
      'Skill end context',
    );

    const result = await injectContext('SkillEnd', input as any);
    expect(result).toBe('Skill end context');
  });
});
