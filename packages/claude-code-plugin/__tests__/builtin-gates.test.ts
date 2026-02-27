// packages/claude-code-plugin/__tests__/builtin-gates.test.ts
import { executeBuiltinGate } from '../src/gate-loader.js';
import type { HookInput } from '../src/shared/index.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set CLAUDE_PLUGIN_ROOT for tests to point to plugin directory
// __dirname = packages/claude-code-plugin/__tests__, plugin root = packages/claude-code-plugin/ (1 level up)
process.env.CLAUDE_PLUGIN_ROOT = path.resolve(__dirname, '..');

describe('Built-in Gates', () => {
  describe('plugin-path', () => {
    test('logs plugin path when available', async () => {
      const input: HookInput = {
        hook_event_name: 'SessionStart',
        cwd: '/test',
      };

      const result = await executeBuiltinGate('plugin-path', input);
      // plugin-path gate should always continue
      expect(result.decision).toBeUndefined();
    });

    test('handles SubagentStop hook', async () => {
      const input: HookInput = {
        hook_event_name: 'SubagentStop',
        cwd: '/test',
        agent_type: 'test-agent',
      };

      const result = await executeBuiltinGate('plugin-path', input);
      expect(result.decision).toBeUndefined();
    });

    test('handles PostToolUse hook', async () => {
      const input: HookInput = {
        hook_event_name: 'PostToolUse',
        cwd: '/test',
        tool_name: 'Edit',
      };

      const result = await executeBuiltinGate('plugin-path', input);
      expect(result.decision).toBeUndefined();
      expect(result.continue).not.toBe(false);
    });

    test('handles UserPromptSubmit hook', async () => {
      const input: HookInput = {
        hook_event_name: 'UserPromptSubmit',
        cwd: '/test',
        prompt: 'test prompt',
      };

      const result = await executeBuiltinGate('plugin-path', input);
      expect(result.decision).toBeUndefined();
    });

    test('returns valid GateResult structure', async () => {
      const input: HookInput = {
        hook_event_name: 'SessionStart',
        cwd: '/test',
      };

      const result = await executeBuiltinGate('plugin-path', input);

      // Verify it's a valid GateResult
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });
  });

  describe('Built-in gate error handling', () => {
    test('throws error for nonexistent built-in gate', async () => {
      const input: HookInput = {
        hook_event_name: 'SessionStart',
        cwd: '/test',
      };

      await expect(executeBuiltinGate('nonexistent-gate', input)).rejects.toThrow(
        /Failed to load built-in gate nonexistent-gate/,
      );
    });

    test('throws error for invalid gate name format', async () => {
      const input: HookInput = {
        hook_event_name: 'SessionStart',
        cwd: '/test',
      };

      await expect(executeBuiltinGate('123-invalid', input)).rejects.toThrow(
        /Failed to load built-in gate/,
      );
    });

    test('handles gate names with multiple dashes', async () => {
      const input: HookInput = {
        hook_event_name: 'SessionStart',
        cwd: '/test',
      };

      // This should properly convert multi-dash names to camelCase
      // e.g., 'my-test-gate' -> 'myTestGate'
      await expect(executeBuiltinGate('my-test-gate', input)).rejects.toThrow(
        /Failed to load built-in gate/,
      );
    });
  });
});
