import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { SessionLock } from '../../src/runbook/session-lock.js';
import { FileLockTimeoutError } from '../../src/runbook/file-lock.js';
import { sessionLockPath } from '../../src/paths.js';
import { claimActivity, DEFAULT_IDLE_AFTER_MS } from '../../src/runbook/claim-activity.js';
import {
  CLAIM_ID_PREFIX,
  assertClaimId,
  type ClaimId,
  type ClaimLookupKey,
} from '../../src/runbook/claim-id.js';
import type { Runbook, RunId, Step } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { linkageFor, assertClaimed } from './claim-test-helpers.js';

const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
const mockRunbook: Runbook = {
  title: 'Test Runbook',
  description: 'A test',
  steps: mockSteps,
};

/**
 * Build a bearer id for an existing claim key whose secret segment is WRONG.
 *
 * Constructed literally from the layout `parseClaimBearer` expects
 * (`rdclm_<32 lowercase hex>_<43 base64url chars>`, claim-id.ts) so the id parses
 * and resolves to a real claim key, but fails `verifyClaimSecret`. That is the
 * only way to exercise the "presented a valid-looking bearer that does not verify"
 * path — a syntactically invalid id would be rejected earlier, by the parser.
 *
 * @param claimKey - Persisted claim lookup key (`rdclk_<32 hex>`).
 * @returns A parseable bearer id carrying a non-matching secret.
 */
function forgeBearerWithWrongSecret(claimKey: ClaimLookupKey): ClaimId {
  const lookup = claimKey.slice('rdclk_'.length);
  return assertClaimId(`${CLAIM_ID_PREFIX}${lookup}_${'z'.repeat(43)}`);
}

/**
 * Build a service whose clock returns each supplied instant in turn.
 *
 * The last value repeats once exhausted, so a test states only the steps it cares
 * about. A scripted clock rather than jest's fake timers: the seam is a plain
 * `now: () => string`, and faking globally would reach the suites that deliberately
 * keep the real clock.
 *
 * @param manager - State manager the service persists through.
 * @param instants - ISO timestamps to return, in order.
 * @returns A SessionService reading those instants instead of the wall clock.
 */
function serviceWithClock(
  manager: RunbookStateManager,
  instants: readonly string[],
): SessionService {
  let index = 0;
  return new SessionService(manager, undefined, () => {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  });
}

describe('SessionService.recordClaimProgress (#519)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionLock: SessionLock;
  let sessionService: SessionService;
  let runId: RunId;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'claim-progress-test-'));
    manager = new RunbookStateManager(testDir);
    // The lock is constructed here and injected so the acquisition-failure case can
    // spy this exact instance — SessionService's constructor already takes it, so no
    // prototype spy is needed. The clock is left at its wall-clock default: these
    // cases are about WHAT is recorded, not WHEN, and the suite below owns the
    // clock-dependent behaviour.
    sessionLock = new SessionLock(testDir);
    sessionService = new SessionService(manager, sessionLock);
    const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
      runbookPath: 'test.md',
    });
    runId = state.id;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('refreshes lastProgressAt on the presented claim', async () => {
    // The one case here that needs time to MOVE, so it scripts the clock rather
    // than sleeping on the real one: a 5ms sleep bought a timestamp this asserts is
    // different, at the cost of a real-time wait and a race against clock
    // granularity. The injected instants make the step exact.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:05.000Z', // progress
    ]);
    const { claimId, claim } = await service.issueRunControlClaim(runId);
    const before = claim.lastProgressAt;

    const result = await service.recordClaimProgress(claimId);

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    // The WHOLE recorded contract, not just `kind`: `claimKey` and
    // `lastProgressAt` are the fields plan 2's call sites consume, and asserting
    // only `kind` leaves them pinned by nothing — a recorder that reported the
    // wrong claim key, or a timestamp that disagreed with what it persisted,
    // would pass. `toEqual` against the PERSISTED record is what ties the
    // returned value to the write it claims to describe.
    expect(result).toEqual({
      kind: 'recorded',
      claimKey: claim.claimKey,
      lastProgressAt: stored.lastProgressAt,
    });
    expect(Date.parse(stored.lastProgressAt)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(stored.lastProgressAt).not.toBe(before);
  });

  it('leaves updatedAt untouched', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);

    await sessionService.recordClaimProgress(claimId);

    // `updatedAt` means "this record was last written" and keeps that meaning.
    // Conflating the two would let an unrelated future claim write silently
    // refresh the idle clock, so a dead claim would read as live.
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey].updatedAt).toBe(claim.updatedAt);
  });

  it('refreshes ONLY the presented claim, never another (AC5)', async () => {
    const stateB = await manager.create({ source: 'project', path: 'other.md' }, mockRunbook, {
      runbookPath: 'other.md',
    });
    const { claimId: claimA } = await sessionService.issueRunControlClaim(runId);
    const { claim: recordB } = await sessionService.issueRunControlClaim(stateB.id);
    const beforeB = recordB.lastProgressAt;

    await sessionService.recordClaimProgress(claimA);

    // A parent cannot vouch for a child's liveness and must not appear to.
    const session = await manager.loadSession();
    expect(session.claims[recordB.claimKey].lastProgressAt).toBe(beforeB);
  });

  it('records nothing for a bearer whose secret does not verify', async () => {
    const { claim } = await sessionService.issueRunControlClaim(runId);
    const before = claim.lastProgressAt;
    const forged = forgeBearerWithWrongSecret(claim.claimKey);

    const result = await sessionService.recordClaimProgress(forged);

    expect(result.kind).toBe('no-claim');
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey].lastProgressAt).toBe(before);
  });

  it('records nothing for a claim key that is not in the session', async () => {
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    await sessionService.releaseRunbook(runId);

    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('no-claim');
  });

  it('never throws when the session write fails — it returns record-failed (AC7)', async () => {
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const saveSpy = jest.spyOn(manager, 'saveSession').mockRejectedValue(new Error('disk on fire'));

    // The mutation this recording follows is ALREADY committed. A bookkeeping
    // hiccup must never surface as a failure, or it would mask the committed
    // result (RD-102). The method is total by construction.
    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    saveSpy.mockRestore();
  });

  it('never throws when the bearer is syntactically invalid', async () => {
    // parseClaimBearer throws on a malformed id; recordClaimProgress swallows it.
    const result = await sessionService.recordClaimProgress('not-a-claim-id' as ClaimId);
    expect(result.kind).toBe('record-failed');
  });

  it('never throws when the session LOCK cannot be acquired (AC7)', async () => {
    // The `try` wraps `withLock`, not just its callback — this is the case that
    // pins that choice, and it is the only one of the three that exercises the
    // OUTER path. The other two throw from INSIDE the callback (saveSession
    // rejects; parseClaimBearer throws), so narrowing the try to the body would
    // keep both of them green while silently breaking the documented contract.
    //
    // Operationally the most likely of the three: SessionLock retries with
    // jittered backoff bounded to 5s before failing, so a contended session is a
    // real source of acquisition failure — and it must cost one under-reported
    // progress mark, never a failed `rundown pass` whose mutation already committed.
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const acquireSpy = jest
      .spyOn(sessionLock, 'acquire')
      .mockRejectedValue(new FileLockTimeoutError(sessionLockPath(testDir)));

    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    acquireSpy.mockRestore();
  });

  it('never throws when loading the session fails (AC7)', async () => {
    // The fourth throw site, and the one most likely to fire in practice: THIS VERY
    // PLAN makes `loadSession` throw on a class of sessions it previously accepted
    // (the structural guard). A recorder that survives a save failure but dies on a
    // load failure would surface as a failed `rundown pass` whose mutation had
    // already committed — the exact RD-102 defect, arriving through the one door
    // this plan just installed.
    const { claimId } = await sessionService.issueRunControlClaim(runId);
    const loadSpy = jest
      .spyOn(manager, 'loadSession')
      .mockRejectedValue(new Error('Legacy claim record format detected.'));

    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('record-failed');
    loadSpy.mockRestore();
  });

  it('writes a lastProgressAt that claimActivity can read back (seam round-trip)', async () => {
    // The ONLY end-to-end evidence available in plan 1: claimActivity derives
    // activity and recordClaimProgress records it, but nothing else in this plan
    // ever connects the two, and the wiring is a separate PR. If
    // `recordClaimProgress` wrote a format `claimActivity` could not parse, EVERY
    // other test here would still pass — and the failure would surface as RD-824 on
    // a healthy claim, i.e. a live child libelled as corrupt, only once a surface
    // existed to see it on.
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const result = await sessionService.recordClaimProgress(claimId);
    expect(result.kind).toBe('recorded');

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    const activity = claimActivity(stored, new Date(), DEFAULT_IDLE_AFTER_MS);
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBeLessThan(1_000);
  });

  it('sets lastProgressAt to issuedAt on BOTH real minting paths (AC1)', async () => {
    // AC1 says "set at claim creation". The schema suite tests `createClaimRecord`
    // directly, but production never calls it directly — `mintRunControlClaim` and
    // `claimRunbook` are its only call sites. A record built correctly by a function
    // nobody calls that way satisfies nothing.
    const { claim: runControl } = await sessionService.issueRunControlClaim(runId);
    expect(runControl.lastProgressAt).toBe(runControl.issuedAt);

    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const linkage = linkageFor(parent.id, 'a');
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkage,
    });
    await sessionService.pushRunbook(parent.id);
    const delegated = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

    expect(delegated.claim.lastProgressAt).toBe(delegated.claim.issuedAt);
  });
});

// Bounded so every draw is a valid ISO instant, matching the arbitrary in
// claim-activity.properties.test.ts.
const epochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });

describe('recordClaimProgress under backward wall-clock movement (#611 review)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let runId: RunId;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'claim-progress-clock-test-'));
    manager = new RunbookStateManager(testDir);
    const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
      runbookPath: 'test.md',
    });
    runId = state.id;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('persists the injected clock verbatim, never the later of the two', async () => {
    // The write records what the clock said. It does NOT clamp to
    // `max(existing, now)`: see recordClaimProgress's TSDoc for why that clamp is
    // the AC6 fail-open wearing a safety hat. This is the direct expression of
    // that contract — a clamp makes the second write a no-op and fails here.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:30.000Z', // progress, forward
      '2026-07-17T10:00:05.000Z', // progress, AFTER the clock steps back 2h
    ]);
    const { claimId, claim } = await service.issueRunControlClaim(runId);

    await service.recordClaimProgress(claimId);
    const result = await service.recordClaimProgress(claimId);

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    expect(stored.lastProgressAt).toBe('2026-07-17T10:00:05.000Z');
    // The returned value must agree with the write it describes, backward clock or
    // not — a clamp that kept the older timestamp but reported `now` would split
    // the two and leave every caller reporting a progress mark that isn't on disk.
    expect(result).toEqual({
      kind: 'recorded',
      claimKey: claim.claimKey,
      lastProgressAt: '2026-07-17T10:00:05.000Z',
    });
  });

  it('reports a DEAD claim idle after a sustained backward jump — the case a max-clamp would mask', async () => {
    // THE load-bearing test for declining the review's clamp.
    //
    // Clock steps back 2h; the child progresses once at 10:00:05 and then DIES.
    // Recording verbatim leaves lastProgressAt=10:00:05, so a reader at 11:30 sees
    // 1h29m idle and says so — correct, and the whole point of the feature.
    //
    // Under `max(existing, now)` the record would stay pinned at 12:00:30, and
    // claimActivity's `Math.max(0, now - lastProgress)` would clamp the negative
    // difference to ZERO: a dead claim reading `idle: false` for the entire
    // excursion, unable to self-heal precisely because nothing is happening. That
    // is the AC6 fail-open (claim-activity.ts:129-131) arriving through the write
    // path instead of the parser.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:30.000Z', // progress, pre-jump
      '2026-07-17T10:00:05.000Z', // progress, post-jump — then the child dies
    ]);
    const { claimId, claim } = await service.issueRunControlClaim(runId);
    await service.recordClaimProgress(claimId);
    await service.recordClaimProgress(claimId);

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    const activity = claimActivity(
      stored,
      new Date('2026-07-17T11:30:00.000Z'),
      DEFAULT_IDLE_AFTER_MS,
    );

    expect(activity.idle).toBe(true);
    expect(activity.idleFor).toBe(89 * 60 * 1000 + 55 * 1000);
  });

  it('reads not-idle when reader and writer move together', async () => {
    // Why the review's premise does not hold: the parent's `rundown status` and the
    // child's `rundown pass` are processes on the SAME host — the lock design
    // requires it (stale reclamation is `kill(pid, 0)`, meaningless across hosts),
    // and session.json is a local file. A backward step moves both, so an older
    // lastProgressAt is the CORRECT answer and no premature idle occurs.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T10:00:05.000Z', // progress, post-jump
    ]);
    const { claimId, claim } = await service.issueRunControlClaim(runId);
    await service.recordClaimProgress(claimId);

    const session = await manager.loadSession();
    const activity = claimActivity(
      session.claims[claim.claimKey],
      new Date('2026-07-17T10:00:10.000Z'), // reader on the same stepped-back clock
      DEFAULT_IDLE_AFTER_MS,
    );

    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBe(5_000);
  });

  it('persists exactly the injected clock for ANY ordering of two instants', async () => {
    // The three examples above kill the specific 2h-backward clamp. This kills the
    // GENERAL law they are instances of — "the write records, it does not
    // interpret" — and so also kills the subtler variants an example suite misses:
    // a clamp that only engages past some delta, or only on a large jump. Both
    // instants are drawn independently, so roughly half the runs step backward.
    await fc.assert(
      fc.asyncProperty(epochMs, epochMs, async (mintAt, progressAt) => {
        const mint = new Date(mintAt).toISOString();
        const progress = new Date(progressAt).toISOString();
        const service = serviceWithClock(manager, [mint, progress]);
        const { claimId, claim } = await service.issueRunControlClaim(runId);

        const result = await service.recordClaimProgress(claimId);

        const session = await manager.loadSession();
        expect(session.claims[claim.claimKey].lastProgressAt).toBe(progress);
        expect(result).toEqual({
          kind: 'recorded',
          claimKey: claim.claimKey,
          lastProgressAt: progress,
        });
      }),
      // Each run does real filesystem work under a shared temp dir; 50 runs is
      // ample to cover both orderings without making the suite a bottleneck.
      { numRuns: 50 },
    );
  });
});
