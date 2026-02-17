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
        agent_name: 'test-agent',
      };

      const result = await executeBuiltinGate('plugin-path', input);
      expect(result.decision).toBeUndefined();
    });
  });
});
