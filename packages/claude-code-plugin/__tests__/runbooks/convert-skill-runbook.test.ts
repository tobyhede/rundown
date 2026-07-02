import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookDocument } from '@rundown-org/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runbookPath = path.join(
  __dirname,
  '..',
  '..',
  'runbooks',
  'meta',
  'convert-skill.runbook.md',
);

const content = readFileSync(runbookPath, 'utf-8');
const { runbook, diagnostics, frontmatter } = parseRunbookDocument(content, runbookPath);

function artifactNames(stepName: string): readonly string[] {
  const step = runbook.steps.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`missing step ${stepName}`);
  return (step.artifacts ?? []).map((artifact) => artifact.name);
}

describe('convert-skill.runbook.md', () => {
  it('parses without diagnostics', () => {
    expect(runbook).toBeDefined();
    expect(diagnostics).toEqual([]);
  });

  it('declares the conversion contract in frontmatter', () => {
    expect(frontmatter?.name).toBe('convert-skill');
    expect(frontmatter?.inputs).toEqual(['SkillPath']);
    expect(frontmatter?.required).toEqual(['SkillPath']);
    expect(frontmatter?.outputs?.map((output) => output.name)).toEqual(['RunbookPath']);
  });

  it('binds the converting-skills-to-runbooks skill in frontmatter', () => {
    expect(content).toMatch(/^skill:\s*converting-skills-to-runbooks\s*$/m);
  });

  it('captures the conversion backbone as ordered steps', () => {
    expect(runbook.steps.map((step) => step.description)).toEqual([
      'Invoke the converting-skills-to-runbooks skill',
      'Read the source skill',
      'Map the backbone',
      'Write the runbook',
      'Check the runbook',
      'Verify against the checklist',
    ]);
  });

  it('coordinates the SkillPath input and RunbookPath output artifacts', () => {
    expect(artifactNames('2')).toEqual(['SkillPath']);
    expect(artifactNames('4')).toEqual(['RunbookPath']);
  });

  it('validates the produced runbook with a check → retry loop', () => {
    expect(content).toMatch(/rundown check \{\{ path RunbookPath \}\}/);
    expect(content).not.toMatch(/rdx --check\b/);
    expect((content.match(/FAIL GOTO 4/g) ?? []).length).toBe(2);
  });

  it('references the source skill instead of restating it', () => {
    expect(content).toMatch(/Invoke and read the converting-skills-to-runbooks skill/);
    expect(content).toMatch(/do not restate its context/i);
  });
});
