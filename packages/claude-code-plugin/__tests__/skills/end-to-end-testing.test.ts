import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'end-to-end-testing', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('end-to-end-testing skill', () => {
  it('describes the current simplified end-to-end runbook flow', () => {
    const skill = readSkill();

    expect(skill).toContain('description: Use when ');
    expect(skill).toContain('end-to-end-test/write-file.runbook.md');
    expect(skill).toContain('end-to-end-test/review-and-collate.runbook.md');
    expect(skill).toContain('end-to-end-test/review-file.runbook.md');
    expect(skill).toContain('end-to-end-test/collate-files.runbook.md');
    expect(skill).toContain('Only nested review and collation runbooks are delegated');
  });

  it('omits stale flow and setup instructions', () => {
    const skill = readSkill();

    expect(skill).not.toMatch(/write-plan|review-plan|GET \/items\/:id/);
    expect(skill).not.toMatch(/npm install|npm run build|installation|Local Setup/i);
  });

  it('describes the idempotent delegation flow', () => {
    const skill = readSkill();

    // The DELEGATE step auto-issues the token; the agent claims it directly.
    expect(skill).toContain('rd claim <token>');
    expect(skill).toMatch(/auto-issues a claim token/i);
    // A self-completing child auto-resolves and the parent auto-aggregates,
    // so the manual driver commands are not required for the happy path.
    expect(skill).toMatch(/auto-resolves/i);
    expect(skill).toMatch(/auto-aggregates and advances/i);
    // pass/fail --claim-id is reserved for stopped children and is idempotent.
    expect(skill).toMatch(/idempotent/i);
  });

  it('uses transition output as the normal agent context', () => {
    const skill = readSkill();

    expect(skill).toContain('Use default JSON output');
    expect(skill).toContain(
      'Treat `rd run`, `rd pass`, `rd fail`, `rd claim`, and `rd collect` output as the next context',
    );
    expect(skill).toContain(
      'Use `rd status` only to recover orientation after an error or interruption',
    );
    expect(skill).not.toContain('rd status --text');
  });

  it('stays terse for agent use', () => {
    const wordCount = readSkill().trim().split(/\s+/u).length;

    expect(wordCount).toBeLessThanOrEqual(350);
  });
});
