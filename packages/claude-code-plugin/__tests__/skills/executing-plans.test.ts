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
    // a standalone start must supply the plan's rd:// artifact URI through the
    // dedicated artifact channel — a bare filesystem path (or bare `rundown
    // run`) fails before the runbook activates.
    expect(skill).toMatch(
      /rundown run rundown:execute-plan --artifacts PlanPath=<rd:\/\/[^>]*plan URI>/,
    );
    expect(skill).toMatch(/Resolve `PlanPath`\s+first/);
    // Points the implementer at the inspection commands that yield the URI.
    expect(skill).toMatch(/rundown artifact uri/);
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
    // execute-plan delegates its stages, so the orchestrator protocol is linked.
    expect(skill).toMatch(/\[delegating-runbooks\]\(\.\.\/delegating-runbooks\/SKILL\.md\)/);
  });

  it('runs execute-plan end to end, collecting its delegated stages', () => {
    const skill = readSkill();
    expect(skill).toContain('`rundown collect --token <owner_token>`');
    expect(skill).toMatch(/one sub-agent per ticket/);
    expect(skill).not.toContain('RUNBOOK_COMPOSITION_UNSUPPORTED');
    expect(skill).not.toMatch(/#904/);
    // The leaf still runs standalone for work without the gates.
    expect(skill).toMatch(
      /rundown run rundown:implement-plan --artifacts PlanPath=<rd:\/\/[^>]*plan URI>/,
    );
  });

  it('tells the implementer when to stop and escalate', () => {
    const skill = readSkill();
    expect(skill).toMatch(/escalate|stop/i);
  });
});
