import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fc from 'fast-check';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedStep } from '@rundown-org/parser';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { RunbookCompletionService } from '../../src/runbook/completion-service.js';
import {
  RunbookLifecycleCommandService,
  type LifecycleTerminalReleasePolicy,
} from '../../src/runbook/lifecycle-command-service.js';
import { DelegationLock } from '../../src/runbook/delegation-lock.js';
import { CompletionLock } from '../../src/runbook/completion-lock.js';
import { claimActivity, DEFAULT_IDLE_AFTER_MS } from '../../src/runbook/claim-activity.js';
import {
  CLAIM_ID_PREFIX,
  assertClaimId,
  type ClaimId,
  type ClaimLookupKey,
} from '../../src/runbook/claim-id.js';
import type { Runbook, RunId, Step } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import {
  linkageFor,
  assertClaimed,
  claimLiveDelegation,
  unwrapSessionMutation,
} from './claim-test-helpers.js';

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
  return new SessionService(manager, () => {
    const value = instants[Math.min(index, instants.length - 1)];
    index += 1;
    return value;
  });
}

async function issueRunControlClaim(service: SessionService, runId: RunId) {
  return unwrapSessionMutation(await service.issueRunControlClaim(runId));
}

describe('SessionService.recordClaimSeen (#519)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;
  let runId: RunId;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'claim-seen-test-'));
    manager = new RunbookStateManager(testDir);
    // The clock is left at its wall-clock default: these cases are about WHAT is
    // recorded, not WHEN, and the suite below owns the clock-dependent behaviour.
    sessionService = new SessionService(manager);
    const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
      runbookPath: 'test.md',
    });
    runId = state.id;
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('refreshes lastSeenAt on the presented claim', async () => {
    // The one case here that needs time to MOVE, so it scripts the clock rather
    // than sleeping on the real one: a 5ms sleep bought a timestamp this asserts is
    // different, at the cost of a real-time wait and a race against clock
    // granularity. The injected instants make the step exact.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:05.000Z', // observation
    ]);
    const { claimId, claim } = await issueRunControlClaim(service, runId);
    const before = claim.lastSeenAt;

    const result = await service.recordClaimSeen(claimId);

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    // The WHOLE recorded contract, not just `kind`: `claimKey` and
    // `lastSeenAt` are the fields plan 2's call sites consume, and asserting
    // only `kind` leaves them pinned by nothing — a recorder that reported the
    // wrong claim key, or a timestamp that disagreed with what it persisted,
    // would pass. `toEqual` against the PERSISTED record is what ties the
    // returned value to the write it claims to describe.
    expect(result).toEqual({
      kind: 'recorded',
      claimKey: claim.claimKey,
      lastSeenAt: stored.lastSeenAt,
    });
    expect(Date.parse(stored.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before));
    expect(stored.lastSeenAt).not.toBe(before);
  });

  it('leaves updatedAt untouched', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);

    await sessionService.recordClaimSeen(claimId);

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
    const { claimId: claimA } = await issueRunControlClaim(sessionService, runId);
    const { claim: recordB } = await issueRunControlClaim(sessionService, stateB.id);
    const beforeB = recordB.lastSeenAt;

    await sessionService.recordClaimSeen(claimA);

    // A parent cannot vouch for a child's liveness and must not appear to.
    const session = await manager.loadSession();
    expect(session.claims[recordB.claimKey].lastSeenAt).toBe(beforeB);
  });

  it('records nothing for a bearer whose secret does not verify', async () => {
    const { claim } = await issueRunControlClaim(sessionService, runId);
    const before = claim.lastSeenAt;
    const forged = forgeBearerWithWrongSecret(claim.claimKey);

    const result = await sessionService.recordClaimSeen(forged);

    expect(result.kind).toBe('no-claim');
    const session = await manager.loadSession();
    expect(session.claims[claim.claimKey].lastSeenAt).toBe(before);
  });

  it('records nothing for a claim key that is not in the session', async () => {
    const { claimId } = await issueRunControlClaim(sessionService, runId);
    await sessionService.releaseRunbook(runId);

    const result = await sessionService.recordClaimSeen(claimId);

    expect(result.kind).toBe('no-claim');
  });

  it('never throws when the session write fails — it returns record-failed (AC7)', async () => {
    const { claimId } = await issueRunControlClaim(sessionService, runId);
    // The OUTER path: the `try` wraps the whole `mutateSession` call, not just its
    // callback. Under the store, opening the transaction, reading the session, and
    // committing all live outside the callback, so a failure at any of them lands
    // here — the case the lock-era "cannot acquire the session lock" and "loading
    // the session fails" tests used to split between them.
    //
    // This best-effort recording precedes the subsequent mutation. A bookkeeping
    // hiccup must neither prevent that mutation nor mask its eventual outcome
    // (RD-102). The method is total by construction.
    const mutateSpy = jest
      .spyOn(manager, 'mutateSession')
      .mockRejectedValue(new Error('disk on fire'));

    const result = await sessionService.recordClaimSeen(claimId);

    expect(result.kind).toBe('record-failed');
    mutateSpy.mockRestore();
  });

  it('never throws when the bearer is syntactically invalid', async () => {
    // parseClaimBearer throws on a malformed id; recordClaimSeen swallows it.
    const result = await sessionService.recordClaimSeen('not-a-claim-id' as ClaimId);
    expect(result.kind).toBe('record-failed');
  });

  it('writes a lastSeenAt that claimActivity can read back (seam round-trip)', async () => {
    // The ONLY end-to-end evidence available in plan 1: claimActivity derives
    // activity and recordClaimSeen records it, but nothing else in this plan
    // ever connects the two, and the wiring is a separate PR. If
    // `recordClaimSeen` wrote a format `claimActivity` could not parse, EVERY
    // other test here would still pass — and the failure would surface as RD-824 on
    // a healthy claim, i.e. a live child libelled as corrupt, only once a surface
    // existed to see it on.
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const result = await sessionService.recordClaimSeen(claimId);
    expect(result.kind).toBe('recorded');

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    const activity = claimActivity(stored, new Date(), DEFAULT_IDLE_AFTER_MS);
    expect(activity.idle).toBe(false);
    expect(activity.idleFor).toBeLessThan(1_000);
  });

  it('sets lastSeenAt to issuedAt on BOTH real minting paths (AC1)', async () => {
    // AC1 says "set at claim creation". The schema suite tests `createClaimRecord`
    // directly, but production never calls it directly — `mintRunControlClaim` and
    // `claimRunbook` are its only call sites. A record built correctly by a function
    // nobody calls that way satisfies nothing.
    const { claim: runControl } = await issueRunControlClaim(sessionService, runId);
    expect(runControl.lastSeenAt).toBe(runControl.issuedAt);

    const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
      runbookPath: 'parent.md',
    });
    const linkage = linkageFor(parent.id, 'a');
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkage,
    });
    await sessionService.pushRunbook(parent.id);
    const delegated = assertClaimed(
      await claimLiveDelegation(sessionService, manager, child.id, linkage),
    );

    expect(delegated.claim.lastSeenAt).toBe(delegated.claim.issuedAt);
  });
});

describe('claim-seen recording across mutating seams (#519)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;
  let actorService: RunbookActorService;
  let runId: RunId;

  /** Two base steps so a `pass` on step 1 CONTINUEs rather than driving terminal. */
  const seamSteps: readonly ResolvedStep[] = [
    {
      kind: 'base',
      name: '1',
      description: 'one',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
    {
      kind: 'base',
      name: '2',
      description: 'two',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
  ];
  const startingStep = '1';
  const releasePolicy: LifecycleTerminalReleasePolicy = {
    onComplete: { releaseRunbook: true },
    onStopped: { releaseRunbook: true },
  };

  beforeEach(async () => {
    // Mirrors the plain-seam wiring in lifecycle-command-service.test.ts's
    // `beforeEach` — the same real services, not doubles: these cases assert that
    // a COMMITTED mutation records, which only a real seam can produce.
    testDir = await mkdtemp(join(tmpdir(), 'claim-seen-seam-'));
    manager = new RunbookStateManager(testDir);
    actorService = new RunbookActorService(manager);
    const lifecycleService = new ExecutionLifecycleService(manager);
    const completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    sessionService = new SessionService(manager);
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      lifecycleService,
      completionService,
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      deleteRun: async (id) => {
        await manager.delete(id);
      },
      loadSteps: () => seamSteps,
      resolveChildRunbook: async () => undefined,
      persistIssuedSubstep: async () => {},
      findDelegationByToken: async () => undefined,
      delegationLock: new DelegationLock(testDir),
      completionLock: new CompletionLock(testDir),
    });
    const state = await manager.create({ source: 'project', path: 'seam.md' }, mockRunbook, {
      runbookPath: 'seam.md',
    });
    runId = state.id;
    await sessionService.pushRunbook(runId);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('records liveness on an authorized claim-authenticated pass (AC3)', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).toBe('applied');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('does NOT record liveness when a claim is verified only as a target selector', async () => {
    // `status --claim-id` names another agent's claim as a target. Verification
    // alone cannot attribute the invocation to that claim's holder: a parent
    // reading a child must not vouch for the child's liveness (AC5).
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const verified = await sessionService.verifyClaimId(claimId);
    expect(verified.status).toBe('verified');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(after).toBe(before);
  });

  it('records liveness when an authorized claim-authenticated mutation is refused (AC3)', async () => {
    // The verified bearer and authorized grant prove the holder is alive before
    // the terminal-state refusal decides that the run cannot advance.
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    // Drive the claim's run terminal so a further transition is refused.
    await manager.updateWithState(runId, () => ({ lifecycle: 'completed' as const }));
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).not.toBe('applied');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('records liveness when open delegated children refuse an authorized transition', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkageFor(runId, 'a'),
    });
    assertClaimed(
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(runId, 'a')),
    );
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'run', runId },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).toBe('open_delegated_children');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('records liveness before a post-authorization mutation dispatch throws', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    jest.spyOn(actorService, 'sendAndSync').mockRejectedValueOnce(new Error('dispatch exploded'));

    await expect(
      seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'claim_bearer', claimId },
        targetSelector: { kind: 'claim', claimId },
        terminalPolicy: releasePolicy,
      }),
    ).rejects.toThrow('dispatch exploded');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('does not record when the presented bearer lacks a grant for the target run', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const foreign = await manager.create({ source: 'project', path: 'foreign.md' }, mockRunbook, {
      runbookPath: 'foreign.md',
    });
    await sessionService.pushRunbook(foreign.id);
    const before = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'run', runId: foreign.id },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).toBe('claim_grant_required');

    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(after).toBe(before);
  });

  it('does not attempt recording for a stale presented claim', async () => {
    const missingClaimId = assertClaimId(
      'rdclm_00000000000000000000000000000000_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );
    const recordSpy = jest.spyOn(sessionService, 'recordClaimSeen');

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId: missingClaimId },
      targetSelector: { kind: 'claim', claimId: missingClaimId },
      terminalPolicy: releasePolicy,
    });

    expect(outcome.kind).toBe('stale_claim');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('does not attempt recording when a valid bearer has no default target', async () => {
    const { claimId } = await issueRunControlClaim(sessionService, runId);
    await sessionService.popRunbook();
    const recordSpy = jest.spyOn(sessionService, 'recordClaimSeen');

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'default' },
      terminalPolicy: releasePolicy,
    });

    expect(outcome).toEqual({ kind: 'none' });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('a failed progress write neither fails nor masks the committed mutation (AC7, RD-102)', async () => {
    const { claimId } = await issueRunControlClaim(sessionService, runId);
    const saveSpy = jest
      .spyOn(manager, 'saveSession')
      .mockRejectedValue(new Error('session write exploded'));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
      terminalPolicy: releasePolicy,
    });

    // Recording is attempted before dispatch and is total. The bookkeeping
    // failure must be invisible to the mutation that follows it.
    expect(outcome.kind).toBe('applied');
    saveSpy.mockRestore();
    const state = await manager.load(runId);
    expect(state?.step).not.toBe(startingStep);
  });

  it('adoption self-heals: a fresh session mutating with the bearer clears idle (AC11)', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    // Backdate the mark far past the threshold — the claim reads idle.
    const session = await manager.loadSession();
    session.claims[claim.claimKey] = {
      ...session.claims[claim.claimKey],
      lastSeenAt: '2020-01-01T00:00:00.000Z',
    };
    await manager.saveSession(session);
    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);

    // A fresh session presenting the bearer as authorized mutation authority is
    // the new live holder — so recovery is adoption, not reclamation.
    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).toBe('applied');

    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(false);
  });

  it('adoption does NOT self-heal via `status --claim-id` (AC11)', async () => {
    // Status names the claim as another agent's target; it cannot establish that
    // the claim's own holder is alive.
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const session = await manager.loadSession();
    session.claims[claim.claimKey] = {
      ...session.claims[claim.claimKey],
      lastSeenAt: '2020-01-01T00:00:00.000Z',
    };
    await manager.saveSession(session);

    await new SessionService(new RunbookStateManager(testDir)).verifyClaimId(claimId);

    expect(
      claimActivity(
        (await manager.loadSession()).claims[claim.claimKey],
        new Date(),
        DEFAULT_IDLE_AFTER_MS,
      ).idle,
    ).toBe(true);
  });

  it('records neither claim when the presenter lacks a grant for another claim target (AC5)', async () => {
    // Transition authorization remains target-derived here, so this continues to
    // apply until #613 tightens the mutation itself. Liveness is stricter: claim A
    // presented the bearer but has no mutate-run grant for B, while claim B was
    // selected rather than presented. Neither holder has established liveness.
    const stateB = await manager.create({ source: 'project', path: 'other.md' }, mockRunbook, {
      runbookPath: 'other.md',
    });
    // stateB is deliberately NOT pushed: claim targeting resolves through
    // `claim.controlledRunId` -> `manager.load`, never the session stack. Pushing
    // would make B the active runbook and give this case a second, irrelevant
    // reason to pass.
    const { claimId: claimA, claim: recordA } = await issueRunControlClaim(sessionService, runId);
    const { claimId: claimB, claim: recordB } = await issueRunControlClaim(
      sessionService,
      stateB.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTransition({
      command: 'pass',
      callerEvidence: { kind: 'claim_bearer', claimId: claimA },
      targetSelector: { kind: 'claim', claimId: claimB },
      terminalPolicy: releasePolicy,
    });
    expect(outcome.kind).toBe('applied');

    const session = await manager.loadSession();
    expect(session.claims[recordA.claimKey].lastSeenAt).toBe(recordA.lastSeenAt);
    expect(session.claims[recordB.claimKey].lastSeenAt).toBe(recordB.lastSeenAt);
  });

  it('records liveness for an authorized claim-authenticated navigation', async () => {
    const { claimId, claim } = await issueRunControlClaim(sessionService, runId);
    const before = claim.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'claim', claimId },
    });

    expect(outcome.kind).toBe('allowed');
    const after = (await manager.loadSession()).claims[claim.claimKey].lastSeenAt;
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('does not record navigation liveness for stale, missing, or policy-refused targets', async () => {
    const { claimId } = await issueRunControlClaim(sessionService, runId);
    const foreign = await manager.create({ source: 'project', path: 'foreign.md' }, mockRunbook, {
      runbookPath: 'foreign.md',
    });
    await sessionService.pushRunbook(foreign.id);
    const recordSpy = jest.spyOn(sessionService, 'recordClaimSeen');

    const refused = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'run', runId: foreign.id },
    });
    expect(refused.kind).toBe('actor_context_required');

    const staleClaimId = assertClaimId(
      'rdclm_00000000000000000000000000000000_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
    );
    const stale = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: { kind: 'claim_bearer', claimId: staleClaimId },
      targetSelector: { kind: 'claim', claimId: staleClaimId },
    });
    expect(stale.kind).toBe('stale_claim');

    await sessionService.popRunbook();
    await sessionService.popRunbook();
    const none = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: { kind: 'claim_bearer', claimId },
      targetSelector: { kind: 'default' },
    });
    expect(none.kind).toBe('none');
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('records neither claim when navigation presenter lacks a grant for another claim target', async () => {
    const stateB = await manager.create({ source: 'project', path: 'other.md' }, mockRunbook, {
      runbookPath: 'other.md',
    });
    const { claimId: claimA, claim: recordA } = await issueRunControlClaim(sessionService, runId);
    const { claimId: claimB, claim: recordB } = await issueRunControlClaim(
      sessionService,
      stateB.id,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: { kind: 'claim_bearer', claimId: claimA },
      targetSelector: { kind: 'claim', claimId: claimB },
    });

    // Navigation policy remains target-derived until #613, so the command is
    // still allowed. Liveness attribution independently requires presenter A's
    // authority for B and therefore records neither bearer.
    expect(outcome.kind).toBe('allowed');
    const session = await manager.loadSession();
    expect(session.claims[recordA.claimKey].lastSeenAt).toBe(recordA.lastSeenAt);
    expect(session.claims[recordB.claimKey].lastSeenAt).toBe(recordB.lastSeenAt);
  });

  it('attributes terminal liveness to caller A rather than selected claim B (AC5)', async () => {
    const linkage = linkageFor(runId, 'a');
    const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
      runbookPath: 'child.md',
      parentLinkage: linkage,
    });
    const { claimId: claimA, claim: recordA } = await issueRunControlClaim(sessionService, runId);
    const { claimId: claimB, claim: recordB } = assertClaimed(
      await claimLiveDelegation(sessionService, manager, child.id, linkage),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const outcome = await seam.runTerminal({
      command: 'complete',
      callerEvidence: { kind: 'claim_bearer', claimId: claimA },
      targetSelector: { kind: 'claim', claimId: claimB },
    });

    expect(outcome.kind).toBe('applied_claim');
    const after = await manager.loadSession();
    expect(Date.parse(after.claims[recordA.claimKey].lastSeenAt)).toBeGreaterThan(
      Date.parse(recordA.lastSeenAt),
    );
    // The point of AC5 stands: caller A's liveness was recorded, target B's was
    // not. Under the R2 latch, completing the delegated child resolves its parent
    // delegation, so claim B is tombstoned — never refreshed — and drops out of
    // the active-claims view entirely.
    expect(after.claims[recordB.claimKey]).toBeUndefined();
  });
});

// Bounded so every draw is a valid ISO instant, matching the arbitrary in
// claim-activity.properties.test.ts.
const epochMs = fc.integer({ min: 0, max: 4_102_444_800_000 });

describe('recordClaimSeen under backward wall-clock movement (#611 review)', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let runId: RunId;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'claim-seen-clock-test-'));
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
    // `max(existing, now)`: see recordClaimSeen's TSDoc for why that clamp is
    // the AC6 fail-open wearing a safety hat. This is the direct expression of
    // that contract — a clamp makes the second write a no-op and fails here.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:30.000Z', // observation, forward
      '2026-07-17T10:00:05.000Z', // observation, AFTER the clock steps back 2h
    ]);
    const { claimId, claim } = await issueRunControlClaim(service, runId);

    await service.recordClaimSeen(claimId);
    const result = await service.recordClaimSeen(claimId);

    const session = await manager.loadSession();
    const stored = session.claims[claim.claimKey];
    expect(stored.lastSeenAt).toBe('2026-07-17T10:00:05.000Z');
    // The returned value must agree with the write it describes, backward clock or
    // not — a clamp that kept the older timestamp but reported `now` would split
    // the two and leave every caller reporting an observation mark that isn't on disk.
    expect(result).toEqual({
      kind: 'recorded',
      claimKey: claim.claimKey,
      lastSeenAt: '2026-07-17T10:00:05.000Z',
    });
  });

  it('reports a DEAD claim idle after a sustained backward jump — the case a max-clamp would mask', async () => {
    // THE load-bearing test for declining the review's clamp.
    //
    // Clock steps back 2h; the child is seen once at 10:00:05 and then DIES.
    // Recording verbatim leaves lastSeenAt=10:00:05, so a reader at 11:30 sees
    // 1h29m idle and says so — correct, and the whole point of the feature.
    //
    // Under `max(existing, now)` the record would stay pinned at 12:00:30, and
    // claimActivity's `Math.max(0, now - lastSeen)` would clamp the negative
    // difference to ZERO: a dead claim reading `idle: false` for the entire
    // excursion, unable to self-heal precisely because nothing is happening. That
    // is the AC6 fail-open (claim-activity.ts:129-131) arriving through the write
    // path instead of the parser.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T12:00:30.000Z', // observation, pre-jump
      '2026-07-17T10:00:05.000Z', // observation, post-jump — then the child dies
    ]);
    const { claimId, claim } = await issueRunControlClaim(service, runId);
    await service.recordClaimSeen(claimId);
    await service.recordClaimSeen(claimId);

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
    // lastSeenAt is the CORRECT answer and no premature idle occurs.
    const service = serviceWithClock(manager, [
      '2026-07-17T12:00:00.000Z', // mint
      '2026-07-17T10:00:05.000Z', // observation, post-jump
    ]);
    const { claimId, claim } = await issueRunControlClaim(service, runId);
    await service.recordClaimSeen(claimId);

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
      fc.asyncProperty(epochMs, epochMs, async (mintAt, seenAt) => {
        const mint = new Date(mintAt).toISOString();
        const observation = new Date(seenAt).toISOString();
        const service = serviceWithClock(manager, [mint, observation]);
        const { claimId, claim } = await issueRunControlClaim(service, runId);

        const result = await service.recordClaimSeen(claimId);

        const session = await manager.loadSession();
        expect(session.claims[claim.claimKey].lastSeenAt).toBe(observation);
        expect(result).toEqual({
          kind: 'recorded',
          claimKey: claim.claimKey,
          lastSeenAt: observation,
        });
      }),
      // Each run does real filesystem work under a shared temp dir; 50 runs is
      // ample to cover both orderings without making the suite a bottleneck.
      { numRuns: 50 },
    );
  });
});
