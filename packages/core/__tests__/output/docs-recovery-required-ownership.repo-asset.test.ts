/**
 * `RECOVERY_REQUIRED` docs ↔ retained-ownership guard.
 *
 * Both docs described the refusal as one where nothing holds the run any more
 * ("no process holds it"), which is only half true and misleads in the
 * expensive direction. No LIVE process is advancing the run — waiting really
 * will not clear it — but the interrupted attempt leaves `runs.exec_token` set:
 * `ExecutionLeaseService.abandonToRecovery` writes `execution_attempts` only,
 * and `RunbookStore.commitRecovery` is the sole path that clears the run's
 * `exec_*` columns, in the same transaction that moves the attempt off
 * `recovery_pending`. So for as long as this refusal is reachable, the run is
 * still execution-owned, and the next execution-owning command refuses
 * `EXECUTION_IN_PROGRESS` rather than proceeding.
 *
 * A reader who believed the old wording would conclude the run had been let go
 * and reach for an execution command; `docs/spec/cli-output.md` already said
 * the opposite three paragraphs further down, so the spec contradicted itself.
 * The behaviour itself is pinned in `runbook-store.test.ts` ("is detection
 * only: refuses, writes nothing, and leaves the attempt pending", which asserts
 * the run is still owned afterwards). This guards the prose against drifting
 * back out of step with it.
 *
 * Both checks run against the `RECOVERY_REQUIRED` passage alone, not the whole
 * file: a repo-wide search would ban the phrase where it is legitimate and
 * would let the presence check pass on ownership prose belonging to some other
 * code.
 *
 * Named `*.repo-asset.test.ts` because it reads repo-root docs that are absent
 * from Stryker's package-scoped sandbox; see `jest.config.shared.js`.
 *
 * @module tests/output/docs-recovery-required-ownership.repo-asset
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Claims that the run has been let go. Matched loosely on purpose — the defect
 * is the claim, not one phrasing of it, so a reworded reprise is caught too.
 */
const RELEASED_CLAIMS = [/no process holds/i, /nothing holds (?:it|the run)/i, /no longer owned/i];

/** States that execution ownership outlives the refusal. */
const RETAINED_OWNERSHIP = /execution[- ]owned|execution ownership/i;

/** Read a doc, resolved against this test file rather than the cwd. */
function readDoc(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/**
 * The spec's `### Recovery required` section, up to the next heading.
 *
 * @param text - Full document text.
 * @returns The section body.
 */
function specSection(text: string): string {
  const start = text.indexOf('### Recovery required');
  if (start === -1) throw new Error('docs/spec/cli-output.md has no "### Recovery required"');
  const next = text.indexOf('\n### ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

/**
 * The reference's `RECOVERY_REQUIRED` table row.
 *
 * Anchored to the row so the plural `AGGREGATE_RECOVERY_REQUIRED` row — which
 * documents a different code with its own recovery semantics — is excluded.
 *
 * @param text - Full document text.
 * @returns The row's text.
 */
function referenceRow(text: string): string {
  const row = /^\| `RECOVERY_REQUIRED`.*$/m.exec(text);
  if (row === null) throw new Error('docs/reference/cli.md has no `RECOVERY_REQUIRED` row');
  return row[0];
}

/** The docs that describe `RECOVERY_REQUIRED` to users and agents. */
const DOCS = [
  {
    label: 'docs/spec/cli-output.md',
    passage: () => specSection(readDoc('../../../../docs/spec/cli-output.md')),
  },
  {
    label: 'docs/reference/cli.md',
    passage: () => referenceRow(readDoc('../../../../docs/reference/cli.md')),
  },
] as const;

describe('RECOVERY_REQUIRED docs state retained execution ownership', () => {
  it.each(DOCS)('$label does not claim the run was released', ({ label, passage }) => {
    const offenders = RELEASED_CLAIMS.filter((pattern) => pattern.test(passage())).map((pattern) =>
      pattern.toString(),
    );

    // The interrupted attempt leaves the run execution-owned — say that no live
    // process is ADVANCING it, not that nothing holds it.
    expect({ doc: label, releasedClaims: offenders }).toEqual({ doc: label, releasedClaims: [] });
  });

  it.each(DOCS)('$label says ownership is retained', ({ label, passage }) => {
    // Loose on wording, strict on presence: the distinction from
    // EXECUTION_IN_PROGRESS is the whole point of this passage, and stating it
    // without the ownership half is what produced the defect.
    expect({ doc: label, statesOwnership: RETAINED_OWNERSHIP.test(passage()) }).toEqual({
      doc: label,
      statesOwnership: true,
    });
  });

  // Both checks are only as good as their patterns, and both fail open — an
  // absent claim and a passage naming ownership. A fixture that each pattern
  // classifies correctly proves a green run against the real docs means
  // something.
  it('classifies the wording it exists to police', () => {
    const banned = 'Unlike `EXECUTION_IN_PROGRESS`, no process holds it and waiting will not help.';
    const accurate = 'No live process is advancing it, but the run stays execution-owned.';

    expect({
      bannedCaught: RELEASED_CLAIMS.some((pattern) => pattern.test(banned)),
      bannedLacksOwnership: RETAINED_OWNERSHIP.test(banned),
      accurateClean: RELEASED_CLAIMS.every((pattern) => !pattern.test(accurate)),
      accurateStatesOwnership: RETAINED_OWNERSHIP.test(accurate),
    }).toEqual({
      bannedCaught: true,
      bannedLacksOwnership: false,
      accurateClean: true,
      accurateStatesOwnership: true,
    });
  });
});
