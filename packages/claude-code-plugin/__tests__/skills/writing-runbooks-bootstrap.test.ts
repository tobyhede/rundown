import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'writing-runbooks', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('writing-runbooks companion bootstrap skill guidance', () => {
  it('documents how to create a companion bootstrap skill', () => {
    expect(readSkill()).toMatch(/## Companion Bootstrap Skill/);
  });

  it('shows the runbook: frontmatter that fires the SkillStart gate', () => {
    expect(readSkill()).toMatch(/runbook:\s*<runbook-name>/);
  });

  it('explains the gate auto-runs the runbook and invokes running-runbooks', () => {
    const skill = readSkill();
    expect(skill).toMatch(/SkillStart/);
    expect(skill).toMatch(/running-runbooks/);
  });

  it('lists the sibling-skill heuristics including delegation', () => {
    const skill = readSkill();
    expect(skill).toMatch(/DELEGATE.*delegating-runbooks/s);
    expect(skill).toMatch(/writing-plans/);
  });
});
