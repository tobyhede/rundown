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

  it('runs the delegated review step to completion through claim tickets and collect', () => {
    const skill = readSkill();

    // Steps 2 and 3 compose inline (#903); step 3's child delegates review and
    // collation, which the orchestrator dispatches by ticket and collects (#904).
    expect(skill).toMatch(/compose their runbooks inline/);
    expect(skill).toContain('dispatch one sub-agent per `ticket`');
    expect(skill).toContain('`RD_CLAIM_TICKET=<ticket>`');
    expect(skill).toContain('`rundown collect --token <owner_token>`');
    expect(skill).toMatch(/until no child is `pending` or `unclaimed`/);
    expect(skill).toContain('Run every step to completion');
    expect(skill).not.toContain('RUNBOOK_COMPOSITION_UNSUPPORTED');
    expect(skill).not.toMatch(/Report the refusal/);
  });

  it('drives steps with the owner token, never retired authority', () => {
    const skill = readSkill();

    expect(skill).toContain('`--token <owner_token>`');
    expect(skill).toContain('`--step <position>`');
    expect(skill).not.toContain('--claim-id');
    expect(skill).not.toMatch(/rundown (?:delegate|abort)\b/);
  });

  it('uses transition output as the normal agent context', () => {
    const skill = readSkill();

    expect(skill).toContain('Use default JSON output');
    // Prose is wrapped, so match across the line break.
    expect(skill).toMatch(
      /Treat `rundown run`, `rundown pass`, and `rundown fail` output as the next\s+context/,
    );
    expect(skill).toMatch(
      /Use `rundown status --run <run_id>` only to recover orientation after an error\s+or interruption/,
    );
    expect(skill).not.toContain('rundown status --text');
  });

  it('stays terse for agent use', () => {
    const wordCount = readSkill().trim().split(/\s+/u).length;

    expect(wordCount).toBeLessThanOrEqual(400);
  });
});
