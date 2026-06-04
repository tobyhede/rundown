import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillPath = join(__dirname, '..', '..', 'skills', 'end-to-end-testing', 'SKILL.md');

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
    expect(skill).toContain('Only the nested review and collation runbooks are delegated');
  });

  it('omits stale flow and setup instructions', () => {
    const skill = readSkill();

    expect(skill).not.toMatch(/write-plan|review-plan|GET \/items\/:id/);
    expect(skill).not.toMatch(/npm install|npm run build|installation|Local Setup/i);
  });

  it('stays terse for agent use', () => {
    const wordCount = readSkill().trim().split(/\s+/u).length;

    expect(wordCount).toBeLessThanOrEqual(350);
  });
});
