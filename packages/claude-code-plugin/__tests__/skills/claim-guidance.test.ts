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

describe('delegated runbook claim guidance', () => {
  it('requires explicit claim-id targeting within the claim flow', () => {
    // Scope the check to the claim-flow guidance only. Bare `rd pass` / `rd fail`
    // are legitimate in the general command reference and inline-launch notes;
    // it is the claim flow that must always target the claimed child by id.
    const claimSections = [
      section(readSkill('running-runbooks/SKILL.md'), '## Claiming Delegated Work'),
      section(readSkill('delegating-runbooks/SKILL.md'), '### 3. Child claims and executes'),
    ];

    for (const claim of claimSections) {
      expect(claim).not.toBe('');
      expect(claim).toContain('rd pass --claim-id <claim_id>');
      expect(claim).toContain('rd fail --claim-id <claim_id>');
      expect(claim).not.toMatch(/rd pass\s+(?:#|$)/m);
      expect(claim).not.toMatch(/rd fail\s+(?:#|$)/m);
    }
  });
});
