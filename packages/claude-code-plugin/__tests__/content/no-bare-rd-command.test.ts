import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareRdCommandsInMarkdown } from './bare-rd-detector.js';
import { markdownFiles } from './markdown-scan-helpers.js';

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
  return bareRdCommandsInMarkdown(markdown).map((command) => ({ file: relative, command }));
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

describe('bareRdCommandsInMarkdown', () => {
  it('flags a bare `rd` with a subcommand inside a fenced block', () => {
    expect(bareRdCommandsInMarkdown('```bash\nrd status\n```\n')).toEqual(['rd status']);
  });

  it('flags a bare `rd` with no subcommand inside a fenced block', () => {
    // A fenced example showing just `rd` (no arguments) still hits the
    // oh-my-zsh `rd=rmdir` trap — the trailing-argument-only regex missed it.
    expect(bareRdCommandsInMarkdown('```bash\nrd\n```\n')).toEqual(['rd']);
  });

  it('flags a bare `rd` command noun quoted alone in inline prose', () => {
    expect(bareRdCommandsInMarkdown('Run every `rd` command carefully.')).toEqual(['`rd`']);
  });

  it('does not flag `rd` inside a structured-data fence (yaml/json)', () => {
    // A YAML scalar or JSON value that happens to contain `rd` is data, not a
    // shell command example, so it must not raise a false positive (#459).
    expect(bareRdCommandsInMarkdown('```yaml\ncommand: rd value\n```\n')).toEqual([]);
    expect(bareRdCommandsInMarkdown('```json\n{ "note": "rd status" }\n```\n')).toEqual([]);
  });

  it('still flags a bare `rd` shell fence alongside a data fence', () => {
    const markdown = [
      '```yaml',
      'key: rd value',
      '```',
      '',
      '```bash',
      'rd status',
      '```',
      '',
    ].join('\n');
    expect(bareRdCommandsInMarkdown(markdown)).toEqual(['rd status']);
  });

  it('does not flag rdpath, rdx, rd:// URIs, or .rd-<ContextId>/ paths', () => {
    const markdown = [
      '```bash',
      'rdpath',
      'rdx {{ path X }} --check',
      'rd://artifacts/ctx/run/key',
      '.rd-<ContextId>/manifest.jsonl',
      'rundown status',
      '```',
      '',
    ].join('\n');
    expect(bareRdCommandsInMarkdown(markdown)).toEqual([]);
  });
});
