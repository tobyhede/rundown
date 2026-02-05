// packages/claude-code-plugin/__tests__/gates/on-command-start.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockRundown = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/rundown.js', () => ({
  rundown: mockRundown
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
      expect(mockRundown).not.toHaveBeenCalled();
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
      mockRundown.mockReturnValue('File: write-plan.md\nAction: START\n\n## 1. First Step');

      // Set plugin root for command discovery
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'rundown:write-plan'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: write-plan');
      expect(result.additionalContext).toContain('rd pass');
      expect(result.additionalContext).toContain('rd fail');
      expect(result.additionalContext).toContain('rd status');
      expect(mockRundown).toHaveBeenCalledWith(['run', 'write-plan'], '/test');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('handles command without namespace', async () => {
      const commandContent = `---
runbook: my-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockReturnValue('Started runbook');

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'my-command'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: my-runbook');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('formats error with recovery instructions on exec failure', async () => {
      const commandContent = `---
runbook: broken-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockImplementation(() => {
        const error = new Error('Command failed');
        (error as any).stdout = 'Runbook not found: broken-runbook';
        throw error;
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ERROR: broken-runbook');
      expect(result.additionalContext).toContain('Manual Recovery');
      expect(result.additionalContext).toContain('rd run broken-runbook');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('uses stderr when stdout not available in error', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockImplementation(() => {
        const error = new Error('Command failed');
        (error as any).stderr = 'Permission denied';
        throw error;
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('Permission denied');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('uses error message when stdout/stderr not available', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockImplementation(() => {
        throw new Error('ENOENT: file not found');
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('ENOENT: file not found');

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
      expect(mockRundown).not.toHaveBeenCalled();

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
      expect(mockRundown).not.toHaveBeenCalled();

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });
  });

  describe('output formatting', () => {
    it('formats successful start with instructions', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockReturnValue('File: test.md\nAction: START\n\n## 1. First Step\nDo something');

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: test-runbook');
      expect(result.additionalContext).toContain('rd pass');
      expect(result.additionalContext).toContain('rd fail');
      expect(result.additionalContext).toContain('rd status');
      expect(result.additionalContext).toContain('rd goto');
      expect(result.additionalContext).toContain('IMPORTANT');
      expect(result.additionalContext).toContain('Current State');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });

    it('formats error with recovery instructions', async () => {
      const commandContent = `---
runbook: bad-runbook
---
# Content`;

      mockReadFileSync.mockReturnValue(commandContent);
      mockRundown.mockImplementation(() => {
        const e = new Error('fail');
        (e as any).stdout = 'Runbook not found';
        throw e;
      });

      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd'
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ERROR: bad-runbook');
      expect(result.additionalContext).toContain('Manual Recovery');
      expect(result.additionalContext).toContain('rd run bad-runbook');

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });
  });
});
