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

function bootstrapSection(): string {
  const skill = readSkill();
  const start = skill.indexOf('## Companion Bootstrap Skill');
  expect(start).toBeGreaterThanOrEqual(0);
  // The section is the penultimate one; only "## Reference" follows it (which
  // contains no bootstrap-start language), so slice to end of file. A boundary
  // search on "\n## " is unsafe here because the template code block contains
  // H2-looking lines (e.g. "## Runbook-Orchestrated Skill").
  return skill.slice(start);
}

describe('writing-runbooks companion bootstrap skill guidance', () => {
  it('documents how to create a companion bootstrap skill', () => {
    expect(readSkill()).toMatch(/## Companion Bootstrap Skill/);
  });

  it('describes the agent-driven model: the agent runs rd run', () => {
    const section = bootstrapSection();
    expect(section).toMatch(/Start the runbook:\s*`rd run <runbook-name>`/);
    expect(section).toMatch(/Skill\(skill:\s*"rundown:running-runbooks"\)/);
  });

  it('does not promote an auto-start gate or runbook: frontmatter field', () => {
    const section = bootstrapSection();
    expect(section).not.toMatch(/SkillStart/);
    // No `runbook:` frontmatter field in the template (a line on its own).
    expect(section).not.toMatch(/^runbook:/m);
  });

  it('lists the sibling-skill heuristics including delegation', () => {
    const section = bootstrapSection();
    expect(section).toMatch(/DELEGATE.*delegating-runbooks/s);
    expect(section).toMatch(/writing-plans/);
  });
});
