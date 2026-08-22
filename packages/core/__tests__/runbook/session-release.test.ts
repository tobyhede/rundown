import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import {
  projectRunReleases,
  type ReleaseRole,
  type RunRelease,
} from '../../src/runbook/session-release.js';
import { assertRunId, type RunId } from '../../src/runbook/run-id.js';
import { assertClaimLookupKey } from '../../src/runbook/claim-id.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
import type { SessionData } from '../../src/runbook/state.js';

/**
 * The claim-retention policy, stated independently of the implementation.
 *
 * A `Record` keyed by {@link ReleaseRole} rather than a list, so adding a role
 * fails the type check *here* — at the one place a test has to say what the new
 * role is expected to do — instead of leaving a silently short role list and a
 * silently partial loop. It doubles as the role list every test below iterates,
 * so nothing else needs to enumerate the roles and nothing else can enumerate
 * them incompletely.
 *
 * The latent rule the codebase already followed at fifteen of sixteen sites: the
 * run the caller acted ON keeps its claim as terminal evidence; a run swept up
 * so the addressed run could close, or one being destroyed outright, does not.
 * `discarded` agrees with `collateral` today and is still a distinct arm — a
 * destroy path spelled `addressed` would retain claims over a run about to be
 * deleted.
 */
const CLAIMS_AFTER: Readonly<Record<ReleaseRole, 'retained' | 'revoked'>> = {
  addressed: 'retained',
  collateral: 'revoked',
  discarded: 'revoked',
};

/** Every {@link ReleaseRole}, exhaustive by construction of {@link CLAIMS_AFTER}. */
const ROLES = Object.keys(CLAIMS_AFTER) as readonly ReleaseRole[];

/** Distinct, canonical run ids. `n` must stay single-digit-hex wide. */
function runId(n: number): RunId {
  return assertRunId(`rd_${n.toString(16).repeat(32)}`);
}

/**
 * A claim controlling `run`, keyed distinctly so several can coexist.
 *
 * The index is zero-padded rather than repeated: `key.repeat(32).slice(0, 32)`
 * collides for any two indices whose hex digits repeat to the same 32 characters
 * (1 and 17, say), which would silently overwrite one claim with another and
 * leave a larger session asserting against fewer claims than it created.
 */
function claimFor(run: RunId, index: number) {
  return makeClaimRecord({
    claimKey: assertClaimLookupKey(`rdclk_${index.toString(16).padStart(32, '0')}`),
    controlledRunId: run,
  });
}

/** A session with `runs` stacked bottom-to-top and one claim over each. */
function sessionOver(runs: readonly RunId[]): SessionData {
  const claims: SessionData['claims'] = {};
  runs.forEach((run, index) => {
    const record = claimFor(run, index);
    claims[record.claimKey] = record;
  });
  return { defaultStack: [...runs], claims };
}

/** Whether any claim in `session` still controls `run`. */
function claimsOver(session: SessionData, run: RunId): boolean {
  return Object.values(session.claims).some((claim) => claim.controlledRunId === run);
}

describe('projectRunReleases', () => {
  describe.each(ROLES)('role %s', (role) => {
    const expected = CLAIMS_AFTER[role];

    it('removes the run from the default stack', () => {
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);

      projectRunReleases(session, [{ runId: b, role }]);

      expect(session.defaultStack).toEqual([a]);
    });

    it('removes every occurrence of the run from the default stack', () => {
      // A duplicate entry is reachable (§6.3 of the release-cause note refuses
      // to add UNIQUE(run_id) to session_stack), and a release must not leave
      // one behind for the next read to resolve as still-active.
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);
      session.defaultStack = [a, b, a];

      projectRunReleases(session, [{ runId: a, role }]);

      expect(session.defaultStack).toEqual([b]);
    });

    it(`leaves the run’s claims ${expected}`, () => {
      const a = runId(1);
      const session = sessionOver([a]);

      projectRunReleases(session, [{ runId: a, role }]);

      expect(claimsOver(session, a)).toBe(expected === 'retained');
    });

    it('never touches a claim over a different run', () => {
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);
      const other = Object.values(session.claims).find((c) => c.controlledRunId === b);

      projectRunReleases(session, [{ runId: a, role }]);

      expect(claimsOver(session, b)).toBe(true);
      expect(Object.values(session.claims)).toContainEqual(other);
    });

    it('clears the stash slot when it names the released run', () => {
      const a = runId(1);
      const session = sessionOver([a]);
      session.stashedRunbookId = a;

      projectRunReleases(session, [{ runId: a, role }]);

      expect(session.stashedRunbookId).toBeUndefined();
    });

    it('leaves a stash slot naming a different run alone', () => {
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);
      session.stashedRunbookId = b;

      projectRunReleases(session, [{ runId: a, role }]);

      expect(session.stashedRunbookId).toBe(b);
    });

    it('changes nothing on a second application', () => {
      // Idempotent in EFFECT. The projection reports nothing, so "already
      // released" is not a status a caller can read — it is the absence of a
      // further change.
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);
      session.stashedRunbookId = a;
      const releases: RunRelease[] = [{ runId: a, role }];

      projectRunReleases(session, releases);
      const afterFirst = structuredClone(session);
      projectRunReleases(session, releases);

      expect(session).toEqual(afterFirst);
    });

    it('is a no-op for a run the session does not target', () => {
      const session = sessionOver([runId(1)]);
      const before = structuredClone(session);

      projectRunReleases(session, [{ runId: runId(9), role }]);

      expect(session).toEqual(before);
    });
  });

  it('applies every member of a mixed batch', () => {
    const [a, b, c] = [runId(1), runId(2), runId(3)];
    const session = sessionOver([a, b, c]);

    projectRunReleases(session, [
      { runId: a, role: 'addressed' },
      { runId: b, role: 'collateral' },
      { runId: c, role: 'discarded' },
    ]);

    expect(session.defaultStack).toEqual([]);
    expect(claimsOver(session, a)).toBe(true);
    expect(claimsOver(session, b)).toBe(false);
    expect(claimsOver(session, c)).toBe(false);
  });

  it('accepts an empty batch', () => {
    // `prune` releases whatever it pruned, which can be nothing. An empty batch
    // is a committed no-op, not a refusal.
    const session = sessionOver([runId(1)]);
    const before = structuredClone(session);

    projectRunReleases(session, []);

    expect(session).toEqual(before);
  });

  it('mutates the caller’s session object in place, synchronously', () => {
    // Load-bearing, and not merely "pure inside a mutateState build callback":
    // several dispositions reach this projection through a synchronous in-place
    // session callback that accepts nothing else.
    const a = runId(1);
    const session = sessionOver([a]);
    const before = session;

    projectRunReleases(session, [{ runId: a, role: 'addressed' }]);

    expect(session).toBe(before);
    expect(session.defaultStack).toEqual([]);
  });

  describe('duplicate run ids', () => {
    it('rejects a batch naming the same run twice', () => {
      // One run cannot be released for two reasons in one batch. A caller that
      // built such a batch derived at least one of the roles from something
      // other than what it did, which is the bug class the roles replaced.
      const a = runId(1);
      const session = sessionOver([a]);

      expect(() => {
        projectRunReleases(session, [
          { runId: a, role: 'addressed' },
          { runId: a, role: 'collateral' },
        ]);
      }).toThrow(a);
    });

    it('rejects a repeat even when both members agree on the role', () => {
      const a = runId(1);
      const session = sessionOver([a]);

      expect(() => {
        projectRunReleases(session, [
          { runId: a, role: 'addressed' },
          { runId: a, role: 'addressed' },
        ]);
      }).toThrow();
    });

    it('leaves the session untouched when it rejects', () => {
      // Validation runs over the WHOLE batch before the first member is
      // applied, so a rejected batch is not half-projected. Ordering the
      // duplicate last is what makes this fail if validation were interleaved.
      const [a, b] = [runId(1), runId(2)];
      const session = sessionOver([a, b]);
      const before = structuredClone(session);

      expect(() => {
        projectRunReleases(session, [
          { runId: a, role: 'discarded' },
          { runId: b, role: 'discarded' },
          { runId: b, role: 'discarded' },
        ]);
      }).toThrow();

      expect(session).toEqual(before);
    });
  });
});

/**
 * Permute `items` by a seed array, Fisher-Yates.
 *
 * Reversal alone is two of up to 120 orderings, and cross-talk that depends on
 * an interior ordering rather than a full reversal survives it. Driving the
 * shuffle from generated seeds tests the invariant the properties actually
 * state.
 */
function permute<T>(items: readonly T[], seeds: readonly number[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = seeds[i % seeds.length] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('projectRunReleases order-independence (property)', () => {
  const role = fc.constantFrom<ReleaseRole>(...ROLES);
  const seeds = fc.array(fc.nat(), { minLength: 5, maxLength: 5 });
  const batch = fc.tuple(
    fc.uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 2, maxLength: 5 }),
    fc.array(role, { minLength: 5, maxLength: 5 }),
  );

  /** Runs, and one release per run, from a generated batch. */
  function plan([ids, roles]: [readonly number[], readonly ReleaseRole[]]): {
    runs: RunId[];
    releases: RunRelease[];
  } {
    const runs = ids.map(runId);
    return {
      runs,
      releases: runs.map((run, index) => ({ runId: run, role: roles[index % roles.length] })),
    };
  }

  it('gives a member the same outcome under any permutation of the others', () => {
    // The invariant that lets the disposition table widen to a per-claim
    // decision later without touching a caller: a run's disposition depends
    // only on its OWN role, never on ordering and never on the other members of
    // the batch.
    fc.assert(
      fc.property(batch, fc.nat(), seeds, (generated, pick, order) => {
        const { runs, releases } = plan(generated);
        const subject = releases[pick % releases.length];

        const apply = (batched: readonly RunRelease[]): SessionData => {
          const session = sessionOver(runs);
          projectRunReleases(session, batched);
          return session;
        };

        const forward = apply(releases);
        const reversed = apply([...releases].reverse());
        const shuffled = apply(permute(releases, order));

        expect(claimsOver(reversed, subject.runId)).toBe(claimsOver(forward, subject.runId));
        expect(claimsOver(shuffled, subject.runId)).toBe(claimsOver(forward, subject.runId));
        expect(claimsOver(forward, subject.runId)).toBe(CLAIMS_AFTER[subject.role] === 'retained');
      }),
    );
  });

  it('reaches the same whole session under any permutation', () => {
    fc.assert(
      fc.property(batch, seeds, (generated, order) => {
        const { runs, releases } = plan(generated);

        const apply = (batched: readonly RunRelease[]): SessionData => {
          const session = sessionOver(runs);
          projectRunReleases(session, batched);
          return session;
        };

        expect(apply([...releases].reverse())).toEqual(apply(releases));
        expect(apply(permute(releases, order))).toEqual(apply(releases));
      }),
    );
  });

  it('reaches the same whole session on reapplication', () => {
    fc.assert(
      fc.property(batch, (generated) => {
        const { runs, releases } = plan(generated);
        const session = sessionOver(runs);

        projectRunReleases(session, releases);
        const once = structuredClone(session);
        projectRunReleases(session, releases);

        expect(session).toEqual(once);
      }),
    );
  });
});
