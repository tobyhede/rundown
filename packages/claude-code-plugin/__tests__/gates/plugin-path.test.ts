// __tests__/gates/plugin-path.test.ts
import { jest } from '@jest/globals';
import { execute } from '../../src/gates/plugin-path.js';
import { createMockHookInput } from '../helpers/test-utils.js';

describe('plugin-path gate', () => {
  const originalEnv = process.env.CLAUDE_PLUGIN_ROOT;

  afterEach(() => {
    // Restore original env
    if (originalEnv !== undefined) {
      process.env.CLAUDE_PLUGIN_ROOT = originalEnv;
    } else {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    }
  });

  describe('execute', () => {
    it('returns context with plugin path from environment', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/path/to/plugin';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('CLAUDE_PLUGIN_ROOT=/path/to/plugin');
      expect(result.additionalContext).toContain('Plugin Path Context');
    });

    it('computes plugin root when env var not set', async () => {
      delete process.env.CLAUDE_PLUGIN_ROOT;

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('CLAUDE_PLUGIN_ROOT=');
      // Should contain a valid path (computed from file location)
      expect(result.additionalContext).toMatch(/CLAUDE_PLUGIN_ROOT=.+/);
    });

    it('returns promise', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/test/path';

      const input = createMockHookInput('SubagentStop');
      const result = execute(input);

      expect(result).toBeInstanceOf(Promise);
      await result; // Ensure it resolves
    });

    it('includes usage instructions in context', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/plugins/rundown';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('file references');
      expect(result.additionalContext).toContain('@${CLAUDE_PLUGIN_ROOT}');
    });
  });

  describe('context message format', () => {
    it('uses markdown formatting', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/test/plugin';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('## Plugin Path Context');
      expect(result.additionalContext).toContain('```');
    });

    it('provides guidance for path resolution', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/test/plugin';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('resolve');
      expect(result.additionalContext).toContain('skills');
    });
  });

  describe('different hook events', () => {
    it('works with any hook event', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/test';

      const events = ['SubagentStop', 'PostToolUse', 'SkillEnd'];

      for (const eventName of events) {
        const input = createMockHookInput(eventName);
        const result = await execute(input);
        expect(result.additionalContext).toBeDefined();
      }
    });
  });

  describe('path handling', () => {
    it('handles paths with spaces', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/path with spaces/plugin';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('/path with spaces/plugin');
    });

    it('handles absolute paths', async () => {
      process.env.CLAUDE_PLUGIN_ROOT = '/Users/test/.claude/plugins/rundown';

      const input = createMockHookInput('SubagentStop');
      const result = await execute(input);

      expect(result.additionalContext).toContain('/Users/test/.claude/plugins/rundown');
    });
  });
});
