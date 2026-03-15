import { describe, it, expect } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookDocument, RunbookSyntaxError } from '../src/index.js';
import type { Step } from '../src/ast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Point to the conformance test fixtures directory
const FIXTURES_DIR = path.join(__dirname, '../fixtures/conformance');
// Point to the root runbooks directory relative to fixtures
const PATTERNS_DIR = path.resolve(FIXTURES_DIR, '../../../../runbooks');

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
    const { pass, fail } = s.transitions;
    if (pass.action.type === 'GOTO' || fail.action.type === 'GOTO') return true;
    if (s.kind === 'substeps' || s.kind === 'for') {
      return hasGotoTransition(s.substeps);
    }
    return false;
  });
}

/** Check if any step (or substep) has a retry > 0 */
function hasRetry(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    const { pass, fail } = s.transitions;
    if (pass.retry > 0 || fail.retry > 0) return true;
    if (s.kind === 'substeps' || s.kind === 'for') {
      return hasRetry(s.substeps);
    }
    return false;
  });
}

/** Check if any step (or substep) has non-default transitions */
function hasTransitions(steps: readonly Step[]): boolean {
  return steps.some((s) => {
    // Check for non-default transitions (not just PASS CONTINUE / FAIL STOP)
    const hasNonDefault =
      s.transitions.pass.action.type !== 'CONTINUE' ||
      s.transitions.fail.action.type !== 'STOP' ||
      s.transitions.pass.retry > 0 ||
      s.transitions.fail.retry > 0;
    if (hasNonDefault) return true;
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
      const { runbook, diagnostics } = parseRunbookDocument(content);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      expect(errors).toHaveLength(0);
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
        const hasSubstepStep = runbook.steps.some((s) => s.kind === 'substeps' || s.kind === 'for');
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
      // Invalid runbooks either throw (parse-level errors like H4+, duplicate IDs)
      // or return error-severity diagnostics (validation errors like non-sequential steps)
      let result: ReturnType<typeof parseRunbookDocument> | null = null;
      try {
        result = parseRunbookDocument(content);
      } catch (error) {
        if (error instanceof RunbookSyntaxError) {
          return; // Parse-level syntax error — expected for truly malformed markdown
        }
        throw error; // Re-throw unexpected errors
      }
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
