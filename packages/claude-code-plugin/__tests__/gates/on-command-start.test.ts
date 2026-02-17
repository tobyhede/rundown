// packages/claude-code-plugin/__tests__/gates/on-command-start.test.ts
import { jest, expect, describe, it, beforeEach, afterEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockRundown = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/rundown.js', () => ({
  rundown: mockRundown,
}));

jest.unstable_mockModule('node:fs', () => ({
  readFileSync: mockReadFileSync,
}));

const { execute } = await import('../../src/gates/on-command-start.js');
const { parseRunbookFromFrontmatter } = await import('../../src/shared/frontmatter.js');

/**
 * Configure mockReadFileSync to return content only when the path
 * contains the expected command name, throwing ENOENT for all other paths.
 * This ensures tests verify the correct file path is constructed.
 */
function mockReadForCommand(commandName: string, content: string): void {
  mockReadFileSync.mockImplementation((filePath: string) => {
    if (filePath.includes(`/${commandName}.md`)) {
      return content;
    }
    const err = new Error(
      `ENOENT: no such file or directory, open '${filePath}'`,
    ) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

describe('on-command-start gate', () => {
  let originalPluginRoot: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = '/plugin';
  });

  afterEach(() => {
    if (originalPluginRoot !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalPluginRoot;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
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
        cwd: '/test',
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockRundown).not.toHaveBeenCalled();
    });

    it('returns empty when no command name', async () => {
      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
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

      mockReadForCommand('write-plan', commandContent);
      mockRundown.mockReturnValue('File: write-plan.md\nAction: START\n\n## 1. First Step');

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'rundown:write-plan',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: write-plan');
      expect(result.additionalContext).toContain('rd pass');
      expect(result.additionalContext).toContain('rd fail');
      expect(result.additionalContext).toContain('rd status');
      expect(result.additionalContext).toContain('rd goto');
      expect(result.additionalContext).toContain('IMPORTANT');
      expect(result.additionalContext).toContain('Current State');
      expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('write-plan'), 'utf8');
      expect(mockRundown).toHaveBeenCalledWith(['run', 'write-plan'], '/test');
    });

    it('handles command without namespace', async () => {
      const commandContent = `---
runbook: my-runbook
---
# Content`;

      mockReadForCommand('my-command', commandContent);
      mockRundown.mockReturnValue('Started runbook');

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'my-command',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: my-runbook');
    });

    it('formats error with recovery instructions on exec failure', async () => {
      const commandContent = `---
runbook: broken-runbook
---
# Content`;

      mockReadForCommand('test-cmd', commandContent);
      mockRundown.mockImplementation(() => {
        const error = new Error('Command failed');
        (error as any).stdout = 'Runbook not found: broken-runbook';
        throw error;
      });

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ERROR: broken-runbook');
      expect(result.additionalContext).toContain('Manual Recovery');
      expect(result.additionalContext).toContain('rd run broken-runbook');
    });

    it('prioritizes stdout over stderr when both present in error', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadForCommand('test-cmd', commandContent);
      mockRundown.mockImplementation(() => {
        const error = new Error('Command failed');
        (error as any).stdout = 'stdout output';
        (error as any).stderr = 'stderr output';
        throw error;
      });

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('stdout output');
      expect(result.additionalContext).not.toContain('stderr output');
    });

    it('uses stderr when stdout not available in error', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadForCommand('test-cmd', commandContent);
      mockRundown.mockImplementation(() => {
        const error = new Error('Command failed');
        (error as any).stderr = 'Permission denied';
        throw error;
      });

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('Permission denied');
    });

    it('uses error message when stdout/stderr not available', async () => {
      const commandContent = `---
runbook: test-runbook
---
# Content`;

      mockReadForCommand('test-cmd', commandContent);
      mockRundown.mockImplementation(() => {
        throw new Error('ENOENT: file not found');
      });

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'test-cmd',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('ENOENT: file not found');
    });

    it('returns empty when command file not found', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('File not found');
      });

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'nonexistent',
      };

      const result = await execute(input);

      expect(result).toEqual({});
    });

    it('rejects invalid runbook paths with traversal', async () => {
      const commandContent = `---
runbook: ../../../etc/passwd
---
# Content`;

      mockReadForCommand('malicious', commandContent);

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'malicious',
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockRundown).not.toHaveBeenCalled();
    });

    it('rejects runbook paths with special characters', async () => {
      const commandContent = `---
runbook: test; rm -rf /
---
# Content`;

      mockReadForCommand('injection', commandContent);

      const input: HookInput = {
        hook_event_name: 'SlashCommandStart',
        cwd: '/test',
        command: 'injection',
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockRundown).not.toHaveBeenCalled();
    });
  });
});
