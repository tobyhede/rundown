import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fencedBlocks, markdownFiles } from './markdown-scan-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');

interface Match {
  file: string;
  command: string;
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
