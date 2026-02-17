// gates/plugin-path.ts
import type { HookInput, GateResult } from '../shared/index.js';
import * as path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Plugin Path Injection Gate
 *
 * Injects CLAUDE_PLUGIN_ROOT as context for agents to resolve file references.
 * This gate provides the absolute path to the plugin root directory, enabling
 * agents to properly resolve @${CLAUDE_PLUGIN_ROOT}/... file references.
 *
 * Typical usage: SubagentStop hook to inject path context when agents complete.
 */

export function execute(_input: HookInput): Promise<GateResult> {
  // Determine plugin root:
  // 1. Use CLAUDE_PLUGIN_ROOT if set and non-empty (standard Claude Code environment)
  // 2. Otherwise compute from this script's location
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const pluginRoot = envRoot && envRoot.trim().length > 0 ? envRoot : computePluginRoot();

  const contextMessage = `## Plugin Path Context

For this session:
\`\`\`
CLAUDE_PLUGIN_ROOT=${pluginRoot}
\`\`\`

When you see file references like \`@\${CLAUDE_PLUGIN_ROOT}/skills/...\`, resolve them using the path above.`;

  return Promise.resolve({
    additionalContext: contextMessage,
  });
}

/**
 * Compute plugin root from this file's location
 * This file is at: packages/claude-code-plugin/src/gates/plugin-path.ts
 * Plugin root is: packages/claude-code-plugin/
 *
 * After compilation, this is at: packages/claude-code-plugin/dist/gates/
 * We go up 2 levels: gates/ -> dist/ -> plugin root
 */
function computePluginRoot(): string {
  // __dirname is at: packages/claude-code-plugin/dist/gates/
  // (after compilation from src/ to dist/)

  // Go up 2 directories from dist/gates/
  let pluginRoot = path.dirname(__dirname); // dist/
  pluginRoot = path.dirname(pluginRoot); // plugin root

  return pluginRoot;
}
