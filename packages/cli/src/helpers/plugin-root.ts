import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Cached result (undefined = not yet checked, null = not found, string = found) */
let cached: string | null | undefined;

/**
 * Resolve the plugin root directory.
 *
 * Priority:
 * 1. `CLAUDE_PLUGIN_ROOT` environment variable (set by Claude Code)
 * 2. `CODEX_PLUGIN_ROOT` environment variable (set by Codex plugin launchers)
 * 3. `RUNDOWN_PLUGIN_ROOT` environment variable (neutral host-provided plugin root)
 * 4. Sibling package discovery — `@rundown-org/claude-code-plugin` installed alongside the CLI
 *
 * The sibling discovery works because both `@rundown-org/cli` and
 * `@rundown-org/claude-code-plugin` are installed in the same global
 * `node_modules`. From `dist/helpers/plugin-root.js` we walk up to
 * the `@rundown-org` scope directory and check for the sibling.
 *
 * @returns Absolute path to the plugin root directory, or null if not found
 */
export function getPluginRoot(): string | null {
  const claudeRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (claudeRoot) return claudeRoot;

  const codexRoot = process.env.CODEX_PLUGIN_ROOT;
  if (codexRoot) return codexRoot;

  const rundownRoot = process.env.RUNDOWN_PLUGIN_ROOT;
  if (rundownRoot) return rundownRoot;

  // Return cached sibling discovery result
  if (cached !== undefined) return cached;

  cached = discoverSiblingPlugin();
  return cached;
}

/**
 * Reset the cached sibling discovery result.
 *
 * @internal
 */
export function _resetPluginRootCache(): void {
  cached = undefined;
}

function discoverSiblingPlugin(): string | null {
  // dist/helpers/ → dist/ → cli/ → @rundown-org/
  const scopeDir = join(__dirname, '..', '..', '..');
  const pluginDir = join(scopeDir, 'claude-code-plugin');

  // Verify it's actually the plugin (has runbooks/ directory)
  if (existsSync(join(pluginDir, 'runbooks'))) {
    return pluginDir;
  }

  return null;
}
