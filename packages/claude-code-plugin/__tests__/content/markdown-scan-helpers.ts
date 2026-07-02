import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** Recursively collect every `.md` file under `root`. */
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

/** Extract the contents of every fenced (```) code block in `markdown`. */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Extract the contents of every inline single-backtick span in `markdown`,
 * excluding spans inside fenced (```) code blocks (already covered by
 * {@link fencedBlocks}).
 */
export function inlineCodeSpans(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const spans: string[] = [];
  const pattern = /`([^`\n]+)`/g;
  for (const match of withoutFences.matchAll(pattern)) {
    spans.push(match[1]);
  }
  return spans;
}
