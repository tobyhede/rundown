// packages/claude-code-plugin/__tests__/gates/on-command-start.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockExecFileSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execFileSync: mockExecFileSync
}));

jest.unstable_mockModule('fs', () => ({
  readFileSync: mockReadFileSync
}));

const { execute, parseRunbookFromFrontmatter } =
  await import('../../src/gates/on-command-start.js');

describe('on-command-start gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseRunbookFromFrontmatter', () => {
    it('extracts runbook field from frontmatter', () => {
      const content = `---
name: write-plan
description: Write a plan
runbook: write-plan
---

# Command content`;

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBe('write-plan');
    });

    it('returns undefined when no frontmatter', () => {
      const content = '# Just a heading\n\nSome content';

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBeUndefined();
    });

    it('returns undefined when no runbook field', () => {
      const content = `---
name: simple-command
description: No runbook
---

# Content`;

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBeUndefined();
    });

    it('handles CRLF line endings', () => {
      const content = '---\r\nname: test\r\nrunbook: test-runbook\r\n---\r\n# Content';

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBe('test-runbook');
    });
  });

  describe('execute', () => {
    it('returns empty for non-SlashCommandStart events', async () => {
      const input: HookInput = {
        hook_event_name: 'PostToolUse',
        cwd: '/test'
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns empty when no command name', async () => {
      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test'
      };

      const result = await execute(input);

      expect(result).toEqual({});
    });

    it('starts runbook when command has runbook in frontmatter', async () => {
      const commandContent = `---
name: write-plan
runbook: write-plan
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockExecFileSync.mockReturnValue(Buffer.from('Started runbook'));

      // Set plugin root for command discovery
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'rundown:write-plan'
      };

      const result = await execute(input);

      expect(result).toEqual({
        additionalContext: 'Started runbook: write-plan'
      });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rundown',
        ['run', 'write-plan'],
        expect.objectContaining({ cwd: '/test' })
      );

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('handles command without namespace', async () => {
      const commandContent = `---
runbook: my-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockExecFileSync.mockReturnValue(Buffer.from('Started runbook'));

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'my-command'
      };

      const result = await execute(input);

      expect(result).toEqual({
        additionalContext: 'Started runbook: my-runbook'
      });

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('gracefully handles exec failure', async () => {
      const commandContent = `---
runbook: broken-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockExecFileSync.mockImplementation(() => {
        throw new Error('Command failed');
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result).toEqual({});

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('returns empty when command file not found', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'nonexistent'
      };

      const result = await execute(input);

      expect(result).toEqual({});

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('rejects invalid runbook paths with traversal', async () => {
      const commandContent = `---
runbook: ../../../etc/passwd
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'malicious'
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockExecFileSync).not.toHaveBeenCalled();

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('rejects runbook paths with special characters', async () => {
      const commandContent = `---
runbook: test; rm -rf /
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'injection'
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockExecFileSync).not.toHaveBeenCalled();

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });
  });
});
