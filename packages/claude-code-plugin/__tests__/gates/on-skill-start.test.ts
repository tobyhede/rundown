// packages/claude-code-plugin/__tests__/gates/on-skill-start.test.ts
import { jest, expect, describe, it, beforeEach, afterEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockRundown = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('../../src/workflow/hooks/rundown.js', () => ({
  rundown: mockRundown,
}));

const actualFs = await import('node:fs');
jest.unstable_mockModule('node:fs', () => ({
  ...actualFs,
  readFileSync: mockReadFileSync,
}));

const { execute } = await import('../../src/gates/on-skill-start.js');
const { parseRunbookFromFrontmatter } = await import('../../src/shared/frontmatter.js');

/**
 * Configure mockReadFileSync to return content only when the path
 * contains the expected skill name, throwing ENOENT for all other paths.
 */
function mockReadForSkill(skillName: string, content: string): void {
  mockReadFileSync.mockImplementation((filePath: string) => {
    if (filePath.includes(`/skills/${skillName}/SKILL.md`)) {
      return content;
    }
    const err = new Error(
      `ENOENT: no such file or directory, open '${filePath}'`,
    ) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

describe('on-skill-start gate', () => {
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
name: verify
description: Verify something
runbook: verify.runbook.md
---

# Skill content`;

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBe('verify.runbook.md');
    });

    it('returns undefined when no frontmatter', () => {
      const content = '# Just a heading\n\nSome content';

      const result = parseRunbookFromFrontmatter(content);

      expect(result).toBeUndefined();
    });

    it('returns undefined when no runbook field', () => {
      const content = `---
name: simple-skill
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
    it('returns empty for non-SkillStart events', async () => {
      const input: HookInput = {
        hook_event_name: 'PostToolUse',
        cwd: '/test',
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockRundown).not.toHaveBeenCalled();
    });

    it('returns empty when no skill name', async () => {
      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test',
      };

      const result = await execute(input);

      expect(result).toEqual({});
    });

    it('starts runbook when skill has runbook in frontmatter', async () => {
      const skillContent = `---
name: verify
runbook: verify.runbook.md
---
# Content`;

      mockReadFileSync.mockReturnValue(skillContent);
      mockRundown.mockReturnValue('Step 1 of 3');

      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test',
        skill: 'rundown:verify',
      };

      const result = await execute(input);

      expect(result.additionalContext).toContain('RUNBOOK ACTIVE: verify.runbook.md');
      expect(result.additionalContext).toContain('Skill(skill: "rundown:running-runbooks")');
      expect(result.additionalContext).toContain('Step 1 of 3');
      expect(mockRundown).toHaveBeenCalledWith(['run', 'verify.runbook.md'], '/test');
    });

    describe('error handling', () => {
      const skillContent = `---
name: test-skill
runbook: test-runbook
---
# Content`;

      it('formats error with recovery instructions on exec failure', async () => {
        mockReadForSkill('test-skill', skillContent);
        mockRundown.mockImplementation(() => {
          const error = new Error('Command failed');
          (error as any).stdout = 'Runbook not found: test-runbook';
          throw error;
        });

        const input: HookInput = {
          hook_event_name: 'SkillStart',
          cwd: '/test',
          skill: 'rundown:test-skill',
        };

        const result = await execute(input);

        expect(result.additionalContext).toContain('RUNBOOK ERROR: test-runbook');
        expect(result.additionalContext).toContain('Manual Recovery');
        expect(result.additionalContext).toContain('rd run test-runbook');
      });

      it('prioritizes stdout over stderr when both present in error', async () => {
        mockReadForSkill('test-skill', skillContent);
        mockRundown.mockImplementation(() => {
          const error = new Error('Command failed');
          (error as any).stdout = 'stdout output';
          (error as any).stderr = 'stderr output';
          throw error;
        });

        const input: HookInput = {
          hook_event_name: 'SkillStart',
          cwd: '/test',
          skill: 'rundown:test-skill',
        };

        const result = await execute(input);

        expect(result.additionalContext).toContain('stdout output');
        expect(result.additionalContext).not.toContain('stderr output');
      });

      it('uses stderr when stdout not available in error', async () => {
        mockReadForSkill('test-skill', skillContent);
        mockRundown.mockImplementation(() => {
          const error = new Error('Command failed');
          (error as any).stderr = 'Permission denied';
          throw error;
        });

        const input: HookInput = {
          hook_event_name: 'SkillStart',
          cwd: '/test',
          skill: 'rundown:test-skill',
        };

        const result = await execute(input);

        expect(result.additionalContext).toContain('Permission denied');
      });

      it('uses error message when stdout/stderr not available', async () => {
        mockReadForSkill('test-skill', skillContent);
        mockRundown.mockImplementation(() => {
          throw new Error('ENOENT: file not found');
        });

        const input: HookInput = {
          hook_event_name: 'SkillStart',
          cwd: '/test',
          skill: 'rundown:test-skill',
        };

        const result = await execute(input);

        expect(result.additionalContext).toContain('ENOENT: file not found');
      });

      it('returns Unknown error when error has no useful properties', async () => {
        mockReadForSkill('test-skill', skillContent);
        mockRundown.mockImplementation(() => {
          throw { code: 'ERR' };
        });

        const input: HookInput = {
          hook_event_name: 'SkillStart',
          cwd: '/test',
          skill: 'rundown:test-skill',
        };

        const result = await execute(input);

        expect(result.additionalContext).toContain('Unknown error');
      });
    });
  });
});
