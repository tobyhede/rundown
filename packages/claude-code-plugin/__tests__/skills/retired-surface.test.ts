import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every agent-facing Markdown the plugin ships — both plugin copies of every
// skill and its references, and every bundled runbook — teaches only the
// one-writer protocol (#907, ADR 0005): no retired command or flag.
const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['skills', 'codex-plugin/skills', 'runbooks', 'codex-plugin/runbooks'];

function markdownUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return markdownUnder(full);
    return entry.endsWith('.md') ? [full] : [];
  });
}

const files = ROOTS.flatMap((root) => markdownUnder(path.join(pluginRoot, root)));

const RETIRED: readonly [string, RegExp][] = [
  ['--claim-id', /--claim-id\b/],
  ['claim_id', /\bclaim_id\b/],
  ['stash', /\b(?:rundown|rd)\s+stash\b/],
  ['pop', /\b(?:rundown|rd)\s+pop\b/],
  ['delegate', /\b(?:rundown|rd)\s+delegate\b/],
  ['abort', /\b(?:rundown|rd)\s+abort\b/],
  ['RD_CLAIM_TOKEN', /\bRD_CLAIM_TOKEN\b/],
  ['rdtk_ delegation token', /\brdtk_/],
];

describe('shipped skills and runbooks teach no retired command or flag', () => {
  it('scans every skill and runbook of both plugin copies', () => {
    expect(files.some((file) => file.includes('delegating-runbooks'))).toBe(true);
    expect(files.some((file) => file.includes(`codex-plugin${path.sep}skills`))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(RETIRED)('no file names %s', (_name, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf-8')));
    expect(offenders.map((file) => path.relative(pluginRoot, file))).toEqual([]);
  });
});
