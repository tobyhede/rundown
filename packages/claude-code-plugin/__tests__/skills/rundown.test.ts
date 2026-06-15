import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'rundown', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

describe('rundown launcher skill', () => {
  it('declares kebab-case name matching its directory', () => {
    expect(readSkill()).toMatch(/^name:\s*rundown\s*$/m);
  });

  it('has a description that triggers on a cold-start request to run a runbook', () => {
    const skill = readSkill();
    const descMatch = /^description:\s*(.+)$/m.exec(skill);
    expect(descMatch).not.toBeNull();
    const description = descMatch![1].toLowerCase();
    expect(description).toMatch(/run|start/);
    expect(description).toContain('runbook');
  });

  it('is a generic launcher, not a per-runbook bootstrap (no fixed runbook: frontmatter)', () => {
    const skill = readSkill();
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '';
    expect(frontmatter).not.toMatch(/^runbook:/m);
  });

  it('resolves the runbook by name and starts it via the CLI', () => {
    const skill = readSkill();
    expect(skill).toMatch(/rd ls --all/);
    expect(skill).toMatch(/rd run /);
  });

  it('hands off to the running-runbooks protocol', () => {
    expect(readSkill()).toMatch(/running-runbooks/);
  });
});
