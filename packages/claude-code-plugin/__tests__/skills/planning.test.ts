import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'planning', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('planning skill', () => {
  it('declares kebab-case name and a description', () => {
    const skill = readSkill();
    expect(skill).toMatch(/^name:\s*planning\s*$/m);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('declares the runbook via frontmatter so the SkillStart gate starts it', () => {
    const skill = readSkill();
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    expect(frontmatter).toMatch(/^runbook:\s*rundown:planning\s*$/m);
  });

  it('does not hand-roll the runbook start (gate owns it now)', () => {
    const skill = readSkill();
    expect(skill).not.toMatch(/Start the runbook:\s*`rd run/);
    expect(skill).not.toContain('<important>');
  });

  it('cross-links the stage skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/writing-plans/);
    expect(skill).toMatch(/executing-plans/);
    expect(skill).toMatch(/running-runbooks/);
  });
});
