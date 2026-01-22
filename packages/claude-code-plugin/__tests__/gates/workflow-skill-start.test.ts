// packages/claude-code-plugin/__tests__/gates/workflow-skill-start.test.ts
import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import type { HookInput } from '../../src/shared/index.js';

const mockExecSync = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync
}));

jest.unstable_mockModule('fs', () => ({
  readFileSync: mockReadFileSync
}));

const { execute, parseWorkflowFromFrontmatter } =
  await import('../../src/gates/workflow-skill-start.js');

describe('workflow-skill-start gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseWorkflowFromFrontmatter', () => {
    it('extracts workflow field from frontmatter', () => {
      const content = `---
name: verify
description: Verify something
workflow: verify.runbook.md
---

# Skill content`;

      const result = parseWorkflowFromFrontmatter(content);

      expect(result).toBe('verify.runbook.md');
    });

    it('returns undefined when no frontmatter', () => {
      const content = '# Just a heading\n\nSome content';

      const result = parseWorkflowFromFrontmatter(content);

      expect(result).toBeUndefined();
    });

    it('returns undefined when no workflow field', () => {
      const content = `---
name: simple-skill
description: No workflow
---

# Content`;

      const result = parseWorkflowFromFrontmatter(content);

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
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('returns empty when no skill name', async () => {
      const input: HookInput = {
        hook_event_name: 'SkillStart',
        cwd: '/test'
      };

      const result = await execute(input);

      expect(result).toEqual({});
    });

    it('starts workflow when skill has workflow in frontmatter', async () => {
      const skillContent = `---
name: verify
workflow: verify.runbook.md
---
# Content`;

      mockReadFileSync.mockReturnValue(skillContent);
      mockExecSync.mockReturnValue(Buffer.from('Started workflow'));

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
        additionalContext: 'Started workflow: verify.runbook.md'
      });
      expect(mockExecSync).toHaveBeenCalledWith(
        'rundown run verify.runbook.md',
        expect.objectContaining({ cwd: '/test' })
      );

      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    });
  });
});