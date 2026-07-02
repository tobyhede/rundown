import { fencedBlocks, inlineCodeSpans } from './markdown-scan-helpers.js';

/**
 * Find every bare `rd`/`rd <subcommand>` invocation in `markdown` — fenced
 * (with or without a trailing argument; a lone `rd` on its own line still
 * hits the oh-my-zsh `rd=rmdir` trap) and inline single-backtick prose spans
 * (e.g. "on every `rd` command", where the backticks quote only the bare
 * word). `rundown …` is the required collision-proof form (#459).
 */
export function bareRdCommandsInMarkdown(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of fencedBlocks(markdown)) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/(^|[`\s])rd(\s+\S+|$|[`\s])/.test(line)) {
        commands.push(line);
      }
    }
  }
  for (const span of inlineCodeSpans(markdown)) {
    const trimmed = span.trim();
    if (/^rd(\s+\S.*)?$/.test(trimmed)) {
      commands.push(`\`${trimmed}\``);
    }
  }
  return commands;
}
