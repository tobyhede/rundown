import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Recursively collect every Markdown file under a directory.
 *
 * @param root - Absolute path to the directory to walk
 * @returns Absolute paths of every `.md` file found under `root`, including
 *   subdirectories
 */
export function markdownFiles(root: string): string[] {
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

interface FenceScan {
  /** Fenced block contents, in document order. */
  blocks: string[];
  /** `markdown` with every fenced block (including its delimiters) removed. */
  withoutFences: string;
}

/**
 * Line-based fence scanner. A closing fence must use the same delimiter
 * character as its opener and be at least as long (CommonMark section 4.5): a naive
 * "any run of 3+ backticks closes the fence" regex desyncs on a longer outer
 * fence wrapping a shorter inner fence (e.g. a 4-backtick fence wrapping a
 * worked example that itself contains a 3-backtick fence, as used in
 * writing-runbooks/house-style.md) — the inner fence's opening backticks get
 * mistaken for the outer fence's close, dropping content and shifting every
 * later block boundary. Fence markers may be indented (list items).
 */
function scanFences(markdown: string): FenceScan {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  const outsideLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = /^\s*(`{3,})[^`\n]*$/.exec(lines[i]);
    if (!openMatch) {
      outsideLines.push(lines[i]);
      i++;
      continue;
    }
    const fenceLength = String(openMatch[1].length);
    const closePattern = new RegExp(`^\\s*\`{${fenceLength},}\\s*$`);
    const contentLines: string[] = [];
    i++;
    while (i < lines.length && !closePattern.test(lines[i])) {
      contentLines.push(lines[i]);
      i++;
    }
    blocks.push(`${contentLines.join('\n')}\n`);
    if (i < lines.length) i++; // consume the closing fence line
  }
  return { blocks, withoutFences: outsideLines.join('\n') };
}

/**
 * Extract the contents of every fenced (```) code block in a Markdown
 * document, in document order.
 *
 * @param markdown - The Markdown source to scan
 * @returns The content of each fenced code block (delimiters excluded)
 */
export function fencedBlocks(markdown: string): string[] {
  return scanFences(markdown).blocks;
}

/**
 * Extract the contents of every inline single-backtick span in a Markdown
 * document, excluding spans inside fenced (```) code blocks (already
 * covered by {@link fencedBlocks}).
 *
 * @param markdown - The Markdown source to scan
 * @returns The content of each inline code span (backticks excluded)
 */
export function inlineCodeSpans(markdown: string): string[] {
  const { withoutFences } = scanFences(markdown);
  const spans: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  for (const match of withoutFences.matchAll(pattern)) {
    spans.push(match[1]);
  }
  return spans;
}
