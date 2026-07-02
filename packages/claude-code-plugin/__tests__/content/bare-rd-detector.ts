import { fencedBlocksWithLang, inlineCodeSpans } from './markdown-scan-helpers.js';

/**
 * Fence info-string languages whose contents are structured serialization data
 * rather than shell command examples. A bare `rd` token inside these (e.g. a
 * YAML scalar `key: rd value` or a JSON string) is data, never an instruction
 * to run the collision-prone `rd` bin, so scanning them would raise false
 * positives. Explanatory (`text`), shell (`bash`/`sh`), untagged, and other
 * fences stay in scope because they carry real agent-facing command examples.
 */
const NON_COMMAND_FENCE_LANGS = new Set(['json', 'yaml', 'yml']);

/**
 * Find every bare `rd`/`rd <subcommand>` invocation in `markdown` — fenced
 * (with or without a trailing argument; a lone `rd` on its own line still
 * hits the oh-my-zsh `rd=rmdir` trap) and inline single-backtick prose spans
 * (e.g. "on every `rd` command", where the backticks quote only the bare
 * word). Structured-data fences (see {@link NON_COMMAND_FENCE_LANGS}) are
 * skipped. `rundown …` is the required collision-proof form (#459).
 */
export function bareRdCommandsInMarkdown(markdown: string): string[] {
  const commands: string[] = [];
  for (const { lang, content } of fencedBlocksWithLang(markdown)) {
    if (NON_COMMAND_FENCE_LANGS.has(lang)) continue;
    for (const rawLine of content.split(/\r?\n/)) {
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
