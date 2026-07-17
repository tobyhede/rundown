import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
    // spy this exact instance — SessionService's constructor already takes it
    // (session-service.ts:230-235), so no DI change or prototype spy is needed.
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
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    const before = claim.lastProgressAt;

    // Any observable forward step in wall-clock time is enough; the timestamp is
    // sourced from the service, not injected (only `claimActivity` injects `now`).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await sessionService.recordClaimProgress(claimId);

    expect(result.kind).toBe('recorded');
    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    expect(Date.parse(stored.lastProgressAt)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(stored.lastProgressAt).not.toBe(before);
  });

  it('leaves updatedAt untouched', async () => {
    const { claimId, claim } = await sessionService.issueRunControlClaim(runId);
    await new Promise((resolve) => setTimeout(resolve, 5));

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

    await new Promise((resolve) => setTimeout(resolve, 5));
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
    // directly, but production never calls it directly — these two are its only
    // call sites (session-service.ts:335, :544). A record built correctly by a
    // function nobody calls that way satisfies nothing.
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
