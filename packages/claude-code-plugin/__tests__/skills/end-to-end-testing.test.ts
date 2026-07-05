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

  it('describes the claimed-child delegation flow', () => {
    const skill = readSkill();

    // The DELEGATE step auto-issues the token; the agent claims it directly.
    expect(skill).toContain('rundown claim <token>');
    expect(skill).toMatch(/auto-issues a claim token/i);
  });

  it('directs claimed children to advance with claim-id-targeted transitions', () => {
    const skill = readSkill();

    // Claimed children — including prompted ones — advance and report their
    // result with claim-id-targeted transitions, matching running-runbooks.
    expect(skill).toContain('rundown pass --claim-capability <claim_capability>');
    expect(skill).toContain('rundown fail --claim-capability <claim_capability>');
    // It must NOT claim that claim-id targeting is only for early-stopped
    // children — prompted claimed children need it to advance at all.
    expect(skill).not.toMatch(/only for a child you stop early/i);
    expect(skill).not.toMatch(/reserved for stopped children/i);
    // On a delegation-exposed run a bare pass/fail is refused (ACTOR_CONTEXT_REQUIRED),
    // not silently routed to the parent; the child must name its --claim-id lane.
    expect(skill).toMatch(
      /bare `rundown pass`\/`rundown fail` is refused with `ACTOR_CONTEXT_REQUIRED`/i,
    );
  });

  it('uses transition output as the normal agent context', () => {
    const skill = readSkill();

    expect(skill).toContain('Use default JSON output');
    expect(skill).toContain(
      'Treat `rundown run`, `rundown pass`, `rundown fail`, `rundown claim`, and `rundown collect` output as the next context',
    );
    expect(skill).toContain(
      'Use `rundown status` only to recover orientation after an error or interruption',
    );
    expect(skill).not.toContain('rundown status --text');
  });

  it('stays terse for agent use', () => {
    const wordCount = readSkill().trim().split(/\s+/u).length;

    // Cap raised 350 -> 400 in the R2 explicit-targeting migration: the post-R1
    // refusal model (ACTOR_CONTEXT_REQUIRED, sticky exposure, --run/--claim-id
    // lane split) is load-bearing agent guidance and cannot be expressed within
    // the old budget without dropping correctness.
    expect(wordCount).toBeLessThanOrEqual(400);
  });
});
