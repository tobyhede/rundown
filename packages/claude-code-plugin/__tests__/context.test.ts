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
      subagent_type: 'cipherpowers:code-review-agent',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'code-review-agent-start.md'),
      'Review context',
    );
    const result = await injectContext('SubagentStart', input as any);
    expect(result).toBe('Review context');
  });

  it('handles SubagentEnd', async () => {
    const input = {
      hook_event_name: 'SubagentEnd',
      cwd: testDir,
      subagent_type: 'rundown:verify-agent',
    };
    await fs.mkdir(path.join(testDir, '.claude', 'context'), { recursive: true });
    await fs.writeFile(
      path.join(testDir, '.claude', 'context', 'verify-agent-end.md'),
      'Verify agent end context',
    );
    const result = await injectContext('SubagentEnd', input as any);
    expect(result).toBe('Verify agent end context');
  });

  it('SubagentStart returns null when subagent_type is missing', async () => {
    const input = {
      hook_event_name: 'SubagentStart',
      cwd: testDir,
    };
    const result = await injectContext('SubagentStart', input as any);
    expect(result).toBeNull();
  });

  it('SubagentEnd returns null when subagent_type is missing', async () => {
    const input = {
      hook_event_name: 'SubagentEnd',
      cwd: testDir,
    };
    const result = await injectContext('SubagentEnd', input as any);
    expect(result).toBeNull();
  });
});
