import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillDir = join(__dirname, '..', '..', 'skills', 'converting-skills-to-runbooks');

function readSkill(): string {
  return readFileSync(join(skillDir, 'SKILL.md'), 'utf-8');
}

describe('converting-skills-to-runbooks skill', () => {
  it('declares kebab-case name and a description', () => {
    const skill = readSkill();
    expect(skill).toMatch(/^name:\s*converting-skills-to-runbooks\s*$/m);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('teaches the backbone-vs-context distinction', () => {
    const skill = readSkill();
    expect(skill).toMatch(/backbone/i);
    expect(skill).toMatch(/context/i);
    expect(skill).toMatch(/do not (re-?state|duplicate|teach)/i);
  });

  it('prescribes the skill-invocation first step', () => {
    const skill = readSkill();
    expect(skill).toMatch(/Invoke and read the.*skill/i);
    expect(skill).toMatch(/`skill:`/);
  });

  it('cross-links the reference skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/house-style\.md/);
    expect(skill).toMatch(/writing-runbooks/);
    expect(skill).toMatch(/delegating-runbooks/);
    expect(skill).toMatch(/writing-plans/);
  });

  it('points to its own references and companion runbook', () => {
    const skill = readSkill();
    expect(skill).toMatch(/references\/mapping\.md/);
    expect(skill).toMatch(/references\/checklist\.md/);
    expect(skill).toMatch(/convert-skill\.runbook\.md/);
  });

  it('ships the references directory', () => {
    expect(existsSync(join(skillDir, 'references', 'mapping.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'checklist.md'))).toBe(true);
  });
});
