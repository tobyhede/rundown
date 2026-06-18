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

  it('declares the runbook entrypoint and running-runbooks invocation', () => {
    const skill = readSkill();
    expect(skill).toMatch(/`rd run rundown:planning`/);
    expect(skill).toMatch(/Skill\(skill:\s*"rundown:running-runbooks"\)/);
    // Lock the no-added-flags contract: the start command must never carry
    // --text (or any other flag) in the example, even as the skill prose
    // elsewhere explains why --text is human/debug-only.
    expect(skill).not.toMatch(/rd run rundown:planning\s+--/);
  });

  it('cross-links the stage skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/writing-plans/);
    expect(skill).toMatch(/executing-plans/);
    expect(skill).toMatch(/running-runbooks/);
  });
});
