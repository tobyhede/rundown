import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');

interface Match {
  file: string;
  command: string;
}

function markdownFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    if (statSync(fullPath).isDirectory()) {
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

function bareRdCommands(filePath: string): Match[] {
  const relative = path.relative(pluginRoot, filePath).replaceAll('\\', '/');
  const markdown = readFileSync(filePath, 'utf-8');
  const matches: Match[] = [];
  for (const block of fencedBlocks(markdown)) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      // A bare `rd <subcommand>` invocation — the oh-my-zsh `rd=rmdir` trap.
      // `rundown …` is the required collision-proof form (#459).
      if (/(^|[`\s])rd\s+\S+/.test(line)) {
        matches.push({ file: relative, command: line });
      }
    }
  }
  return matches;
}

describe('plugin skills and runbooks never instruct the bare `rd` command (#459)', () => {
  it('uses `rundown`, never `rd`, in fenced command examples', () => {
    const roots = [path.join(pluginRoot, 'skills'), path.join(pluginRoot, 'runbooks')];
    const violations = roots.flatMap((root) => markdownFiles(root).flatMap(bareRdCommands));

    expect(violations).toEqual([]);
  });
});
