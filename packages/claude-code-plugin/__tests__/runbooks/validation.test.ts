/**
 * Unit tests for built-in runbook validation.
 * Uses @rundown-org/parser directly for fast validation.
 * Pattern: similar to packages/cli/__tests__/check.test.ts but without CLI
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookDocument } from '@rundown-org/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runbooksDir = join(__dirname, '..', '..', 'runbooks');
const projectRoot = join(__dirname, '..', '..');

/**
 * Recursively find all .runbook.md files in a directory.
 *
 * @param dir - Directory to search
 * @returns Array of absolute paths to runbook files
 */
function findRunbooks(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const runbooks: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      runbooks.push(...findRunbooks(fullPath));
    } else if (entry.endsWith('.runbook.md')) {
      runbooks.push(fullPath);
    }
  }
  return runbooks;
}

describe('Built-in Runbook Validation', () => {
  const runbooks = findRunbooks(runbooksDir);

  it('runbooks directory is not empty', () => {
    expect(runbooks.length).toBeGreaterThan(0);
  });

  if (runbooks.length === 0) return;

  // Use relative paths for cleaner test names
  const runbookEntries = runbooks.map((p) => [relative(projectRoot, p), p] as const);

  describe.each(runbookEntries)('%s', (_relativePath, runbookPath) => {
    const content = readFileSync(runbookPath, 'utf-8');
    const { runbook, diagnostics } = parseRunbookDocument(content, runbookPath);

    it('parses without syntax errors', () => {
      expect(runbook).toBeDefined();
    });

    it('passes validation checks', () => {
      expect(diagnostics).toEqual([]);
    });

    it('has required metadata', () => {
      expect(runbook.name).toBeDefined();
      expect(typeof runbook.name).toBe('string');
    });

    it('has at least one step', () => {
      expect(runbook.steps.length).toBeGreaterThan(0);
    });
  });

  it('does not use removed rdx --check mode', () => {
    const offenders = runbookEntries
      .map(([relativePath, runbookPath]) => ({
        relativePath,
        content: readFileSync(runbookPath, 'utf-8'),
      }))
      .filter(({ content }) => /rdx --check\b/.test(content))
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });

  it('does not double-quote schema helper templates in command blocks', () => {
    const shellFence = /```(?:bash|sh|shell)[^\n]*\n([\s\S]*?)\n```/g;
    const quotedValidateSchema = /"\{\{\s*validateSchema\s+[^}]+\s*\}\}"/;
    const offenders = runbookEntries
      .map(([relativePath, runbookPath]) => ({
        relativePath,
        content: readFileSync(runbookPath, 'utf-8'),
      }))
      .filter(({ content }) =>
        Array.from(content.matchAll(shellFence)).some((match) =>
          quotedValidateSchema.test(match[1]),
        ),
      )
      .map(({ relativePath }) => relativePath);

    expect(offenders).toEqual([]);
  });
});
