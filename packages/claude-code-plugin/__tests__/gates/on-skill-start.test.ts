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

describe('on-skill-start gate', () => {
  let originalPluginRoot: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
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
      mockRundown.mockReturnValue('Started runbook');
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test',
        skill: 'rundown:verify',
      };

      const result = await execute(input);

      expect(result).toEqual({
        additionalContext: 'Started runbook: verify.runbook.md',
      });
      expect(mockRundown).toHaveBeenCalledWith(['run', 'verify.runbook.md'], '/test');
    });
  });
});
