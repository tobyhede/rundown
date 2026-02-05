// packages/claude-code-plugin/__tests__/gates/on-skill-start.test.ts
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
  await import('../../src/gates/on-skill-start.js');

describe('on-skill-start gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });

  describe('execute', () => {
    it('returns empty for non-SkillStart events', async () => {
      const input: HookInput = {
        hook_event_name: 'PostToolUse',
        cwd: '/test'
      };

      const result = await execute(input);

      expect(result).toEqual({});
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('returns empty when no skill name', async () => {
      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test'
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
      mockExecFileSync.mockReturnValue(Buffer.from('Started runbook'));

      // Set plugin root for skill discovery
      const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;
      process.env.CLAUDE_PLUGIN_ROOT = '/plugin';

      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test',
        skill: 'rundown:verify'
      };

      const result = await execute(input);

      expect(result).toEqual({
        additionalContext: 'Started runbook: verify.runbook.md'
      });
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'rundown',
        ['run', 'verify.runbook.md'],
        expect.objectContaining({ cwd: '/test' })
      );

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });
  });
});