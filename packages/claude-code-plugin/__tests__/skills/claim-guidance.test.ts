import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillsDir = path.join(__dirname, '..', '..', 'skills');

function readSkill(relativePath: string): string {
  return readFileSync(path.join(skillsDir, relativePath), 'utf-8');
}

/**
 * Extract the body of the Markdown section introduced by `heading`, up to (but
 * excluding) the next heading at the same or higher level.
 *
 * Heading detection ignores lines inside fenced code blocks, so a bash comment
 * such as `# ... work through steps ...` does not prematurely terminate the
 * section.
 *
 * @param markdown - Full Markdown document to slice.
 * @param heading - Exact heading line that starts the section (e.g. `## Claiming Delegated Work`).
 * @returns The section text including its heading, or `''` when the heading is absent.
 */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return '';
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const boundary = new RegExp(`^#{1,${String(level)}}\\s`);
  let inFence = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && boundary.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('running-runbooks owner-token guidance', () => {
  it('teaches every mutating command with the owner token', () => {
    const skill = readSkill('running-runbooks/SKILL.md');

    expect(skill).toContain('rundown pass --token <owner_token> --step');
    expect(skill).toContain('rundown fail --token <owner_token> --step');
    for (const command of ['goto <step>', 'stop [message]', 'complete [message]']) {
      expect(skill).toContain(`rundown ${command} --token <owner_token>`);
    }
    // Never a bare transition: without --token every mutation is refused.
    expect(skill).not.toMatch(/rundown (?:pass|fail)\s+(?:#|$)/m);
  });

  it('teaches no retired authority', () => {
    const skill = readSkill('running-runbooks/SKILL.md');

    expect(skill).not.toContain('--claim-id');
    expect(skill).not.toContain('ACTOR_CONTEXT_REQUIRED');
    expect(skill).not.toMatch(/rundown (?:claim|collect|delegate|stash|pop)\b/);
  });

  it('says the token is printed once and cannot be recovered', () => {
    const owner = section(readSkill('running-runbooks/SKILL.md'), '## The Owner Token');

    expect(owner).toContain('`runbook_started`');
    expect(owner).toContain('cannot\nbe recovered');
    expect(owner).toContain('`rundown status --run <run_id>`');
  });
});

// delegating-runbooks is parked unchanged until delegation returns (#904).
describe('delegating-runbooks claim guidance (parked for #904)', () => {
  it('requires explicit claim-id targeting within the claim flow', () => {
    const claim = section(
      readSkill('delegating-runbooks/SKILL.md'),
      '### 3. Child claims and executes',
    );

    expect(claim).not.toBe('');
    expect(claim).toContain('rundown pass --claim-id <claim_id>');
    expect(claim).toContain('rundown fail --claim-id <claim_id>');
    expect(claim).not.toMatch(/rundown pass\s+(?:#|$)/m);
    expect(claim).not.toMatch(/rundown fail\s+(?:#|$)/m);
  });

  it('keeps delegation idempotency examples aligned with delegate output and retry forms', () => {
    const delegate = section(
      readSkill('delegating-runbooks/SKILL.md'),
      '### 1. Delegate a substep',
    );

    expect(delegate).not.toBe('');
    expect(delegate).toContain('action: "already-delegated"');
    expect(delegate).not.toContain('command: "already-delegated"');
    expect(delegate).toContain('rundown delegate --retry --claim-id <claim_id>');
  });
});
