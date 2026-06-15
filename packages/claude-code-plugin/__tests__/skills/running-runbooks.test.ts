import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'running-runbooks', 'SKILL.md');

function readDescription(): string {
  const skill = readFileSync(skillPath, 'utf-8');
  const match = /^description:\s*(.+)$/m.exec(skill);
  expect(match).not.toBeNull();
  return match![1];
}

describe('running-runbooks skill description', () => {
  it('still triggers on an active runbook', () => {
    expect(readDescription()).toMatch(/active/i);
  });

  it('also triggers on a cold-start request to run or start a runbook', () => {
    // "start" is absent from the original description (which only says "active",
    // "receiving", "appear"); "run" is unreliable since it is a substring of
    // "Rundown"/"runbook". So the cold-start signal we assert on is "start".
    expect(readDescription()).toMatch(/start/i);
  });

  it('still covers delegation claim tokens', () => {
    expect(readDescription()).toMatch(/claim token/i);
  });
});
