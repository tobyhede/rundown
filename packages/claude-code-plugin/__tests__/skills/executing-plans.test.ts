import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'executing-plans', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('executing-plans skill', () => {
  it('declares kebab-case name and a description', () => {
    const skill = readSkill();
    expect(skill).toMatch(/^name:\s*executing-plans\s*$/m);
    expect(skill).toMatch(/^description:\s*\S+/m);
  });

  it('declares the runbook entrypoint with its required PlanPath artifact URI', () => {
    const skill = readSkill();
    // execute-plan declares PlanPath REQUIRED and consumes it as an ARTIFACT, so
    // a standalone start must supply the plan's rd:// artifact URI — a bare
    // filesystem path (or bare `rd run`) fails before the runbook activates.
    expect(skill).toMatch(/rd run rundown:execute-plan --input PlanPath=<rd:\/\/[^>]*plan URI>/);
    expect(skill).toMatch(/Resolve `PlanPath`\s+first/);
    // Points the implementer at the inspection commands that yield the URI.
    expect(skill).toMatch(/rd artifact uri/);
    expect(skill).toMatch(/Skill\(skill:\s*"rundown:running-runbooks"\)/);
  });

  it('describes the per-task cycle as the context, not the sequence', () => {
    const skill = readSkill();
    expect(skill).toMatch(/per-task/i);
    expect(skill).toMatch(/commit/i);
    // Cedes the sequence + gates to the runbook rather than restating them.
    expect(skill).toMatch(/execute-plan/);
  });

  it('cross-links related skills instead of restating them', () => {
    const skill = readSkill();
    expect(skill).toMatch(/writing-plans/);
    expect(skill).toMatch(/running-runbooks/);
    expect(skill).toMatch(/delegating-runbooks/);
  });

  it('tells the implementer when to stop and escalate', () => {
    const skill = readSkill();
    expect(skill).toMatch(/escalate|stop/i);
  });
});
