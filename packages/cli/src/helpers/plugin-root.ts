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
 * 1. `CLAUDE_PLUGIN_ROOT` environment variable (set by Claude Code during hook dispatch)
 * 2. Sibling package discovery — `@rundown-org/claude-code-plugin` installed alongside the CLI
 *
 * The sibling discovery works because both `@rundown-org/cli` and
 * `@rundown-org/claude-code-plugin` are installed in the same global
 * `node_modules`. From `dist/helpers/plugin-root.js` we walk up to
 * the `@rundown-org` scope directory and check for the sibling.
 *
 * @returns Absolute path to the plugin root directory, or null if not found
 */
export function getPluginRoot(): string | null {
  // Environment variable takes precedence (always re-read, may change)
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot) return envRoot;

  // Return cached sibling discovery result
  if (cached !== undefined) return cached;

  cached = discoverSiblingPlugin();
  return cached;
}

/**
 * Discover the plugin as a sibling package in the same node_modules scope.
 *
 * Path from this file:
 *   node_modules/@rundown-org/cli/dist/helpers/plugin-root.js
 *   → up 4 levels → node_modules/@rundown-org/
 *   → claude-code-plugin/
 *
 * @returns Absolute path to the plugin root, or null if not found
 */
/**
 * Reset the cached sibling discovery result.
 * @internal Test-only — not part of the public API.
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
