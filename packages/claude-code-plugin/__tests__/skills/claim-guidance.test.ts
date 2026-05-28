import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const skillsDir = join(__dirname, '..', '..', 'skills');

function readSkill(relativePath: string): string {
  return readFileSync(join(skillsDir, relativePath), 'utf-8');
}

describe('delegated runbook claim guidance', () => {
  it('requires explicit claim-id targeting after rd claim', () => {
    const runningRunbooks = readSkill('running-runbooks/SKILL.md');
    const delegatingRunbooks = readSkill('delegating-runbooks/SKILL.md');

    for (const skill of [runningRunbooks, delegatingRunbooks]) {
      expect(skill).toContain('rd pass --claim-id <claim_id>');
      expect(skill).toContain('rd fail --claim-id <claim_id>');
      expect(skill).not.toMatch(/rd pass\s+(?:#|$)/m);
      expect(skill).not.toMatch(/rd fail\s+(?:#|$)/m);
    }
  });
});
