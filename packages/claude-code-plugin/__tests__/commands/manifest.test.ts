/**
 * Validates that command files reference skills that actually exist.
 * Prevents breakage when skills are renamed or deleted without updating commands.
 * Pattern: similar to __tests__/runbooks/validation.test.ts
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read and parse a JSON file, asserting the result is shaped like `T`.
 *
 * The `as T` cast is unchecked: no runtime validation is performed, so the
 * caller is trusted to supply a generic argument matching the file's actual
 * structure. Acceptable here because the inputs are repo-local fixtures.
 */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');
const commandsDir = path.join(pluginRoot, 'commands');
const skillsDir = path.join(pluginRoot, 'skills');

/** Matches `Skill(skill: "rundown:skill-name")` references in command content. */
const SKILL_REF_PATTERN = /Skill\(skill:\s*"rundown:([\w-]+)"\)/g;

describe('Command-Skill Wiring', () => {
  const commandFiles = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter((f) => f.endsWith('.md'))
    : [];

  if (commandFiles.length === 0) {
    it.skip('validates command files if any exist', () => {});
    return;
  }

  describe.each(commandFiles)('%s', (filename) => {
    const content = readFileSync(path.join(commandsDir, filename), 'utf-8');
    const refs = [...content.matchAll(SKILL_REF_PATTERN)].map((m) => m[1]);

    if (refs.length === 0) return;

    it.each(refs)('skill "%s" exists', (skillName) => {
      const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
    });
  });
});

describe('Plugin manifest surface', () => {
  const pluginJsonPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const packageJsonPath = path.join(pluginRoot, 'package.json');
  const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json');

  it('wires Claude hooks to the built plugin CLI entrypoint', () => {
    const hooksManifest = readJson<{
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
      >;
    }>(hooksJsonPath);

    // The PreToolUse matcher pins delegation entrypoints (Agent|Task); the
    // Bash-guard matcher is owned by issue #470 and is intentionally absent here.
    expect(Object.keys(hooksManifest.hooks).sort()).toEqual(['PreToolUse', 'SubagentStop']);
    expect(hooksManifest.hooks.PreToolUse).toEqual([
      {
        matcher: 'Agent|Task',
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"',
          },
        ],
      },
    ]);
    expect(hooksManifest.hooks.SubagentStop).toEqual([
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"',
          },
        ],
      },
    ]);
  });

  it('keeps .claude-plugin/plugin.json aligned with package metadata', () => {
    const pluginJson = readJson<{
      name: string;
      version: string;
      description: string;
      author: { name: string; email: string };
      repository: string;
    }>(pluginJsonPath);
    const packageJson = readJson<{
      name: string;
      version: string;
      description: string;
      author: string;
      repository: { url: string };
    }>(packageJsonPath);

    expect(pluginJson.name).toBe('rundown');
    expect(pluginJson.version).toBe(packageJson.version);
    expect(pluginJson.description).toBe(packageJson.description);
    expect(pluginJson.author.name).toBe(packageJson.author);
    expect(pluginJson.author.email).toBe('toby@rundown.org');
    expect(packageJson.repository.url).toContain('github.com/rundown-org/rundown');
    expect(pluginJson.repository).toBe('https://github.com/rundown-org/rundown');
  });

  it('publishes every required plugin surface through package.json files', () => {
    const packageJson = readJson<{
      files: string[];
      main: string;
      types: string;
      bin: Record<string, string>;
      exports: Record<string, unknown>;
    }>(packageJsonPath);

    expect(packageJson.main).toBe('dist/cli.js');
    expect(packageJson.types).toBe('dist/index.d.ts');
    expect(packageJson.bin).toEqual({
      rdpath: 'dist/rdpath.js',
      rdx: 'dist/rdx.js',
    });
    // Pass keys as single-element arrays so Jest treats '.' / './cli' as literal
    // keys instead of dot-delimited property paths.
    expect(packageJson.exports).toHaveProperty(['.']);
    expect(packageJson.exports).toHaveProperty(['./cli']);

    const requiredPublishedEntries = [
      'dist',
      'schemas',
      '.claude-plugin',
      'examples',
      'hooks',
      'runbooks',
      'scripts',
      'skills',
      'templates',
      'README.md',
    ];
    expect(packageJson.files.sort()).toEqual(requiredPublishedEntries.sort());

    for (const entry of packageJson.files) {
      const entryPath = path.join(pluginRoot, entry);
      expect(existsSync(entryPath)).toBe(true);
      const stat = statSync(entryPath);
      expect(stat.isDirectory() || stat.isFile()).toBe(true);
    }
  });
});
