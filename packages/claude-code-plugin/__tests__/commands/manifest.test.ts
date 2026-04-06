/**
 * Validates that command files reference skills that actually exist.
 * Prevents breakage when skills are renamed or deleted without updating commands.
 * Pattern: similar to __tests__/runbooks/validation.test.ts
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(__dirname, '..', '..');
const commandsDir = path.join(pluginRoot, 'commands');
const skillsDir = path.join(pluginRoot, 'skills');

/** Matches `Skill(skill: "rundown:skill-name")` references in command content. */
const SKILL_REF_PATTERN = /Skill\(skill:\s*"rundown:([\w-]+)"\)/g;

describe('Command-Skill Wiring', () => {
  const commandFiles = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter((f) => f.endsWith('.md'))
    : [];

  if (commandFiles.length === 0) {
    it.skip('validates command files if any exist', () => {});
    return;
  }

  describe.each(commandFiles)('%s', (filename) => {
    const content = readFileSync(path.join(commandsDir, filename), 'utf-8');
    const refs = [...content.matchAll(SKILL_REF_PATTERN)].map((m) => m[1]);

    if (refs.length === 0) return;

    it.each(refs)('skill "%s" exists', (skillName) => {
      const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
    });
  });
});
