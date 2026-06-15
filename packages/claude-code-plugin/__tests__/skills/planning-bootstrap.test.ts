import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRunbookFromFrontmatter } from '../../src/shared/frontmatter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const planningSkill = path.join(__dirname, '..', '..', 'skills', 'planning', 'SKILL.md');

describe('planning bootstrap resolves through the SkillStart gate', () => {
  it('frontmatter runbook resolves to the planning runbook the gate will run', () => {
    const content = readFileSync(planningSkill, 'utf-8');
    const runbook = parseRunbookFromFrontmatter(content);
    // This is the verbatim value the gate passes to `rd run <value>`.
    expect(runbook).toBe('rundown:planning');
  });
});
