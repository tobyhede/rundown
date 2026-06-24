import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.join(__dirname, '..', '..', 'skills', 'running-runbooks', 'SKILL.md');

function readSkill(): string {
  return readFileSync(skillPath, 'utf-8');
}

function readDescription(): string {
  const skill = readSkill();
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

describe('running-runbooks structured-output guidance', () => {
  it('documents JSON as the agent-facing default', () => {
    expect(readSkill()).toMatch(/JSON is the agent-facing output format/);
  });

  it('never demonstrates `--text` as an agent command example', () => {
    // `--text` is humans/debugging only; the agent protocol is JSON. Mirrors the
    // no-added-flags lock in planning.test.ts / end-to-end-testing.test.ts so the
    // primary execution-protocol skill cannot drift back to teaching the flag.
    const skill = readSkill();
    // Catch ANY `rd <cmd> … --text` example, not just the status variant. The
    // single-line match cannot false-positive on the prohibition prose, which
    // mentions `--text` with no `rd` command token on the same line.
    expect(skill).not.toMatch(/\brd\b[^\n]*--text/);
    expect(skill).toMatch(/Do not add `--text`/);
  });
});
