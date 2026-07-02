import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fencedBlocks, inlineCodeSpans, markdownFiles } from './markdown-scan-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');
const repoRoot = path.join(pluginRoot, '..', '..');

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
  // Prose also refers to "the `rd` command" without a subcommand inside the
  // backticks (e.g. "on every `rd` command") — fenced-block scanning alone
  // misses this; inline spans catch it.
  for (const span of inlineCodeSpans(markdown)) {
    const trimmed = span.trim();
    if (/^rd(\s+\S.*)?$/.test(trimmed)) {
      matches.push({ file: relative, command: `\`${trimmed}\`` });
    }
  }
  return matches;
}

describe('plugin skills and runbooks never instruct the bare `rd` command (#459)', () => {
  it('uses `rundown`, never `rd`, in fenced command examples and inline prose', () => {
    const roots = [
      path.join(pluginRoot, 'skills'),
      path.join(pluginRoot, 'runbooks'),
      path.join(pluginRoot, 'docs'),
      path.join(pluginRoot, 'examples'),
      path.join(repoRoot, 'docs', 'implement', 'claude-code-plugin'),
    ];
    // docs/plans/ holds write-once historical implementation plans (same
    // category as docs/superpowers/plans/) — never edited, so never scanned.
    const violations = roots.flatMap((root) =>
      markdownFiles(root)
        .filter((file) => !file.replaceAll('\\', '/').includes('/docs/plans/'))
        .flatMap(bareRdCommands),
    );

    expect(violations).toEqual([]);
  });
});
