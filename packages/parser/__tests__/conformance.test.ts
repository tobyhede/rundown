import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookDocument } from '../src/index.js';
import type { Step } from '../src/ast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Point to the root runbooks/patterns directory
const FIXTURES_DIR = path.join(__dirname, '../fixtures/conformance');
// Point to the root runbooks/patterns directory relative to fixtures
const PATTERNS_DIR = path.resolve(FIXTURES_DIR, '../../../../runbooks/patterns');

function getFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);

  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      results = results.concat(getFilesRecursively(filePath));
    } else if (file.endsWith('.runbook.md')) {
      results.push(filePath);
    }
  }
  return results;
}

/** Check if any step (or substep) has a GOTO transition */
function hasGotoTransition(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    if (s.transitions) {
      const { pass, fail } = s.transitions;
      if (pass.action.type === 'GOTO' || fail.action.type === 'GOTO') return true;
    }
    if (s.kind === 'substeps' || s.kind === 'for') {
      return hasGotoTransition(s.substeps);
    }
    return false;
  });
}

/** Check if any step (or substep) has a retry > 0 */
function hasRetry(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    if (s.transitions) {
      const { pass, fail } = s.transitions;
      if (pass.retry > 0 || fail.retry > 0) return true;
    }
    if (s.kind === 'substeps' || s.kind === 'for') {
      return hasRetry(s.substeps);
    }
    return false;
  });
}

/** Check if any step (or substep) has transitions defined */
function hasTransitions(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    if (s.transitions) return true;
    if (s.kind === 'substeps' || s.kind === 'for') {
      return hasTransitions(s.substeps);
    }
    return false;
  });
}

describe('Rundown Conformance (Fixture Driven)', () => {
  describe('Valid Runbooks (Patterns)', () => {
    const files = getFilesRecursively(PATTERNS_DIR);

    it.each(files)('should parse valid runbook: %s', (filePath) => {
      const content = fs.readFileSync(filePath, 'utf8');
      const runbook = parseRunbookDocument(content);
      const tags = runbook.tags ?? [];

      // All valid patterns must have at least one step
      expect(runbook.steps.length).toBeGreaterThan(0);

      // Tag-driven structural assertions
      if (tags.includes('for-loops')) {
        const hasForStep = runbook.steps.some((s) => s.kind === 'for');
        if (!hasForStep) {
          // FOR clause may contain unexpanded template variables (e.g., {{Max}})
          const hasTemplateFor = /^- FOR .+\{\{/m.test(content);
          expect(hasTemplateFor).toBe(true);
        }
      }

      if (tags.includes('substeps')) {
        const hasSubstepStep = runbook.steps.some(
          (s) => s.kind === 'substeps' || s.kind === 'for',
        );
        expect(hasSubstepStep).toBe(true);
      }

      if (tags.includes('transitions')) {
        expect(hasTransitions(runbook.steps)).toBe(true);
      }

      if (tags.includes('goto')) {
        expect(hasGotoTransition(runbook.steps)).toBe(true);
      }

      if (tags.includes('retries')) {
        expect(hasRetry(runbook.steps)).toBe(true);
      }
    });
  });

  describe('Invalid Runbooks', () => {
    const invalidDir = path.join(FIXTURES_DIR, 'invalid');
    const files = fs.readdirSync(invalidDir).filter((f) => f.endsWith('.runbook.md'));

    it.each(files)('should reject invalid runbook: %s', (file) => {
      const content = fs.readFileSync(path.join(invalidDir, file), 'utf8');
      expect(() => parseRunbookDocument(content)).toThrow();
    });
  });
});
