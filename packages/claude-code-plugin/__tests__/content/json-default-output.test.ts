import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');

interface Match {
  file: string;
  command: string;
  reason: string;
}

const allowlistedTextCommands = new Set<string>([
  // Human/debugging examples may be added here as "relative/path.md :: command text".
  // The "Structured Output" section documents that JSON is the default and that
  // `--text` yields human-readable output; such an example would demonstrate that
  // flag for humans and would not be an agent-driven command.
]);

function markdownFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...markdownFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

function agentFacingTextCommands(filePath: string): Match[] {
  // Normalize to forward slashes so allowlist keys (which use '/') match on
  // Windows, where path.relative() returns backslash-separated paths.
  const relative = path.relative(pluginRoot, filePath).replaceAll('\\', '/');
  const markdown = readFileSync(filePath, 'utf-8');
  const matches: Match[] = [];
  for (const block of fencedBlocks(markdown)) {
    const commands = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /(^|\s)(rd|rundown)\s+\S+/.test(line))
      .filter((line) => line.includes('--text'));

    for (const command of commands) {
      const key = `${relative} :: ${command}`;
      if (!allowlistedTextCommands.has(key)) {
        matches.push({
          file: relative,
          command,
          reason:
            'agent-authored rd/rundown command uses --text; JSON output is the default agent contract',
        });
      }
    }
  }
  return matches;
}

describe('plugin-authored skills and runbooks use JSON-default rd commands', () => {
  it('does not use --text for agent-facing rd/rundown commands', () => {
    const roots = [path.join(pluginRoot, 'skills'), path.join(pluginRoot, 'runbooks')];
    const violations = roots.flatMap((root) =>
      markdownFiles(root).flatMap(agentFacingTextCommands),
    );

    expect(violations).toEqual([]);
  });
});
