import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const REPO_ROOT = process.cwd().endsWith(join('packages', 'cli'))
  ? join(process.cwd(), '..', '..')
  : process.cwd();

const FRONTEND_SOURCE_ROOTS = [
  'packages/cli/src',
  'packages/mcp/src',
  'packages/claude-code-plugin/src',
] as const;

const FORBIDDEN_TEMPLATE_API_NAMES = [
  'tokenizeTemplate',
  'parseTemplateExpression',
  'parseOutputExpression',
] as const;

function listTypeScriptFiles(root: string): string[] {
  const absoluteRoot = isAbsolute(root) ? root : join(REPO_ROOT, root);
  return readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absoluteRoot, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('front-end package template API boundary', () => {
  it('keeps CLI, MCP, and plugin packages from importing parser template syntax APIs', () => {
    const offenders = FRONTEND_SOURCE_ROOTS.flatMap((root) =>
      listTypeScriptFiles(root).flatMap((file) => {
        const source = readFileSync(file, 'utf8');
        if (!source.includes('@rundown-org/parser')) return [];
        return FORBIDDEN_TEMPLATE_API_NAMES.filter((name) => source.includes(name)).map(
          (name) => `${file}: ${name}`,
        );
      }),
    );

    expect(offenders).toEqual([]);
  });
});
