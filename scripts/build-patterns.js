#!/usr/bin/env node
/**
 * Build script to generate docs/PATTERNS.md from runbooks/patterns/INDEX.md
 *
 * Transforms Markdown links to .runbook.md files into embedded code blocks.
 *
 * Input:  - [name.runbook.md](./path/to/file.runbook.md)
 * Output: ```rundown
 *         <file contents>
 *         ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const INDEX_PATH = path.join(PROJECT_ROOT, 'runbooks/patterns/INDEX.md');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'docs/PATTERNS.md');

// Match list items with .runbook.md links: "- [name](path.runbook.md)"
const RUNBOOK_LINK_REGEX = /^(\s*)-\s*\[([^\]]+)\]\(([^)]+\.runbook\.md)\)\s*$/;

function buildPatterns() {
  const indexContent = fs.readFileSync(INDEX_PATH, 'utf8');
  const indexDir = path.dirname(INDEX_PATH);
  const lines = indexContent.split('\n');
  const outputLines = [];

  for (const line of lines) {
    const match = line.match(RUNBOOK_LINK_REGEX);

    if (match) {
      const [, indent, linkText, relativePath] = match;
      const absolutePath = path.resolve(indexDir, relativePath);

      try {
        const fileContent = fs.readFileSync(absolutePath, 'utf8').trim();
        // Add filename as comment, then code block
        outputLines.push('');
        outputLines.push(`${indent}**${linkText}:**`);
        outputLines.push('');
        outputLines.push(`${indent}\`\`\`rundown`);
        // Indent file content to match list level
        const contentLines = fileContent.split('\n').map(l => indent + l);
        outputLines.push(...contentLines);
        outputLines.push(`${indent}\`\`\``);
        outputLines.push('');
      } catch (err) {
        console.error(`Warning: Could not read ${absolutePath}: ${err.message}`);
        outputLines.push(line); // Keep original link if file not found
      }
    } else {
      outputLines.push(line);
    }
  }

  // Add generation notice at top
  const header = `<!-- GENERATED FILE - DO NOT EDIT DIRECTLY -->
<!-- Source: runbooks/patterns/INDEX.md -->
<!-- Regenerate: npm run docs:patterns -->

`;

  const output = header + outputLines.join('\n');
  fs.writeFileSync(OUTPUT_PATH, output);
  console.log(`Generated ${OUTPUT_PATH}`);
}

buildPatterns();
