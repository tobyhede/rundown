import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  RELEASE_ROLES,
  claimDisposition,
  projectRunRelease,
  type ReleaseRole,
  type RunRelease,
} from '../../src/runbook/session-release.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
import type { SessionData } from '../../src/runbook/state.js';

/** Distinct, canonical run ids. `n` must stay single-digit-hex wide. */
function runId(n: number): RunId {
  return assertRunId(`rd_${n.toString(16).repeat(32)}`);
}

/** A claim controlling `run`, keyed distinctly so several can coexist. */
function claimFor(run: RunId, key: string) {
  return makeClaimRecord({
    claimKey: assertClaimLookupKey(`rdclk_${key.repeat(32).slice(0, 32)}`),
    controlledRunId: run,
  });
}

/** A session with `runs` stacked bottom-to-top and one claim over each. */
function sessionOver(runs: readonly RunId[]): SessionData {
  const claims: SessionData['claims'] = {};
  runs.forEach((run, index) => {
    const record = claimFor(run, index.toString(16));
    claims[record.claimKey] = record;
  });
  return { defaultStack: [...runs], claims };
}

describe('claimDisposition', () => {
  // The latent rule the codebase already followed at fifteen of sixteen sites,
  // stated once: the run the caller acted ON keeps its claim as terminal
  // evidence; a run swept up so the addressed run could close, or one being
  // destroyed outright, does not.
  it('retains an addressed run’s claims as terminal evidence', () => {
    expect(claimDisposition('addressed')).toBe('retain-as-terminal-evidence');
  });

  it('revokes a collateral run’s claims', () => {
    expect(claimDisposition('collateral')).toBe('revoke');
  });

  it('revokes a discarded run’s claims', () => {
    // Distinct from `collateral` despite agreeing today: a destroy path must
    // never be spelled `addressed`, which would retain claims for a run that is
    // being deleted.
    expect(claimDisposition('discarded')).toBe('revoke');
  });

  it('is total over every role', () => {
    for (const role of RELEASE_ROLES) {
      expect(['retain-as-terminal-evidence', 'revoke']).toContain(claimDisposition(role));
    }
  });

  it('names exactly the three roles', () => {
    expect([...RELEASE_ROLES]).toEqual(['addressed', 'collateral', 'discarded']);
  });
});

describe('projectRunRelease', () => {
  it('removes the run from the default stack', () => {
    const [a, b] = [runId(1), runId(2)];
    const session = sessionOver([a, b]);

    expect(projectRunRelease(session, { runId: b, role: 'addressed' })).toBe(true);

    expect(session.defaultStack).toEqual([a]);
  });

  it('removes every occurrence of the run from the default stack', () => {
    // A duplicate entry is reachable (§6.3 of the release-cause note refuses to
    // add UNIQUE(run_id) to session_stack), and a release must not leave one
    // behind for the next read to resolve as still-active.
    const [a, b] = [runId(1), runId(2)];
    const session = sessionOver([a, b]);
    session.defaultStack = [a, b, a];

    projectRunRelease(session, { runId: a, role: 'addressed' });

    expect(session.defaultStack).toEqual([b]);
  });

  it('leaves an addressed run’s claims in the session', () => {
    const a = runId(1);
    const session = sessionOver([a]);
    const key = Object.keys(session.claims)[0];

    projectRunRelease(session, { runId: a, role: 'addressed' });

    expect(session.claims[key]).toBeDefined();
    expect(session.claims[key].controlledRunId).toBe(a);
  });

  it.each(['collateral', 'discarded'] as const)('deletes a %s run’s claims', (role) => {
    const a = runId(1);
    const session = sessionOver([a]);

    projectRunRelease(session, { runId: a, role });

    expect(session.claims).toEqual({});
  });

  it('never touches a claim over a different run', () => {
    const [a, b] = [runId(1), runId(2)];
    const session = sessionOver([a, b]);
    const other = Object.values(session.claims).find((c) => c.controlledRunId === b);

    projectRunRelease(session, { runId: a, role: 'discarded' });

    expect(Object.values(session.claims)).toEqual([other]);
  });

  it('clears the stash slot when it names the released run', () => {
    const a = runId(1);
    const session = sessionOver([a]);
    session.stashedRunbookId = a;

    expect(projectRunRelease(session, { runId: a, role: 'addressed' })).toBe(true);

    expect(session.stashedRunbookId).toBeUndefined();
  });

  it('leaves a stash slot naming a different run alone', () => {
    const [a, b] = [runId(1), runId(2)];
    const session = sessionOver([a, b]);
    session.stashedRunbookId = b;

    projectRunRelease(session, { runId: a, role: 'addressed' });

    expect(session.stashedRunbookId).toBe(b);
  });

  it('reports false when the run appears nowhere in the session', () => {
    const session = sessionOver([runId(1)]);

    expect(projectRunRelease(session, { runId: runId(9), role: 'addressed' })).toBe(false);
  });

  it('reports true when only the default stack matched', () => {
    // Stack membership alone is enough to have "found" the run. Without this
    // the other cases all carry a claim or a stash entry as well, so the stack
    // arm of the answer is never the one deciding it.
    const a = runId(1);
    const session: SessionData = { defaultStack: [a], claims: {} };

    expect(projectRunRelease(session, { runId: a, role: 'addressed' })).toBe(true);

    expect(session.defaultStack).toEqual([]);
  });

  it('reports true when only a retained claim matched', () => {
    // The retained claim still counts as "found". Preserved deliberately from
    // the primitive this replaces: a repeated `addressed` release reports
    // found, not not-found, because the claim it retained is still there.
    const a = runId(1);
    const session = sessionOver([a]);
    session.defaultStack = [];

    expect(projectRunRelease(session, { runId: a, role: 'addressed' })).toBe(true);
  });

  it('changes nothing on a second application', () => {
    const [a, b] = [runId(1), runId(2)];
    for (const role of ['addressed', 'collateral', 'discarded'] as const) {
      const session = sessionOver([a, b]);
      session.stashedRunbookId = a;
      const release: RunRelease = { runId: a, role };

      projectRunRelease(session, release);
      const afterFirst = structuredClone(session);
      projectRunRelease(session, release);

      expect(session).toEqual(afterFirst);
    }
  });

  it('mutates the caller’s session object in place, synchronously', () => {
    // Load-bearing, and not merely "pure inside a mutateState build callback":
    // six dispositions reach this projection through a synchronous in-place
    // session callback that accepts nothing else.
    const a = runId(1);
    const session = sessionOver([a]);
    const before = session;

    const result = projectRunRelease(session, { runId: a, role: 'addressed' });

    expect(session).toBe(before);
    expect(typeof result).toBe('boolean');
  });
});

describe('projectRunRelease order-independence (property)', () => {
  const role = fc.constantFrom<ReleaseRole>('addressed', 'collateral', 'discarded');

  it('gives a member the same outcome under any permutation of the others', () => {
    // The invariant that lets `claimDisposition(role)` widen to
    // `claimDisposition(role, claim)` later without touching a caller: a run's
    // disposition depends only on its OWN role, never on ordering and never on
    // the other members of the batch.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 2, maxLength: 5 }),
        fc.array(role, { minLength: 5, maxLength: 5 }),
        fc.nat(),
        (ids, roles, pick) => {
          const runs = ids.map(runId);
          const releases: RunRelease[] = runs.map((run, index) => ({
            runId: run,
            role: roles[index % roles.length],
          }));
          const subject = releases[pick % releases.length];

          const apply = (order: readonly RunRelease[]): SessionData => {
            const session = sessionOver(runs);
            for (const release of order) projectRunRelease(session, release);
            return session;
          };

          const forward = apply(releases);
          const reversed = apply([...releases].reverse());

          // The subject's own claim survives, or does not, identically.
          const survives = (session: SessionData): boolean =>
            Object.values(session.claims).some((c) => c.controlledRunId === subject.runId);

          expect(survives(reversed)).toBe(survives(forward));
          expect(survives(forward)).toBe(
            claimDisposition(subject.role) === 'retain-as-terminal-evidence',
          );
        },
      ),
    );
  });

  it('reaches the same whole session under any permutation', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 2, maxLength: 5 }),
        fc.array(role, { minLength: 5, maxLength: 5 }),
        (ids, roles) => {
          const runs = ids.map(runId);
          const releases: RunRelease[] = runs.map((run, index) => ({
            runId: run,
            role: roles[index % roles.length],
          }));

          const apply = (order: readonly RunRelease[]): SessionData => {
            const session = sessionOver(runs);
            for (const release of order) projectRunRelease(session, release);
            return session;
          };

          expect(apply([...releases].reverse())).toEqual(apply(releases));
        },
      ),
    );
  });
});
