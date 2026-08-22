import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { SessionService, projectStackPop } from '../../src/runbook/session-service.js';
import {
  assertClaimId,
  type ClaimRunbookResult,
  type DelegationClaimLinkage,
} from '../../src/runbook/claim-id.js';
import type {
  Runbook,
  RunId,
  RunbookState,
  ParentLinkage,
  ResolvedStep,
} from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  findSubstepState,
} from '../../src/runbook/targeting.js';
import { merge, replace } from '../../src/runbook/state-update-ops.js';
import { abortDelegation } from '../../src/runbook/delegation-service.js';
import {
  popTopOfStackUnverified,
  stashRunbookUnverified,
  unwrapSessionMutation,
} from '../../src/testing/session-fixtures.js';
import {
  linkageFor,
  assertClaimed,
  claimLiveDelegation,
  seedLiveDelegation,
} from './claim-test-helpers.js';

let inlineForceRunIdSeq = 0;

/**
 * Mint a fresh canonical run id (`rd_<32 hex>`) for inline-force-terminal
 * fixtures. The plan's literal ids (`rd_root`, `rd_leaf`) do not satisfy the
 * run-id pattern, so fixtures mint valid ids and reference the returned state.
 *
 * @returns A branded, never-before-used {@link RunId}.
 */
function mintInlineForceRunId(): RunId {
  inlineForceRunIdSeq += 1;
  return brandRunIdForTest(`rd_${inlineForceRunIdSeq.toString(16).padStart(32, '0')}`);
}

/**
 * Create and persist a runbook state for inline-force-terminal tests.
 *
 * Wraps {@link RunbookStateManager.create} so fixtures can pin an explicit run
 * id, parent linkage, and terminal lifecycle. Mirrors the plan's `makeState`
 * shape while using real run-id branding and persistence.
 *
 * @param manager - State manager used to persist the fixture state.
 * @param opts - Fixture options: explicit id, step name, lifecycle, and parent linkage.
 * @returns The persisted runbook state.
 */
async function makeState(
  manager: RunbookStateManager,
  opts: {
    readonly id?: RunId;
    readonly step?: string;
    readonly lifecycle?: RunbookState['lifecycle'];
    readonly parentLinkage?: ParentLinkage;
  },
): Promise<RunbookState> {
  const id = opts.id ?? mintInlineForceRunId();
  const runbook: Runbook = {
    title: 'Inline Force Terminal',
    description: 'fixture',
    steps: [makeBaseStep({ name: opts.step ?? '1', description: 'step' })],
  };
  const created = await manager.create({ source: 'project', path: `${id}.md` }, runbook, {
    runbookPath: `${id}.md`,
    runId: id,
    parentLinkage: opts.parentLinkage,
  });
  if (opts.lifecycle && opts.lifecycle !== 'running') {
    return manager.update(id, { lifecycle: opts.lifecycle });
  }
  return created;
}

describe('SessionService', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  /**
   * Stage a held execution lease on a run, the way a child mid-command holds
   * one. Raw SQL because the fixture needs the ownership columns without an
   * execution attempt driving them; the `runs` CHECK makes execution identity
   * all-or-nothing, so pid/token/epoch are written together and the attempt row
   * the deferred FK names is inserted alongside.
   *
   * @param runId - Run to mark as owned.
   */
  function holdExecutionLease(runId: RunId): void {
    const tokenHash = `sha256:${'e'.repeat(64)}`;
    const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
    raw
      .prepare(
        `INSERT INTO execution_attempts (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
         VALUES (:runId, 1, :token, 'effect_started', :pid, '2026-01-01T00:00:00.000Z')`,
      )
      .run({ runId, token: tokenHash, pid: process.pid });
    raw
      .prepare(
        'UPDATE runs SET exec_token = :token, exec_epoch = 1, exec_pid = :pid WHERE id = :runId',
      )
      .run({ runId, token: tokenHash, pid: process.pid });
    raw.close();
  }

  /**
   * Drop the ownership columns `holdExecutionLease` wrote, leaving the
   * execution_attempts row behind.
   *
   * Releasing ownership is NOT an authoritative parent write, so it does not
   * run the parent-side latch: a claim the latch skipped while its child was
   * execution-owned stays `active` afterwards. That is the only way to reach
   * the in-transaction liveness refusal, which fires on a claim still present
   * in `session.claims` — every other route tombstones the claim first and
   * lands on `ctx.claim`'s tombstone arm instead.
   *
   * @param runId - Run to release ownership of.
   */
  function releaseExecutionLease(runId: RunId): void {
    const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
    raw
      .prepare(
        'UPDATE runs SET exec_token = NULL, exec_epoch = NULL, exec_pid = NULL WHERE id = :runId',
      )
      .run({ runId });
    raw.close();
  }

  let sessionService: SessionService;
  const mockSteps: ResolvedStep[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: [makeBaseStep({ name: '1', description: 'Initial step' })],
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'session-test-'));
    manager = new RunbookStateManager(testDir);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Runbook stack operations', () => {
    it('pushRunbook adds to stack', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);

      const active = await sessionService.getActive();
      expect(active?.id).toBe(state.id);
    });

    it('the positional pop removes from stack and returns new top', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });

      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const newTopId = unwrapSessionMutation(await popTopOfStackUnverified(manager));
      expect(newTopId).toBe(parent.id);

      const active = await sessionService.getActive();
      expect(active?.id).toBe(parent.id);
    });

    // The empty-stack arm, which the positional pop's own callers never reach:
    // every one of them unwinds a stack it seeded. Pinned here because the arm
    // decides whether the guarded transaction runs a release at all, and a
    // fixture that released against an empty session would fail somewhere far
    // from the cause.
    it('the positional pop reports null for an empty stack', async () => {
      expect(unwrapSessionMutation(await popTopOfStackUnverified(manager))).toBeNull();
      expect((await manager.loadSession()).defaultStack).toEqual([]);
    });

    it('popRunbookIfActive pops the expected run and returns the new top', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(child.id));

      expect(result).toEqual({
        status: 'popped',
        runbookId: child.id,
        nextDefaultRunbookId: parent.id,
      });
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });

    // The case above leaves a single-entry tail, where reading the new top by a
    // positive index would answer `undefined`. This one leaves a multi-entry
    // tail, so "the new top" is asserted as an actual position rather than as
    // the coincidence of an exhausted stack.
    it('popRunbookIfActive returns the new top when the tail is more than one deep', async () => {
      const grandparent = await manager.create(
        { source: 'project', path: 'grandparent.md' },
        mockRunbook,
        { runbookPath: 'grandparent.md' },
      );
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(grandparent.id);
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(child.id));

      expect(result).toEqual({
        status: 'popped',
        runbookId: child.id,
        nextDefaultRunbookId: parent.id,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([grandparent.id, parent.id]);
    });

    // The defect this method exists to remove. A caller that resolved its target
    // with an unlocked `getActive` and then called the positional pop
    // pops whatever the top is when the transaction opens — and
    // `projectRunReleases` deletes every claim controlling that run, so a
    // freshly started foreign run loses the run-control bearer `rundown run`
    // minted with its push. Nothing about that is correctable.
    it('popRunbookIfActive refuses a foreign top and leaves its stack entry and claims intact', async () => {
      const mine = await manager.create({ source: 'project', path: 'mine.md' }, mockRunbook, {
        runbookPath: 'mine.md',
      });
      const mid = await manager.create({ source: 'project', path: 'mid.md' }, mockRunbook, {
        runbookPath: 'mid.md',
      });
      const foreign = await manager.create({ source: 'project', path: 'foreign.md' }, mockRunbook, {
        runbookPath: 'foreign.md',
      });
      await sessionService.pushRunbook(mine.id);
      // Buried under more than one entry, so the refusal is depth-independent
      // rather than "not immediately underneath". `releaseRuns` is the method
      // that would violate this: it filters the id out at ANY depth, which is
      // why it is not the fix for an undo meant as "only if still active".
      await sessionService.pushRunbook(mid.id);
      // Pushed and claimed the way `rundown run` does it, so the claim the wrong
      // pop would delete is a real run-control bearer rather than a fixture.
      const minted = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(foreign.id),
      );

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(mine.id));

      expect(result).toEqual({ status: 'not-active', activeRunbookId: foreign.id });
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([mine.id, mid.id, foreign.id]);
      expect(session.claims[minted.claim.claimKey]).toBeDefined();
    });

    // #788. The undo of a push must dispose of nothing the push created, and
    // the push creates one stack entry. Revoking the claim here was
    // irrecoverable: the child survives the rollback and the next attempt
    // resumes it, but `adoptRunControlClaim` refuses to re-mint once that child
    // has issued a delegation, so nothing addressed the run again.
    it("popRunbookIfActive leaves the popped run's run-control claim intact", async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(parent.id);
      // Pushed and claimed the way an inline launch does it, so the claim under
      // test is a real run-control bearer an orchestrator could still hold.
      const minted = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(child.id),
      );

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(child.id));

      expect(result).toEqual({
        status: 'popped',
        runbookId: child.id,
        nextDefaultRunbookId: parent.id,
      });
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([parent.id]);
      // The whole point: the run left the stack, the authority over it did not.
      expect(session.claims[minted.claim.claimKey]).toBeDefined();
      expect(session.claims[minted.claim.claimKey].controlledRunId).toBe(child.id);
    });

    // `session_stack` has no uniqueness constraint, and cannot gain one without
    // making an existing session impossible to load, so a run can sit lower
    // in the stack as well. Undoing one push must leave that entry alone —
    // `releaseRuns` filters every occurrence, which is why it is not the fix.
    it('popRunbookIfActive removes only the topmost entry for a repeated run', async () => {
      const outer = await manager.create({ source: 'project', path: 'outer.md' }, mockRunbook, {
        runbookPath: 'outer.md',
      });
      const mid = await manager.create({ source: 'project', path: 'mid.md' }, mockRunbook, {
        runbookPath: 'mid.md',
      });
      await sessionService.pushRunbook(outer.id);
      await sessionService.pushRunbook(mid.id);
      await sessionService.pushRunbook(outer.id);

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(outer.id));

      expect(result).toEqual({
        status: 'popped',
        runbookId: outer.id,
        nextDefaultRunbookId: mid.id,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([outer.id, mid.id]);
    });

    it('popRunbookIfActive reports an empty stack as not-active', async () => {
      const state = await manager.create({ source: 'project', path: 'gone.md' }, mockRunbook, {
        runbookPath: 'gone.md',
      });

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(state.id));

      expect(result).toEqual({ status: 'not-active', activeRunbookId: null });
    });

    // What the refusal DEGRADES to, which is a separate question from whether
    // the pop is correct. The affected-run selector names `expected` only while
    // `expected` is the top, so a foreign top's execution lease is not this
    // call's business: reusing the positional `topOfStack` selector would refuse
    // `execution_in_progress` and name a run the call was never going to touch,
    // telling the caller to retry something that will never succeed for it.
    it('popRunbookIfActive reports not-active for an execution-owned FOREIGN top', async () => {
      const mine = await manager.create({ source: 'project', path: 'mine.md' }, mockRunbook, {
        runbookPath: 'mine.md',
      });
      const foreign = await manager.create({ source: 'project', path: 'foreign.md' }, mockRunbook, {
        runbookPath: 'foreign.md',
      });
      await sessionService.pushRunbook(mine.id);
      await sessionService.pushRunbook(foreign.id);
      holdExecutionLease(foreign.id);

      const outcome = await sessionService.popRunbookIfActive(mine.id);

      expect(outcome.kind).toBe('committed');
      expect(unwrapSessionMutation(outcome)).toEqual({
        status: 'not-active',
        activeRunbookId: foreign.id,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([mine.id, foreign.id]);
    });

    // The selector's empty arm, which only this shape reaches: `expected` is
    // execution-owned AND buried, so a selector that named it unconditionally
    // would refuse `execution_in_progress` — telling the caller to retry a pop
    // that can never succeed for it, since `expected` is no longer the top and
    // will not become it. Nothing is being popped, so nothing is being guarded.
    it('popRunbookIfActive reports not-active for an execution-owned expected run that is buried', async () => {
      const mine = await manager.create({ source: 'project', path: 'mine.md' }, mockRunbook, {
        runbookPath: 'mine.md',
      });
      const foreign = await manager.create({ source: 'project', path: 'foreign.md' }, mockRunbook, {
        runbookPath: 'foreign.md',
      });
      await sessionService.pushRunbook(mine.id);
      await sessionService.pushRunbook(foreign.id);
      holdExecutionLease(mine.id);

      const outcome = await sessionService.popRunbookIfActive(mine.id);

      expect(outcome.kind).toBe('committed');
      expect(unwrapSessionMutation(outcome)).toEqual({
        status: 'not-active',
        activeRunbookId: foreign.id,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([mine.id, foreign.id]);
    });

    // The other half of the same selector: when the run this call WOULD pop is
    // execution-owned, the guard is exactly what must fire. Losing this arm
    // would let the pop remove a run mid-command.
    it('popRunbookIfActive refuses execution_in_progress when the expected top is owned', async () => {
      const state = await manager.create({ source: 'project', path: 'owned.md' }, mockRunbook, {
        runbookPath: 'owned.md',
      });
      await sessionService.pushRunbook(state.id);
      holdExecutionLease(state.id);

      const outcome = await sessionService.popRunbookIfActive(state.id);

      expect(outcome.kind).toBe('execution_in_progress');
      expect((await manager.loadSession()).defaultStack).toEqual([state.id]);
    });

    it('releaseRuns rejects a repeated run even when that run is execution-owned', async () => {
      // The refusal has to be the programmer error, not the ownership preflight.
      // `mutateGuarded` runs its `execution_in_progress` check BEFORE the
      // projection, so validating the batch inside the callback would answer a
      // malformed call with "retry" — remediation for a call that can never
      // succeed, whichever run it names. The aggregate seam pre-checks for the
      // same reason, and the two must not disagree.
      const state = await manager.create({ source: 'project', path: 'owned.md' }, mockRunbook, {
        runbookPath: 'owned.md',
      });
      await sessionService.pushRunbook(state.id);
      holdExecutionLease(state.id);

      await expect(
        sessionService.releaseRuns([
          { runId: state.id, role: 'addressed' },
          { runId: state.id, role: 'collateral' },
        ]),
      ).rejects.toThrow(state.id);

      expect((await manager.loadSession()).defaultStack).toEqual([state.id]);
    });

    it('popRunbookIfActive resolves the top and pops it in exactly one transaction', async () => {
      // Structural guard, matching the one `stash` carries. Every behavioural
      // test above is sequential, so reintroducing the `getActive()` pre-read
      // this method replaced would leave them green while restoring the #666
      // check-then-act window that loses a foreign run's claims.
      const state = await manager.create({ source: 'project', path: 'atomic.md' }, mockRunbook, {
        runbookPath: 'atomic.md',
      });
      await sessionService.pushRunbook(state.id);
      const loadSession = jest.spyOn(manager, 'loadSession');
      const load = jest.spyOn(manager, 'load');
      const mutateSession = jest.spyOn(manager, 'mutateSession');
      const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

      const result = unwrapSessionMutation(await sessionService.popRunbookIfActive(state.id));

      expect(result.status).toBe('popped');
      expect({
        guardedTransactions: mutateSessionGuarded.mock.calls.length,
        separateTransactions: mutateSession.mock.calls.length,
        unlockedSessionReads: loadSession.mock.calls.length,
        unlockedStateReads: load.mock.calls.length,
      }).toEqual({
        guardedTransactions: 1,
        separateTransactions: 0,
        unlockedSessionReads: 0,
        unlockedStateReads: 0,
      });
    });

    it('pushRunbookIfNotActive activates a run the session is not targeting', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(parent.id);

      const result = await sessionService.pushRunbookIfNotActive(child.id);

      expect(result).toEqual({ status: 'pushed' });
      // Pushed ON TOP of the parent rather than replacing it: the caller is
      // entering a nested run, and the entry underneath is what it returns to.
      expect((await manager.loadSession()).defaultStack).toEqual([parent.id, child.id]);
    });

    it('pushRunbookIfNotActive reports already-active without writing when the run holds the top', async () => {
      const state = await manager.create({ source: 'project', path: 'active.md' }, mockRunbook, {
        runbookPath: 'active.md',
      });
      const below = await manager.create({ source: 'project', path: 'below.md' }, mockRunbook, {
        runbookPath: 'below.md',
      });
      await sessionService.pushRunbook(below.id);
      await sessionService.pushRunbook(state.id);

      const result = await sessionService.pushRunbookIfNotActive(state.id);

      expect(result).toEqual({ status: 'already-active' });
      // The assertion that matters is the absence of a DUPLICATE entry, not
      // merely that the top is unchanged: an unconditional push leaves the same
      // run active while stacking it twice, so the run would need popping twice
      // to be released and the entry below would never be reached.
      expect((await manager.loadSession()).defaultStack).toEqual([below.id, state.id]);
    });

    // Buried, not absent. The condition is "is this run the TOP", not "is it on
    // the stack anywhere" — a run the session has since pushed past is not what
    // the caller's next bare command addresses, so re-activating it is the
    // point. A membership test would answer `already-active` here and leave the
    // caller running a child the session never targets.
    it('pushRunbookIfNotActive re-activates a run that is on the stack but buried', async () => {
      const buried = await manager.create({ source: 'project', path: 'buried.md' }, mockRunbook, {
        runbookPath: 'buried.md',
      });
      const above = await manager.create({ source: 'project', path: 'above.md' }, mockRunbook, {
        runbookPath: 'above.md',
      });
      await sessionService.pushRunbook(buried.id);
      await sessionService.pushRunbook(above.id);

      const result = await sessionService.pushRunbookIfNotActive(buried.id);

      expect(result).toEqual({ status: 'pushed' });
      // The duplicate entry is intended here, and is the opposite of the hazard
      // the `already-active` case above prevents. There the second entry would
      // be a push onto a run the session already targets — pure surplus, needing
      // two pops to release. Here the buried entry is a real earlier visit the
      // session should return to once this activation ends, and the single
      // conditional pop the pushing caller performs on failure
      // (`launchInlineChildFromIntent`'s rollback) restores exactly the stack
      // this call found.
      expect((await manager.loadSession()).defaultStack).toEqual([buried.id, above.id, buried.id]);
    });

    // The posture assertion, and the one that would break the crash-recovery
    // path if it flipped. `mutateSessionGuarded`'s ownership preflight refuses
    // on `runs.exec_token IS NOT NULL` alone — the dead-owner probe that
    // reclaims a SIGKILLed owner's lease lives on the lease-acquisition path and
    // is never reached from a session mutation. The caller this method exists
    // for is a launch span finishing a launch whose owner died, and a child
    // abandoned mid-execution is exactly the run still holding a lease naming a
    // dead pid. A guarded push would refuse `execution_in_progress` there
    // forever, so the lease is held here and the activation must still commit.
    it('pushRunbookIfNotActive activates a run holding an execution lease', async () => {
      const state = await manager.create({ source: 'project', path: 'leased.md' }, mockRunbook, {
        runbookPath: 'leased.md',
      });
      holdExecutionLease(state.id);

      const result = await sessionService.pushRunbookIfNotActive(state.id);

      expect(result).toEqual({ status: 'pushed' });
      expect((await manager.loadSession()).defaultStack).toEqual([state.id]);
    });

    it('pushRunbookIfNotActive decides and writes in exactly one unguarded transaction', async () => {
      // Structural guard, and the shape here differs from the conditional pop's
      // by design: one SEPARATE transaction rather than one guarded one, because
      // adding a stack entry takes nothing away from a run under execution and
      // guarding it would refuse the recovery above. What both assert is the
      // same property — that the condition is decided inside the transaction
      // that acts on it, so no unlocked `getActive` pre-read can go stale
      // between the decision and the write.
      const state = await manager.create(
        { source: 'project', path: 'atomic-push.md' },
        mockRunbook,
        {
          runbookPath: 'atomic-push.md',
        },
      );
      const loadSession = jest.spyOn(manager, 'loadSession');
      const load = jest.spyOn(manager, 'load');
      const mutateSession = jest.spyOn(manager, 'mutateSession');
      const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

      const result = await sessionService.pushRunbookIfNotActive(state.id);

      expect(result).toEqual({ status: 'pushed' });
      expect({
        guardedTransactions: mutateSessionGuarded.mock.calls.length,
        separateTransactions: mutateSession.mock.calls.length,
        unlockedSessionReads: loadSession.mock.calls.length,
        unlockedStateReads: load.mock.calls.length,
      }).toEqual({
        guardedTransactions: 0,
        separateTransactions: 1,
        unlockedSessionReads: 0,
        unlockedStateReads: 0,
      });
    });

    // The property the execution loop's terminal release depends on, and the
    // one that separates it from a pop: a loop reaching terminal must release
    // the run it drove, wherever that run now sits. A positional pop would take
    // the entry above it instead — deleting THAT run's claims, since a release
    // removes every claim controlling what it removes — and leave the run that
    // actually ended still targeted by the session.
    it('releaseRuns removes a buried run and leaves the entry above it alone', async () => {
      const ended = await manager.create({ source: 'project', path: 'ended.md' }, mockRunbook, {
        runbookPath: 'ended.md',
      });
      const above = await manager.create({ source: 'project', path: 'above.md' }, mockRunbook, {
        runbookPath: 'above.md',
      });
      // Both claimed, so the assertion is selectivity rather than survival: a
      // release deletes the claims of what it removes, which is exactly what
      // makes reaching the wrong run unrecoverable. Claiming only the entry
      // above would show that one intact without showing the deletion landed
      // on the run that was named.
      const endedClaim = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(ended.id),
      );
      const aboveClaim = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(above.id),
      );

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: ended.id, role: 'collateral' }]),
      );

      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([above.id]);
      expect(session.claims[endedClaim.claim.claimKey]).toBeUndefined();
      expect(session.claims[aboveClaim.claim.claimKey]).toBeDefined();
      expect((await sessionService.getActive())?.id).toBe(above.id);
    });

    // Releasing a run the session no longer targets is a no-op rather than a
    // refusal, which is what lets the loop release unconditionally at terminal
    // without first asking whether the fence or another process got there.
    it('releaseRuns is a no-op for a run that is not on the stack', async () => {
      const absent = await manager.create({ source: 'project', path: 'absent.md' }, mockRunbook, {
        runbookPath: 'absent.md',
      });
      // Asserted against a populated session, not an empty one: "nothing
      // changed" is trivially true of an empty stack, and the property the loop
      // relies on is that releasing an already-released run disturbs neither
      // the run currently targeted nor its authority.
      const stacked = await manager.create({ source: 'project', path: 'stacked.md' }, mockRunbook, {
        runbookPath: 'stacked.md',
      });
      const minted = unwrapSessionMutation(
        await sessionService.pushRunbookWithRunControlClaim(stacked.id),
      );

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: absent.id, role: 'collateral' }]),
      );

      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([stacked.id]);
      expect(session.claims[minted.claim.claimKey]).toBeDefined();
    });

    it('supports arbitrary nesting depth', async () => {
      const wf1 = await manager.create({ source: 'project', path: 'level1.md' }, mockRunbook, {
        runbookPath: 'level1.md',
      });
      const wf2 = await manager.create({ source: 'project', path: 'level2.md' }, mockRunbook, {
        runbookPath: 'level2.md',
      });
      const wf3 = await manager.create({ source: 'project', path: 'level3.md' }, mockRunbook, {
        runbookPath: 'level3.md',
      });

      await sessionService.pushRunbook(wf1.id);
      await sessionService.pushRunbook(wf2.id);
      await sessionService.pushRunbook(wf3.id);

      expect((await sessionService.getActive())?.id).toBe(wf3.id);
      unwrapSessionMutation(await popTopOfStackUnverified(manager));
      expect((await sessionService.getActive())?.id).toBe(wf2.id);
      unwrapSessionMutation(await popTopOfStackUnverified(manager));
      expect((await sessionService.getActive())?.id).toBe(wf1.id);
      unwrapSessionMutation(await popTopOfStackUnverified(manager));
      expect(await sessionService.getActive()).toBeNull();
    });
  });

  describe('resolveRunningStackMember', () => {
    it('resolves a running default-stack member', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);

      const member = await sessionService.resolveRunningStackMember(state.id);

      expect(member.kind).toBe('running');
      if (member.kind !== 'running') return;
      expect(member.state.id).toBe(state.id);
    });

    it('splits "not on stack" from "not running": a foreign id is not_on_stack', async () => {
      const foreign = brandRunIdForTest(`rd_${'f'.repeat(32)}`);

      const member = await sessionService.resolveRunningStackMember(foreign);

      expect(member).toEqual({ kind: 'not_on_stack' });
    });

    it('splits "not on stack" from "not running": a terminal stack member is not_running', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);
      await manager.update(state.id, { lifecycle: 'completed' });

      const member = await sessionService.resolveRunningStackMember(state.id);

      expect(member).toEqual({ kind: 'not_running', lifecycle: 'completed' });
    });
  });

  describe('Stash and pop operations', () => {
    it('stash saves current runbook and removes from stack', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);

      const stashed = unwrapSessionMutation(await sessionService.stash());

      expect(stashed.status).toBe('stashed');
      if (stashed.status !== 'stashed') return;
      expect(stashed.state.id).toBe(state.id);
      expect(await sessionService.getActive()).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBe(state.id);
    });

    it('unstash restores stashed runbook', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);
      unwrapSessionMutation(await sessionService.stash());

      const restored = unwrapSessionMutation(await sessionService.unstash());

      expect(restored?.id).toBe(state.id);
      expect((await sessionService.getActive())?.id).toBe(state.id);
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('unstash reports an idle session when the stashed run is deleted', async () => {
      // Renamed from "…clears stash when persisted state is missing", which
      // described a branch this case never reaches. `stash_slot.run_id` is a
      // `ON DELETE CASCADE` foreign key onto `runs`, so `manager.delete` takes
      // the slot row with it and `unstash` returns from its `!stashedId` guard
      // — the same shape as the `session_stack` cascade one test above.
      // Verified by making the missing-state branch throw: this case still
      // passed. The clearing branch is genuinely reachable, but only from the
      // corrupted state the next test stages, and that is where it is pinned.
      const state = await manager.create({ source: 'project', path: 'temp.md' }, mockRunbook, {
        runbookPath: 'temp.md',
      });
      await sessionService.pushRunbook(state.id);
      unwrapSessionMutation(await sessionService.stash());

      await manager.delete(state.id);

      const restored = unwrapSessionMutation(await sessionService.unstash());
      expect(restored).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBeNull();
      expect(await sessionService.getActive()).toBeNull();
    });

    it('unstash clears a stash slot whose run row was removed out of band', async () => {
      // The missing-state branch, and the reason it is NOT the dead sibling of
      // the arm removed from `stash()` in the same wave. That arm could not be
      // constructed at all: `applySession` rewrites the stack unconditionally
      // via `setStack`, so committing over a dangling `session_stack` row fails
      // the foreign key before any arm can be returned. The stash slot is
      // written by `setStash`, whose clearing form is a bare `DELETE` with no
      // reference to write — so `unstash` can both reach this branch and commit
      // its repair. The branch is self-healing, not defensive dead code.
      const state = await manager.create({ source: 'project', path: 'dangling.md' }, mockRunbook, {
        runbookPath: 'dangling.md',
      });
      await sessionService.pushRunbook(state.id);
      unwrapSessionMutation(await sessionService.stash());

      // Out of band, with the cascade disabled: the only way to leave a stash
      // slot pointing at a run whose state can no longer be read.
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.prepare('DELETE FROM runs WHERE id = :id').run({ id: state.id });
      const slotBefore = raw
        .prepare('SELECT run_id AS runId FROM stash_slot')
        .all()
        .map((row) => row.runId);
      raw.close();
      // The staging worked — otherwise the assertion below would pass through
      // the `!stashedId` guard and pin nothing.
      expect(slotBefore).toEqual([state.id]);

      const restored = unwrapSessionMutation(await sessionService.unstash());

      expect(restored).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('stash refuses to overwrite existing stash', async () => {
      const s1 = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
        runbookPath: 'a.md',
      });
      const s2 = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
        runbookPath: 'b.md',
      });
      await sessionService.pushRunbook(s1.id);

      const first = unwrapSessionMutation(await sessionService.stash());

      await sessionService.pushRunbook(s2.id);
      const second = unwrapSessionMutation(await sessionService.stash());

      expect(first.status).toBe('stashed');
      expect(second).toEqual({ status: 'slot-occupied', stashedRunbookId: s1.id });
      expect(await sessionService.getStashedRunbookId()).toBe(s1.id);
      expect((await sessionService.getActive())?.id).toBe(s2.id);
    });

    it('stash reports no-active-runbook on an empty stack without touching the slot', async () => {
      const result = unwrapSessionMutation(await sessionService.stash());

      expect(result).toEqual({ status: 'no-active-runbook' });
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('stash reports no-active-runbook before slot-occupied when the stack is empty', async () => {
      // Ordering, not redundancy: the two-step caller resolved the active run
      // first and returned its warning before ever reaching the slot write, so
      // an empty stack must still out-rank an occupied slot now that both
      // questions are answered in one transaction.
      const parked = await manager.create({ source: 'project', path: 'parked.md' }, mockRunbook, {
        runbookPath: 'parked.md',
      });
      await sessionService.pushRunbook(parked.id);
      unwrapSessionMutation(await sessionService.stash());

      const result = unwrapSessionMutation(await sessionService.stash());

      expect(result).toEqual({ status: 'no-active-runbook' });
      expect(await sessionService.getStashedRunbookId()).toBe(parked.id);
    });

    it('stash reports an idle session for a stack top whose run row is gone', async () => {
      // The other half of what `getActive` collapsed into `null`. Not a typed
      // corruption arm, because `session_stack.run_id` cascades on delete:
      // removing the run removes the stack entry, so the stack top is gone too
      // and the outcome is the plain idle one. This pins that the cascade —
      // not a branch in `stash` — is what makes the case indistinguishable.
      const state = await manager.create({ source: 'project', path: 'gone.md' }, mockRunbook, {
        runbookPath: 'gone.md',
      });
      await sessionService.pushRunbook(state.id);
      await manager.delete(state.id);

      const result = unwrapSessionMutation(await sessionService.stash());

      expect(result).toEqual({ status: 'no-active-runbook' });
      expect(await manager.loadSession()).toMatchObject({ defaultStack: [] });
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('stash resolves the active run and writes the slot in exactly one transaction', async () => {
      // Structural guard, not a behavioural one. Every other test here is
      // sequential, so reintroducing an unlocked `getActive()` pre-read before
      // the guarded write would leave them all green while restoring the #666
      // check-then-act window. `getActive` reads through `loadSession`, so
      // "zero session reads outside the transaction" is what pins atomicity.
      // `mutateSession` is spied for the same reason even though it is not a
      // read: a pre-read routed through it is unlocked in the sense that
      // matters — it commits in a SEPARATE `BEGIN IMMEDIATE`, so the target it
      // resolves can still change before the guarded write lands. Only the
      // guarded transaction may run, and only once.
      const state = await manager.create({ source: 'project', path: 'atomic.md' }, mockRunbook, {
        runbookPath: 'atomic.md',
      });
      await sessionService.pushRunbook(state.id);
      const loadSession = jest.spyOn(manager, 'loadSession');
      const load = jest.spyOn(manager, 'load');
      const mutateSession = jest.spyOn(manager, 'mutateSession');
      const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

      const result = unwrapSessionMutation(await sessionService.stash());

      expect(result.status).toBe('stashed');
      // Asserted as one named object so the failure diff says which property
      // moved: a non-zero unlocked read is a resolve-then-commit split, and a
      // second transaction of either kind is the same defect wearing a lock.
      expect({
        guardedTransactions: mutateSessionGuarded.mock.calls.length,
        separateTransactions: mutateSession.mock.calls.length,
        unlockedSessionReads: loadSession.mock.calls.length,
        unlockedStateReads: load.mock.calls.length,
      }).toEqual({
        guardedTransactions: 1,
        separateTransactions: 0,
        unlockedSessionReads: 0,
        unlockedStateReads: 0,
      });
    });
  });

  describe('claim-id runbook targeting', () => {
    const PARENT_RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
    const CHILD_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);

    it('mints a claim with run-control grants without persisting the bearer claim_id', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
          runId: PARENT_RUN_ID,
        },
      );

      const issued = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      const session = await manager.loadSession();

      expect(issued.claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
      expect(Object.keys(session.claims)).toEqual([issued.claim.claimKey]);
      expect(JSON.stringify(session)).not.toContain(issued.claimId);
      expect(issued.claim.grants).toEqual([
        { action: 'mutate-run', runId: state.id },
        { action: 'delegate-from-run', runId: state.id },
        { action: 'collect-for-run', runId: state.id },
        { action: 'abort-delegation', runId: state.id },
        { action: 'retry-delegation', runId: state.id },
      ]);
    });

    it('verifies a bearer claim_id before returning a verified claim', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
          runId: PARENT_RUN_ID,
        },
      );
      const issued = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));

      await expect(sessionService.verifyClaimId(issued.claimId)).resolves.toEqual({
        status: 'verified',
        claim: {
          claimKey: issued.claim.claimKey,
          controlledRunId: state.id,
          grants: issued.claim.grants,
        },
      });

      const tampered = issued.claimId.replace(/.$/, issued.claimId.endsWith('A') ? 'B' : 'A');
      await expect(sessionService.verifyClaimId(assertClaimId(tampered))).resolves.toEqual({
        status: 'invalid-secret',
        claimKey: issued.claim.claimKey,
      });
    });

    it('rotates the run-control claim when re-issued for the same run rather than duplicating it', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
          runId: PARENT_RUN_ID,
        },
      );

      const first = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      const second = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));

      // Exactly one run-control claim persists per run: re-issuing MUST NOT append a
      // duplicate that violates the SessionDataSchema controlledRunId uniqueness
      // invariant (which would render the session unreadable).
      const session = await manager.loadSession();
      expect(Object.keys(session.claims)).toEqual([second.claim.claimKey]);
      expect(second.claim.claimKey).not.toBe(first.claim.claimKey);

      // The freshly issued bearer verifies; the superseded bearer no longer resolves.
      await expect(sessionService.verifyClaimId(second.claimId)).resolves.toMatchObject({
        status: 'verified',
        claim: { controlledRunId: state.id },
      });
      await expect(sessionService.verifyClaimId(first.claimId)).resolves.toEqual({
        status: 'missing',
        claimKey: first.claim.claimKey,
      });
    });

    // A run created by a process that then died is orphaned: its bearer lived in
    // that process's memory only, so nothing can reproduce the secret its
    // persisted claim verifies. Adoption re-establishes control, but only where
    // the claim it replaces provably issued nothing — the credentials addendum's
    // "minting a second run-control claim after initialization used the first"
    // stop condition — so a delivered credential is never orphaned by it.
    it('adopts run-control authority for a run that has issued no delegation', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      const original = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));

      const adoption = await sessionService.adoptRunControlClaim(state);

      expect(adoption.kind).toBe('adopted');
      if (adoption.kind !== 'adopted') throw new Error('expected adopted');
      expect(adoption.runtime.claimId).not.toBe(original.claimId);
      expect(typeof adoption.runtime.delegationRuntime.issueDelegationCredential).toBe('function');
      expect(typeof adoption.runtime.delegationRuntime.deriveDelegationToken).toBe('function');
      await expect(sessionService.verifyClaimId(adoption.runtime.claimId)).resolves.toMatchObject({
        status: 'verified',
        claim: { controlledRunId: state.id },
      });
      // Exactly one run-control claim persists per run; the prior bearer is gone.
      const session = await manager.loadSession();
      expect(Object.keys(session.claims)).toEqual([adoption.runtime.claim.claimKey]);
      expect(JSON.stringify(session)).not.toContain(adoption.runtime.claimId);
    });

    it('adopts a run whose recorded substeps carry no delegation', async () => {
      // Distinct from the empty case above: the substep records EXIST, so the
      // per-substep predicate actually runs. A guard that treated any recorded
      // substep as evidence of issuance would refuse a run that issued nothing.
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      await manager.update(state.id, {
        substepStates: [{ id: '1.1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      const withoutDelegation = await manager.load(state.id);
      if (!withoutDelegation) throw new Error('expected the updated parent state');

      await expect(sessionService.adoptRunControlClaim(withoutDelegation)).resolves.toMatchObject({
        kind: 'adopted',
      });
    });

    it('refuses adoption for a run that already issued a delegation', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      const original = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      await seedLiveDelegation(manager, linkageFor(state.id, 'c'));
      const seeded = await manager.load(state.id);
      if (!seeded) throw new Error('expected the seeded parent state');
      // One delegated substep beside a sibling that carries none, PERSISTED:
      // the predicate reads the run through the transaction, so the mix has to
      // reach the store to be seen at all. ANY issued credential blocks
      // adoption, so a guard requiring every substep to carry one would adopt
      // here and orphan a credential that has already been minted.
      await manager.update(state.id, {
        substepStates: [
          { id: '1.2', frameKey: buildFrameKey('1'), status: 'running' as const },
          ...(seeded.substepStates ?? []),
        ],
      });
      const withDelegation = await manager.load(state.id);
      if (!withDelegation) throw new Error('expected the mixed parent state');
      expect(
        withDelegation.substepStates?.map((substep) => substep.delegation !== undefined),
      ).toEqual([false, true]);

      const adoption = await sessionService.adoptRunControlClaim(withDelegation);

      expect(adoption).toEqual({ kind: 'refused_credential_issued', runId: state.id });
      // The refusal is write-free: the bearer that issued the credential still
      // controls the run, so its echo surfaces stay reachable.
      await expect(sessionService.verifyClaimId(original.claimId)).resolves.toMatchObject({
        status: 'verified',
      });
    });

    it('refuses adoption on a credential issued after the caller captured its snapshot', async () => {
      // The caller hands in a state it loaded earlier. Evaluating the
      // issued-credential predicate against that snapshot is a check-then-act:
      // a delegation minted between the caller's read and the mint would be
      // orphaned by the rotation, which is the exact stop condition adoption
      // exists to respect. The predicate must therefore read the run through
      // the same transaction that installs the replacement claim.
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      const original = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      // `state` is the pre-delegation snapshot the caller still holds; the run
      // has since issued a credential.
      await seedLiveDelegation(manager, linkageFor(state.id, 'c'));

      const adoption = await sessionService.adoptRunControlClaim(state);

      expect(adoption).toEqual({ kind: 'refused_credential_issued', runId: state.id });
      // Write-free refusal: the issuing bearer must still control the run, or
      // the credential it minted becomes underivable (#676).
      await expect(sessionService.verifyClaimId(original.claimId)).resolves.toMatchObject({
        status: 'verified',
      });
    });

    it('adopts without throwing when the run row is gone by the time the transaction reads it', async () => {
      // The caller holds a state it loaded earlier; the run has since been
      // pruned. Reading through the transaction means the read can legitimately
      // come back empty, so the predicate must tolerate an absent run rather
      // than dereference it — an unguarded read turns a benign race into a
      // TypeError that escapes as an opaque crash instead of a typed outcome.
      // A run with no persisted row has no substep that could have issued a
      // credential, so there is nothing for the rotation to orphan.
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      await manager.delete(state.id);
      await expect(manager.load(state.id)).resolves.toBeNull();

      await expect(sessionService.adoptRunControlClaim(state)).resolves.toMatchObject({
        kind: 'adopted',
      });
    });

    it('refuses adoption while the run is execution-owned', async () => {
      // Adoption is a guarded session mutation over the run it adopts. An
      // execution-owned run must not have its controlling claim replaced out
      // from under the owner, and the refusal is reported as itself rather than
      // collapsed into a successful adoption.
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      const original = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
      holdExecutionLease(state.id);

      const adoption = await sessionService.adoptRunControlClaim(state);

      expect(adoption).toMatchObject({
        kind: 'refused_session',
        refusal: { kind: 'execution_in_progress', runId: state.id },
      });
      const session = await manager.loadSession();
      expect(Object.keys(session.claims)).toEqual([original.claim.claimKey]);
    });

    it('pushes and mints the run-control claim in one atomic session mutation', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
          runId: PARENT_RUN_ID,
        },
      );

      // Run-start (`rundown run`) previously took TWO session mutations
      // (pushRunbook + issueRunControlClaim), leaving a persisted window where the
      // run was on the stack with no controlling claim. The atomic variant MUST
      // take exactly one — asserted here on the store transaction that now carries
      // it, where the lock-cycle count used to stand in for the same property.
      const service = new SessionService(manager);
      // Spied on the guarded variant: the ownership-refusal wrapper changed which
      // manager method carries the transaction, not how many transactions there are.
      const mutateSpy = jest.spyOn(manager, 'mutateSessionGuarded');

      const issued = unwrapSessionMutation(await service.pushRunbookWithRunControlClaim(state.id));

      expect(mutateSpy).toHaveBeenCalledTimes(1);
      mutateSpy.mockRestore();

      // Atomic: the run is on the stack AND controlled by exactly one claim, and
      // the persisted session is schema-valid (loadSession validates on read).
      const session = await manager.loadSession();
      expect(session.defaultStack).toContain(state.id);
      expect(Object.keys(session.claims)).toEqual([issued.claim.claimKey]);
      expect(issued.claim.controlledRunId).toBe(state.id);
      await expect(service.verifyClaimId(issued.claimId)).resolves.toMatchObject({
        status: 'verified',
        claim: { controlledRunId: state.id },
      });
    });

    it('prepares a run-control claim without persistence and installs that exact bearer atomically', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
          runId: PARENT_RUN_ID,
        },
      );
      const service = new SessionService(manager, () => '2026-08-01T00:00:00.000Z');

      const prepared = service.prepareRunControlClaim(state.id);
      const mutateSpy = jest.spyOn(manager, 'mutateSessionGuarded');

      expect((await manager.loadSession()).claims).toEqual({});
      const installed = unwrapSessionMutation(
        await service.pushRunbookWithPreparedRunControlClaim(state.id, prepared),
      );
      // Atomic installation is a claim about the number of guarded writes as
      // much as their shape: asserting only the arguments would still pass if a
      // second guarded mutation slipped in behind the first.
      expect(mutateSpy).toHaveBeenCalledTimes(1);
      expect(mutateSpy).toHaveBeenCalledWith([state.id], expect.any(Function));
      expect(installed).toEqual({ claimId: prepared.claimId, claim: prepared.claim });
      await expect(service.verifyClaimId(prepared.claimId)).resolves.toMatchObject({
        status: 'verified',
        claim: {
          claimKey: prepared.claim.claimKey,
          controlledRunId: state.id,
        },
      });
    });

    it('refuses a prepared record paired with a different bearer', async () => {
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
      );
      const service = new SessionService(manager);
      const prepared = service.prepareRunControlClaim(state.id);
      const other = service.prepareRunControlClaim(state.id);

      await expect(
        service.pushRunbookWithPreparedRunControlClaim(state.id, {
          ...prepared,
          claimId: other.claimId,
        }),
      ).rejects.toThrow(`Prepared run-control claim does not match ${state.id}`);
      expect((await manager.loadSession()).defaultStack).toEqual([]);
      expect((await manager.loadSession()).claims).toEqual({});
    });

    it.each([
      ['controlled run id', 'controlledRunId'],
      ['claim key', 'claimKey'],
      ['secret hash', 'secretHash'],
    ] as const)(
      'independently refuses a prepared claim with a mismatched %s',
      async (_label, field) => {
        const state = await manager.create(
          { source: 'project', path: 'parent.runbook.md' },
          mockRunbook,
          { runbookPath: 'parent.runbook.md', runId: PARENT_RUN_ID },
        );
        const service = new SessionService(manager);
        const prepared = service.prepareRunControlClaim(state.id);
        const other = service.prepareRunControlClaim(CHILD_RUN_ID);
        const tampered = {
          ...prepared,
          claim: { ...prepared.claim, [field]: other.claim[field] },
        };

        await expect(
          service.pushRunbookWithPreparedRunControlClaim(state.id, tampered),
        ).rejects.toThrow(`Prepared run-control claim does not match ${state.id}`);
        const session = await manager.loadSession();
        expect(session.defaultStack).toEqual([]);
        expect(session.claims).toEqual({});
      },
    );

    it('mints a claim with child mutation and parent report grants', async () => {
      const persistedLinkage = linkageFor(PARENT_RUN_ID, 'b');
      await manager.create({ source: 'project', path: 'parent.runbook.md' }, mockRunbook, {
        runbookPath: 'parent.runbook.md',
        runId: PARENT_RUN_ID,
      });
      await manager.create({ source: 'project', path: 'child.runbook.md' }, mockRunbook, {
        runbookPath: 'child.runbook.md',
        runId: CHILD_RUN_ID,
        parentLinkage: persistedLinkage,
      });

      const result = await claimLiveDelegation(
        sessionService,
        manager,
        CHILD_RUN_ID,
        persistedLinkage,
      );
      const claimed = assertClaimed(result);
      const expectedDelegation: DelegationClaimLinkage = {
        childRunId: CHILD_RUN_ID,
        tokenHash: persistedLinkage.tokenHash,
        parentRunId: persistedLinkage.parentRunId,
        parentStepId: persistedLinkage.parentStepId,
        parentStep: persistedLinkage.parentStep,
        parentFrameKey: persistedLinkage.parentFrameKey,
        parentEntry: persistedLinkage.parentEntry,
      };

      expect(claimed.claimId).toMatch(/^rdclm_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
      expect(claimed.claim.delegation).toEqual(expectedDelegation);
      expect(claimed.claim.grants).toEqual([
        { action: 'mutate-run', runId: CHILD_RUN_ID },
        { action: 'report-delegation-result', ...expectedDelegation },
      ]);

      const session = await manager.loadSession();
      expect(JSON.stringify(session)).not.toContain(claimed.claimId);
    });

    it('registers a delegated child claim without changing the default stack', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);

      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a')),
      );

      expect((await sessionService.getActive())?.id).toBe(parent.id);
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([parent.id]);

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('claimed');
      if (resolved.status === 'claimed') {
        expect(resolved.state.id).toBe(child.id);
      }
    });

    it('refuses replay for an already-claimed child without rotating the original bearer', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });

      const first = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      const second = await claimLiveDelegation(sessionService, manager, child.id, linkage);
      const session = await manager.loadSession();

      expect(second).toEqual({
        status: 'already-claimed',
        childRunId: child.id,
        claim: first.claim,
      });
      expect(session.claims[first.claim.claimKey]).toEqual(first.claim);
      expect(await sessionService.getActiveForClaimId(first.claimId)).toMatchObject({
        status: 'claimed',
        state: { id: child.id },
      });
    });

    it('refuses delegation token replay before treating a new child id as claimable', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '9');
      const existingChild = await manager.create(
        { source: 'project', path: 'existing-child.md' },
        mockRunbook,
        {
          runbookPath: 'existing-child.md',
          parentLinkage: linkage,
        },
      );
      const first = assertClaimed(
        await claimLiveDelegation(sessionService, manager, existingChild.id, linkage),
      );

      const missingChildId = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
      const second = await claimLiveDelegation(sessionService, manager, missingChildId, linkage);
      const session = await manager.loadSession();

      expect(second).toEqual({
        status: 'already-claimed',
        childRunId: existingChild.id,
        claim: first.claim,
      });
      expect(session.claims[first.claim.claimKey]).toEqual(first.claim);
      expect(await sessionService.getActiveForClaimId(first.claimId)).toMatchObject({
        status: 'claimed',
        state: { id: existingChild.id },
      });
    });

    it('returns missing for an unknown claim id', async () => {
      const claimId = assertClaimId(
        'rdclm_00000000000000000000000000000000_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
      );
      const resolved = await sessionService.getActiveForClaimId(claimId);
      expect(resolved).toEqual({
        status: 'missing',
        claimId,
      });
    });

    it('reports a retired run-control claim as claim-rotated, with no delegation origin', async () => {
      // A non-delegated tombstone has no parent to classify against, so it must
      // not borrow a parent-side reason. `claim-rotated` is also what the CLI maps
      // to the generic unavailable code rather than RD-825's no-retry advice —
      // this claim was released, not outrun by a parent.
      const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
        runbookPath: 'solo.md',
      });
      await sessionService.pushRunbook(run.id);
      const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: run.id, role: 'collateral' }]),
      );

      const resolved = await sessionService.getActiveForClaimId(claimId);
      expect(resolved).toEqual({ status: 'superseded', claimId, reason: 'claim-rotated' });
    });

    it('refuses a tombstoned claim with a wrong secret as invalid-secret, disclosing no reason', async () => {
      // The secret is verified before the supersession is named, so a caller who
      // cannot prove the bearer learns exactly what `invalid-secret` already
      // reveals about an active claim — no more.
      const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
        runbookPath: 'solo.md',
      });
      await sessionService.pushRunbook(run.id);
      const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: run.id, role: 'collateral' }]),
      );

      // Same lookup key (so the tombstone is found), different secret segment —
      // reusing the known-valid secret shape from the unknown-claim fixture above.
      const [prefix, key] = claimId.split('_');
      const forged = assertClaimId(`${prefix}_${key}_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_`);
      expect(forged).not.toBe(claimId);

      const resolved = await sessionService.getActiveForClaimId(forged);
      expect(resolved).toEqual({ status: 'invalid-secret', claimId: forged });
    });

    it('prefers the supersession over the stash gate for a parked, superseded claim', async () => {
      // Both refusals are true. "Currently stashed — run `rundown pop`" names a
      // recovery that cannot succeed (pop refuses the same claim), so the caller
      // spends a command to reach a contradictory message. The refusal that ends
      // the caller's work wins.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
      // Hold a lease so the parent-side latch defers the tombstone: the claim row
      // stays active, so this exercises the resolution-time classification rather
      // than the tombstone lookup.
      holdExecutionLease(child.id);
      await manager.update(parent.id, { step: '2' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('superseded');
      if (resolved.status === 'superseded') {
        expect(resolved.reason).toBe('cursor-advanced');
        // The origin travels on this path too, not just on the tombstone path: the
        // envelope names the parent so the holder can report which delegation died.
        expect(resolved.delegation).toEqual({
          parentRunId: parent.id,
          parentStepId: linkage.parentStepId,
        });
      }
    });

    it.each(['completed', 'stopped'] as const)(
      'leaves a parked %s child reporting stashed rather than converting it to superseded',
      async (childLifecycle) => {
        // The guard inside the stash gate. `reports a parked terminal child as
        // terminal` below covers the read-only path (`includeStashed: true`), which
        // skips the gate entirely and therefore never reaches this branch —
        // mutation testing caught that, with every mutant in the guard surviving.
        //
        // A stashed child that is ALSO terminal keeps the outcome it had before
        // supersession was allowed to outrank the gate: `stashed`. Terminal evidence
        // is not a closed delegation, and promoting a resolved delegation over it here
        // would reorder the terminal precedence this change deliberately left alone.
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'a');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
        await manager.update(child.id, { lifecycle: childLifecycle });
        // Parent moves on: the delegation now reads closed, and the latch retains the
        // claim because its controlled child is terminal, so the row stays active.
        await manager.update(parent.id, { step: '2' });

        const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
        expect(resolved.status).toBe('unlinked');
        if (resolved.status === 'unlinked') {
          expect(resolved.reason).toBe('stashed');
        }
      },
    );

    it('reports a stashed run-control claim as stashed, with no delegation to classify', async () => {
      // The stash gate's non-delegated early return: `rundown run` mints a
      // run-control claim, `rundown stash` parks its run, and a bare mutating
      // command then presents that claim. There is no delegation to classify, so
      // the gate must answer `stashed` — without the guard the classifier is
      // handed an undefined linkage.
      const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
        runbookPath: 'solo.md',
      });
      await sessionService.pushRunbook(run.id);
      const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));
      unwrapSessionMutation(await stashRunbookUnverified(manager, run.id));

      const resolved = await sessionService.getActiveForClaimId(claimId);

      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('stashed');
      }
    });

    it('reports a tombstone whose parent was deleted as parent-unreadable', async () => {
      // A delegated tombstone outlives its parent: parent deletion does not cascade
      // to claims. The reason must say the parent is gone — that refusal carries a
      // `prune` remedy and the generic code, not RD-825's no-retry advice, because
      // nothing outran the token.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      // Tombstone it via the parent-side latch, then remove the parent.
      await manager.update(parent.id, { lifecycle: 'completed' });
      await manager.delete(parent.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('superseded');
      if (resolved.status === 'superseded') {
        expect(resolved.reason).toBe('parent-unreadable');
        expect(resolved.delegation).toEqual({
          parentRunId: parent.id,
          parentStepId: linkage.parentStepId,
        });
      }
    });

    it('still reports a parked claim as stashed while its delegation is live', async () => {
      // The gate's own job is intact: a live delegation is genuinely just parked,
      // and `rundown pop` will resume it.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('stashed');
      }
    });

    it('reports a parked terminal child as terminal, not as a closed delegation', async () => {
      // Completing the child closes the parent-side delegation, but terminal
      // evidence outranks supersession: this is the confirm-or-conflict contract
      // `rd pass/fail --claim-id` resolves against, and a resolved delegation must
      // not displace it.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'd');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
      await manager.update(child.id, { lifecycle: 'completed' });
      // The parent advances past the delegation. No lease needed: the parent-side
      // latch already retains a claim whose controlled child is terminal, so the
      // row stays active and resolution decides which refusal wins.
      await manager.update(parent.id, { step: '2' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId, {
        includeStashed: true,
      });
      expect(resolved.status).toBe('terminal');
    });

    it('deletes a claim together with the run it controls', async () => {
      // Runs and their claims live in one database and are removed in a single
      // transaction, so a delete can never half-apply the way two JSON files
      // could. The claim resolves as `missing`, not as a dangling record.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'c');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.delete(child.id);

      expect((await manager.loadSession()).claims).toEqual({});
      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('missing');
    });

    it('returns terminal for a completed claim child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'd');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.update(child.id, { lifecycle: 'completed' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('terminal');
      if (resolved.status === 'terminal') {
        expect(resolved.lifecycle).toBe('completed');
      }
    });

    it('returns terminal for a stopped claim child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '7');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.update(child.id, { lifecycle: 'stopped' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('terminal');
      if (resolved.status === 'terminal') {
        expect(resolved.lifecycle).toBe('stopped');
      }
    });

    it('returns unlinked for a child whose delegation linkage no longer matches the claim', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.update(child.id, {
        parentLinkage: {
          ...linkage,
          parentStepId: '2.1',
        },
      });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('child-linkage-mismatch');
      }
    });

    it('returns unlinked when the child parent entry drifts from its claim grant', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      await manager.update(child.id, {
        parentLinkage: { ...linkage, parentEntry: linkage.parentEntry + 1 },
      });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);

      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('child-linkage-mismatch');
      }
    });

    it('returns unlinked when the child parent frame drifts from its claim grant', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      await manager.update(child.id, {
        parentLinkage: { ...linkage, parentFrameKey: buildFrameKey('1', 2) },
      });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);

      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('child-linkage-mismatch');
      }
    });

    it('returns unlinked when the child parent step drifts from its claim grant', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      await manager.update(child.id, {
        parentLinkage: { ...linkage, parentStep: '2' },
      });

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);

      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('child-linkage-mismatch');
      }
    });

    it('supersedes the delegated claim once the parent ends (R2 latch)', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.update(parent.id, { lifecycle: 'completed' });

      // R2: an authoritative parent state commit tombstones the linked delegated
      // claim (parent terminalization), and loadSession surfaces only active
      // claims. But "no longer an active claim" is not "never existed": the
      // refusal must name the supersession, or the holder is told its claim id
      // does not exist and reads that as a mistyped id worth re-deriving —
      // exactly the retry the no-retry signal exists to stop.
      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('superseded');
      if (resolved.status === 'superseded') {
        expect(resolved.reason).toBe('parent-ended');
        expect(resolved.delegation).toEqual({
          parentRunId: parent.id,
          parentStepId: linkage.parentStepId,
        });
      }
    });

    it('reports a cursor-advanced delegation as superseded while the tombstone is deferred', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'c');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      // The child is mid-execution, so the parent-side latch must skip its claim
      // (tombstoning `status` while the controlled run is owned would abort the
      // parent's own commit). The parent then advances its top-level cursor past
      // the delegation, writing no `done` substep row.
      holdExecutionLease(child.id);
      await manager.update(parent.id, { step: '2' });

      // The deferral really happened: the row is still active, so nothing on the
      // claim record itself refuses this bearer.
      const session = await manager.loadSession();
      expect(session.claims[claimed.claim.claimKey]).toBeDefined();

      // Resolution must still refuse. The store tombstone is the optimization;
      // liveness against the committed parent is the enforcement. Without this,
      // a deferred tombstone leaves the bearer able to report a result into a
      // delegation the parent has already left — and if the parent never writes
      // again, it stays that way.
      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('superseded');
      if (resolved.status === 'superseded') {
        expect(resolved.reason).toBe('cursor-advanced');
        // The active-row path now routes through `describeSupersession` like the
        // tombstone paths, so this pins that the shared mapping is reached from
        // here too — the identical assertion on the stash-gate test above enters
        // it by the other arm.
        expect(resolved.delegation).toEqual({
          parentRunId: parent.id,
          parentStepId: linkage.parentStepId,
        });
      }
    });

    it('returns unlinked when the parent state is missing', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '0');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      await manager.delete(parent.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('parent-missing');
      }
    });

    it('returns stale for a claim whose child state is missing', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '8');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      // Orphan the claim: delete the child run row with the FK cascade disabled so
      // the claim survives, referencing a run whose state can no longer be read.
      // This is the corrupted-database state the typed `stale` refusal defends —
      // the cascade makes it unreachable through any supported delete.
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      raw.exec('PRAGMA foreign_keys = OFF');
      raw.prepare('DELETE FROM runs WHERE id = :id').run({ id: child.id });
      raw.close();

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('stale');
      if (resolved.status === 'stale') {
        expect(resolved.reason).toBe('missing-state');
      }
    });

    it('claimRunbook refuses with a typed missing-parent when the parent cannot be read', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '7');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await seedLiveDelegation(manager, linkage);
      await manager.delete(parent.id);

      // A claim naming an unreadable parent is the same FK-impossible corruption
      // class as an unreadable child, and `getActiveForClaimId` already reports
      // it softly (`unlinked/parent-missing`). Refusing with a typed result here
      // keeps one policy for one class instead of throwing on the parent side
      // and returning a value on the child side of the same function.
      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));
      expect(result.status).toBe('missing-parent');
      if (result.status === 'missing-parent') {
        expect(result.parentRunId).toBe(parent.id);
        expect(result.parentStepId).toBe(linkage.parentStepId);
      }
    });

    it('claimRunbook refuses to refresh an existing child claim carrying a different delegation', async () => {
      // Pins the `findClaimByChildRunId` + divergent-existing-linkage branch:
      // the incoming delegation is live in the parent (so the R2 latch passes)
      // and matches the child's persisted linkage, but the claim already on that
      // child was issued for a different delegation. Reached only when those
      // three facts hold together, so neither the childState mismatch test nor
      // the superseded test covers it.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const issued = linkageFor(parent.id, '5', '1.2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: issued,
      });
      const first = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, issued),
      );
      expect(first.claim.delegation?.tokenHash).toBe(issued.tokenHash);

      // A sibling delegation on its own live substep, adopted by the child's
      // persisted linkage so only the claim record diverges.
      const sibling = linkageFor(parent.id, '9', '1.3');
      await manager.update(child.id, { parentLinkage: sibling });
      await seedLiveDelegation(manager, sibling);

      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, sibling));

      expect(result.status).toBe('linkage-mismatch');
      if (result.status === 'linkage-mismatch') {
        expect(result.childRunId).toBe(child.id);
        expect(result.incoming).toBe(sibling);
        // The persisted side is the CLAIM's delegation, not the child's linkage —
        // asserting against `issued` rather than reconstructing it from the claim
        // under test, which would pass tautologically if the record lost it.
        expect(result.persisted?.kind).toBe('delegation');
        if (result.persisted?.kind === 'delegation') {
          expect(result.persisted.tokenHash).toBe(issued.tokenHash);
          expect(result.persisted.parentStepId).toBe(issued.parentStepId);
        }
      }
    });

    it('claimRunbook refuses when the child run state is missing', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await manager.delete(child.id);

      const result = await claimLiveDelegation(sessionService, manager, child.id, linkage);
      expect(result.status).toBe('missing-child');
      if (result.status === 'missing-child') {
        expect(result.childRunId).toBe(child.id);
      }
    });

    it('claimRunbook refuses when persisted child linkage diverges from incoming linkage', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });

      const drifted = { ...linkage, tokenHash: linkageFor(parent.id, '3').tokenHash };
      const result = await claimLiveDelegation(sessionService, manager, child.id, drifted);

      expect(result.status).toBe('linkage-mismatch');
      if (result.status === 'linkage-mismatch') {
        expect(result.childRunId).toBe(child.id);
        expect(result.incoming).toBe(drifted);
        expect(result.persisted).toEqual(linkage);
      }
    });

    // The three coordinates `linkageMatchesLinkage` did not compare before #738,
    // each drifted on the CHILD row while the incoming linkage stays live against
    // the parent — so the liveness gate passes and this predicate is the only
    // thing standing between a recomputed coordinate and a persisted grant.
    it('claimRunbook refuses when the child linkage names a different parent entry', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: { ...linkage, parentEntry: linkage.parentEntry + 1 },
      });

      const result = await claimLiveDelegation(sessionService, manager, child.id, linkage);

      expect(result).toEqual({
        status: 'linkage-mismatch',
        childRunId: child.id,
        incoming: linkage,
        persisted: { ...linkage, parentEntry: linkage.parentEntry + 1 },
      });
    });

    it('claimRunbook refuses when the incoming parent frame differs from the child linkage', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const drifted = {
        ...linkage,
        parentFrameKey: buildFrameKey('1', 2),
      };
      await manager.update(parent.id, {
        activeFrameKey: drifted.parentFrameKey,
        activeEntry: drifted.parentEntry,
        frameEntryCounts: replace({ [drifted.parentFrameKey]: drifted.parentEntry }),
      });

      const result = await claimLiveDelegation(sessionService, manager, child.id, drifted);

      expect(result).toEqual({
        status: 'linkage-mismatch',
        childRunId: child.id,
        incoming: drifted,
        persisted: linkage,
      });
    });

    it('claimRunbook refuses when the incoming parent step differs from the child linkage', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const drifted = { ...linkage, parentStep: '2' };
      await manager.update(parent.id, {
        step: drifted.parentStep,
        activeFrameKey: drifted.parentFrameKey,
        activeEntry: drifted.parentEntry,
        frameEntryCounts: replace({ [drifted.parentFrameKey]: drifted.parentEntry }),
      });

      const result = await claimLiveDelegation(sessionService, manager, child.id, drifted);

      expect(result).toEqual({
        status: 'linkage-mismatch',
        childRunId: child.id,
        incoming: drifted,
        persisted: linkage,
      });
    });

    // The narrow delegation-identity key, exercised where its width is what
    // decides. `findClaimByDelegationLinkage` keys on parent run, parent step
    // id, and token hash — three fields, against the six `linkageMatchesLinkage`
    // validates — and the drifted coordinate here (`parentEntry`) is in neither
    // the key nor, therefore, reachable by widening it without loss. The stale
    // claim is still FOUND, and the rival child's claim is refused against it.
    //
    // Widen that finder to six and it MISSES this record: the flow falls through
    // to the fresh-child arms, the rival child's own linkage matches the
    // re-issued incoming one, `findClaimByChildRunId` finds nothing for a run
    // never claimed, and a SECOND active claim is minted for the same token
    // hash. The refusal naming `claimedChild` — the found record's run, not the
    // run being claimed — is what proves the narrow key ran.
    it('refuses a drifted claim against the claim its token hash already identifies', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const issued = linkageFor(parent.id, '9');
      const claimedChild = await manager.create(
        { source: 'project', path: 'child.md' },
        mockRunbook,
        { runbookPath: 'child.md', parentLinkage: issued },
      );
      const first = assertClaimed(
        await claimLiveDelegation(sessionService, manager, claimedChild.id, issued),
      );

      // The lease is what leaves a STALE claim active across the parent write
      // below: the parent-side latch defers tombstoning an execution-owned
      // child, so `first` survives a re-issue it no longer matches. Without it
      // there is no drifted record for the finder to find.
      holdExecutionLease(claimedChild.id);
      const reissued = { ...issued, parentEntry: issued.parentEntry + 1 };
      await seedLiveDelegation(manager, reissued);
      await manager.update(parent.id, {
        activeFrameKey: reissued.parentFrameKey,
        activeEntry: reissued.parentEntry,
        frameEntryCounts: replace({ [reissued.parentFrameKey]: reissued.parentEntry }),
      });
      releaseExecutionLease(claimedChild.id);
      const rivalChild = await manager.create(
        { source: 'project', path: 'rival-child.md' },
        mockRunbook,
        { runbookPath: 'rival-child.md', parentLinkage: reissued },
      );

      const result = unwrapSessionMutation(
        await sessionService.claimRunbook(rivalChild.id, reissued),
      );

      expect(result).toEqual({
        status: 'linkage-mismatch',
        childRunId: claimedChild.id,
        incoming: reissued,
        persisted: issued,
      });
      expect(Object.keys((await manager.loadSession()).claims)).toEqual([first.claim.claimKey]);
    });

    // Entry IDENTITY, not entry 1. `classifyDelegationLiveness` compares the
    // claim's entry against the one stamped on the substep's credential at
    // issuance, so a delegation issued after its parent frame was re-entered is
    // claimable at the entry it was issued on. Every coordinate reads 2 here —
    // the claim's, the credential's, and the parent's live entry — so there is
    // no drift to reject, and a fixture that stamped a fixed issuance entry
    // would make this refuse instead.
    it('claims a delegation issued on a re-entered parent frame', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = { ...linkageFor(parent.id, '7'), parentEntry: 2 };
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await manager.update(parent.id, {
        activeFrameKey: linkage.parentFrameKey,
        activeEntry: linkage.parentEntry,
        frameEntryCounts: replace({ [linkage.parentFrameKey]: linkage.parentEntry }),
      });

      const result = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      expect(result.claim.delegation?.parentEntry).toBe(2);
    });

    // The other arm of entry identity, and the one #738's fix actually turns on:
    // every coordinate a caller can present agrees — the claim's entry, the
    // child's persisted entry, and the credential's issuance entry are all 1 —
    // and the parent's LIVE entry has moved to 2. Nothing in the linkage can see
    // that; only the comparison of live state against the issuance entry can.
    // The claim is refused before any authority is minted, which is the whole
    // point: a grant naming entry 1 on a frame now at entry 2 is one
    // `grantAllows` would later refuse silently, dropping the child's report.
    it('refuses a claim after the parent frame re-enters past the issuance entry', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '8');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await seedLiveDelegation(manager, linkage);
      await manager.update(parent.id, {
        activeFrameKey: linkage.parentFrameKey,
        activeEntry: linkage.parentEntry + 1,
        frameEntryCounts: replace({ [linkage.parentFrameKey]: linkage.parentEntry + 1 }),
      });

      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));

      expect(result).toEqual({
        status: 'delegation-superseded',
        parentRunId: parent.id,
        parentStepId: linkage.parentStepId,
        childRunId: child.id,
      });
      // No authority was minted, and the child's own stamp is untouched — so a
      // retry reads the same coordinates rather than a half-adopted linkage.
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
      expect((await manager.load(child.id))?.parentLinkage).toEqual(linkage);
    });

    // #752. The delegation is cancelled, and nothing else about the parent has
    // changed: the cursor is still on the delegating step, the substep row is
    // still `running`, and it still carries the claim's own token. Every other
    // closed reason is therefore ruled out by construction, so the refusal this
    // produces is the cancellation's and not a coincidence — which matters
    // because the folded classifier returned `resolved` here, and the caller
    // was told the parent had moved on.
    it('refuses a claim against a cancelled delegation as delegation-cancelled', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '9');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await seedLiveDelegation(manager, linkage);

      // Cancelled through the real primitive, not a hand-patched row: what makes
      // this case distinguishable at all is that `abortDelegation` leaves the
      // substep's own status alone, and a fixture that wrote `done` as well
      // would be classified `resolved` no matter what the cancelled arm does.
      const seeded = await manager.load(parent.id);
      if (!seeded) {
        throw new Error(`Expected the seeded parent ${parent.id} to be readable`);
      }
      const aborted = abortDelegation({
        parentState: seeded,
        substepId: linkage.parentStepId,
        frameKey: linkage.parentFrameKey,
        force: false,
      });
      if (aborted.status !== 'cancelled') {
        throw new Error(`Expected the abort to commit, got status=${aborted.status}`);
      }
      await manager.update(parent.id, { substepStates: aborted.updatedSubstepStates });

      const cancelledParent = await manager.load(parent.id);
      const cancelledSubstep = findSubstepState(
        cancelledParent?.substepStates ?? [],
        linkage.parentStepId,
        linkage.parentFrameKey,
      );
      // The three preconditions that would each close this delegation for a
      // reason of their own. Asserted rather than assumed: without them the
      // test still passes with the cancelled arm reverted.
      expect(cancelledParent?.step).toBe(linkage.parentStep);
      expect(cancelledSubstep?.status).toBe('running');
      expect(cancelledSubstep?.delegation?.tokenHash).toBe(linkage.tokenHash);
      const cancelledAt = cancelledSubstep?.delegation?.cancelledAt;
      expect(cancelledAt).toEqual(expect.any(String));

      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));

      expect(result).toEqual({
        status: 'delegation-cancelled',
        parentRunId: parent.id,
        parentStepId: linkage.parentStepId,
        cancelledAt,
        childRunId: child.id,
      });
      // Refused before any authority was minted, exactly like the superseded
      // arm — the two differ in what they report, never in what they commit.
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
    });

    // The other two closed reasons at this seam. `cursor-advanced` and
    // `token-reissued` are driven by the tests above and below; these two were
    // classified but never claimed against, so nothing pinned that they reach
    // the caller as `delegation-superseded` rather than as some other refusal.
    // Splitting `cancelled` out of `resolved` is what made the gap visible —
    // the arm now names each reason it supersedes instead of catching whatever
    // falls through.
    it.each([
      {
        caseName: 'the parent run has ended',
        mutate: async (manager: RunbookStateManager, linkage: ReturnType<typeof linkageFor>) => {
          await manager.update(linkage.parentRunId, { lifecycle: 'completed' });
        },
      },
      {
        caseName: 'the delegated substep is already resolved',
        mutate: async (manager: RunbookStateManager, linkage: ReturnType<typeof linkageFor>) => {
          const parent = await manager.load(linkage.parentRunId);
          await manager.update(linkage.parentRunId, {
            substepStates: (parent?.substepStates ?? []).map((substep) =>
              substep.id === linkage.parentStepId && substep.frameKey === linkage.parentFrameKey
                ? { ...substep, status: 'done' as const, result: 'pass' as const }
                : substep,
            ),
          });
        },
      },
    ])('refuses a claim as delegation-superseded when $caseName', async ({ mutate }) => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'a');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      await seedLiveDelegation(manager, linkage);
      await mutate(manager, linkage);

      // The delegation itself is untouched: still uncancelled, still carrying
      // this claim's token. Only the parent-side fact under test closed it, so
      // the reason reported is that fact's and not a cancellation's.
      const closedParent = await manager.load(parent.id);
      const closedSubstep = findSubstepState(
        closedParent?.substepStates ?? [],
        linkage.parentStepId,
        linkage.parentFrameKey,
      );
      expect(closedSubstep?.delegation?.cancelledAt).toBeNull();
      expect(closedSubstep?.delegation?.tokenHash).toBe(linkage.tokenHash);

      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));

      expect(result).toEqual({
        status: 'delegation-superseded',
        parentRunId: parent.id,
        parentStepId: linkage.parentStepId,
        childRunId: child.id,
      });
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
    });

    it('refuses a reissued-token claim against an existing child delegation as superseded', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const originalLinkage = linkageFor(parent.id, '5');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: originalLinkage,
      });
      const first = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, originalLinkage),
      );
      expect(first.claim.delegation).toBeDefined();

      // The parent still delegates the original token. A second claim presenting
      // a different (reissued) token is refused by the R2 latch as superseded —
      // the parent's live substep carries a different token — rather than minting
      // a rival claim against the same child. (Pre-R2 this surfaced as a
      // linkage-mismatch; the durable latch now decides on parent liveness first.)
      const incomingLinkage = linkageFor(parent.id, '6');
      const result = unwrapSessionMutation(
        await sessionService.claimRunbook(child.id, incomingLinkage),
      );

      expect(result.status).toBe('delegation-superseded');
      if (result.status === 'delegation-superseded') {
        expect(result.parentRunId).toBe(parent.id);
        expect(result.parentStepId).toBe(incomingLinkage.parentStepId);
        expect(result.childRunId).toBe(child.id);
      }
    });

    it.each(['completed', 'stopped'] as const)(
      'claimRunbook reports an existing claim as terminal-child (%s) ahead of the closed delegation',
      async (childLifecycle) => {
        // Terminal evidence outlives the parent-side delegation. The parent half
        // of the latch (`RunbookStore.invalidateClosedDelegatedClaims`) skips a
        // claim whose child is terminal, so that skip is exactly what leaves this
        // row active for `claimRunbook` to read — and every terminal child also
        // reads `closed` on the parent side, so the check order is what decides
        // which refusal the caller sees. Both terminal lifecycles are driven
        // because the refusal echoes `lifecycle`, and mutation testing otherwise
        // leaves the `stopped` half of the guard unpinned.
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'b');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        assertClaimed(await claimLiveDelegation(sessionService, manager, child.id, linkage));

        // The child reaches a terminal lifecycle, then the parent commits the
        // write that resolves the delegated substep — an authoritative write, so
        // the parent-side latch runs and skips this claim on its terminal child.
        await manager.update(child.id, { lifecycle: childLifecycle });
        await manager.update(parent.id, {
          substepStates: [
            {
              id: linkage.parentStepId,
              frameKey: linkage.parentFrameKey,
              status: 'done',
              result: 'pass',
            },
          ],
        });
        // Precondition, not decoration: the claim survived the parent commit, so
        // the re-claim below really does reach the existing-claim arms.
        await expect(sessionService.findClaimForDelegation(linkage)).resolves.not.toBeNull();

        const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));

        expect(result.status).toBe('terminal-child');
        if (result.status === 'terminal-child') {
          expect(result.childRunId).toBe(child.id);
          expect(result.lifecycle).toBe(childLifecycle);
        }
      },
    );

    it('claimRunbook refuses when child has no parent linkage at all', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      const linkage = linkageFor(parent.id, '4');

      const result = await claimLiveDelegation(sessionService, manager, child.id, linkage);
      expect(result.status).toBe('linkage-mismatch');
      if (result.status === 'linkage-mismatch') {
        expect(result.persisted).toBeUndefined();
      }
    });

    it('releaseRuns with a revoking role removes matching claim records', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );

      // A released claim is a tombstone, not an absent row, so it resolves as
      // `superseded` / `claim-rotated` — released or replaced, no parent-side
      // supersession claimed. `missing` stays for a key with no row at all.
      const released = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(released.status).toBe('superseded');
      if (released.status === 'superseded') {
        expect(released.reason).toBe('claim-rotated');
      }
    });

    /**
     * Claim a delegated child and drive its lifecycle to a terminal state.
     *
     * @param fill - Unique single char used to derive the linkage token hash.
     * @param childLifecycle - Terminal lifecycle to stamp on the child run.
     * @returns The bearer claim id, persisted lookup key, and child run id.
     */
    async function setupClaimedChild(
      fill: string,
      childLifecycle: 'completed' | 'stopped',
    ): Promise<{
      claimId: ReturnType<typeof assertClaimId>;
      claimKey: string;
      childRunId: RunId;
    }> {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, fill);
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      await manager.update(child.id, { lifecycle: childLifecycle });
      return { claimId: claimed.claimId, claimKey: claimed.claim.claimKey, childRunId: child.id };
    }

    it("releaseRuns role 'addressed' keeps the claim as a terminal tombstone", async () => {
      const { claimId, childRunId } = await setupClaimedChild('e', 'completed');

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: childRunId, role: 'addressed' }]),
      );

      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('completed');
      }
    });

    it("releaseRuns role 'collateral' still deletes the claim record", async () => {
      const { claimId, childRunId } = await setupClaimedChild('7', 'completed');

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: childRunId, role: 'collateral' }]),
      );

      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('superseded');
      if (resolution.status === 'superseded') {
        expect(resolution.reason).toBe('claim-rotated');
      }
    });

    it("releaseRuns role 'addressed' keeps a stopped child as a terminal tombstone", async () => {
      // Sibling of the `completed` tombstone test: a stopped (aborted/failed)
      // child must also retain its claim as a terminal tombstone so a later
      // getActiveForClaimId resolves `terminal` rather than `missing`, and the
      // resolved lifecycle reflects `stopped`.
      const { claimId, childRunId } = await setupClaimedChild('d', 'stopped');

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: childRunId, role: 'addressed' }]),
      );

      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('stopped');
      }
    });

    it('pruneClaimsForChildren removes claims pointing at the given child run ids', async () => {
      const { claimId, claimKey, childRunId } = await setupClaimedChild('6', 'completed');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: childRunId, role: 'addressed' }]),
      );

      const removed = unwrapSessionMutation(
        await sessionService.pruneClaimsForChildren([childRunId]),
      );

      expect(removed).toEqual([claimKey]);
      // Pruned means tombstoned, so the refusal names the retirement rather than
      // denying the id ever existed.
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('superseded');
      if (resolution.status === 'superseded') {
        expect(resolution.reason).toBe('claim-rotated');
      }
    });

    it('pruneClaimsForChildren removes claims for multiple child run ids', async () => {
      // Two distinct claimed children (one completed, one stopped) each retain a
      // terminal tombstone. A single prune call covering both child ids must
      // remove both claim records and resolve each as retired afterward.
      const a = await setupClaimedChild('8', 'completed');
      const b = await setupClaimedChild('9', 'stopped');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: a.childRunId, role: 'addressed' }]),
      );
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: b.childRunId, role: 'addressed' }]),
      );

      const removed = unwrapSessionMutation(
        await sessionService.pruneClaimsForChildren([a.childRunId, b.childRunId]),
      );

      expect(removed).toHaveLength(2);
      expect(new Set(removed)).toEqual(new Set([a.claimKey, b.claimKey]));
      expect((await sessionService.getActiveForClaimId(a.claimId)).status).toBe('superseded');
      expect((await sessionService.getActiveForClaimId(b.claimId)).status).toBe('superseded');
    });

    it('pruneClaimsForChildren is a no-op when no claim matches the given child run ids', async () => {
      // A retained tombstone exists, but the prune targets an unrelated child id.
      // No claim is removed and the existing tombstone still resolves `terminal`.
      const { claimId, childRunId } = await setupClaimedChild('a', 'completed');
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: childRunId, role: 'addressed' }]),
      );

      const unrelatedChildId = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
      const removed = unwrapSessionMutation(
        await sessionService.pruneClaimsForChildren([unrelatedChildId]),
      );

      expect(removed).toEqual([]);
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('completed');
      }
    });

    describe('stashForClaimId', () => {
      it('refuses a bearer rotated after resolution and leaves the stash slot untouched', async () => {
        // The #666 interleave: resolve with the old bearer, mint a replacement
        // for the same run, then stash with the old bearer. Before this method
        // existed the stash committed, because the bearer-blind session write it
        // replaced (now `stashRunbookUnverified`, test-only) authorized on the run
        // id alone and `mintRunControlClaim` keeps the run claim-targeted.
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId: oldBearer } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );

        expect((await sessionService.getActiveForClaimId(oldBearer)).status).toBe('claimed');

        unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(oldBearer));

        expect(result).toEqual({
          status: 'superseded',
          claimId: oldBearer,
          reason: 'claim-rotated',
        });
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBeUndefined();
        expect(session.defaultStack).toEqual([run.id]);
      });

      it('verifies the bearer and writes the slot in exactly one transaction', async () => {
        // Structural guard on the #666 fix, because no behavioural test can
        // reach it: every test in this file is sequential, so a reintroduced
        // `getActiveForClaimId(...)` pre-read before `mutateSessionGuarded`
        // would keep them all green while restoring the window where a bearer
        // rotated between resolve and commit still stashes. That pre-read must
        // call `loadSession`, so "zero unlocked reads, one guarded
        // transaction" is the property that makes the verification atomic.
        // `mutateSession` is spied alongside them because a pre-read routed
        // through it would slip past a read-only spy set while still being
        // check-then-act: it commits in its own `BEGIN IMMEDIATE`, so the
        // bearer it verifies can still rotate before the guarded write lands.
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        const loadSession = jest.spyOn(manager, 'loadSession');
        const load = jest.spyOn(manager, 'load');
        const mutateSession = jest.spyOn(manager, 'mutateSession');
        const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

        expect(result.status).toBe('stashed');
        // One named object so the failure diff says which property moved: a
        // non-zero unlocked read is a resolve-then-commit split, and a second
        // transaction of either kind is the same defect wearing a lock.
        expect({
          guardedTransactions: mutateSessionGuarded.mock.calls.length,
          separateTransactions: mutateSession.mock.calls.length,
          unlockedSessionReads: loadSession.mock.calls.length,
          unlockedStateReads: load.mock.calls.length,
        }).toEqual({
          guardedTransactions: 1,
          separateTransactions: 0,
          unlockedSessionReads: 0,
          unlockedStateReads: 0,
        });
      });

      it('stashes a run-control claim and takes its run off the default stack', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

        expect(result.status).toBe('stashed');
        if (result.status === 'stashed') {
          expect(result.state.id).toBe(run.id);
          expect(result.claim.controlledRunId).toBe(run.id);
        }
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBe(run.id);
        expect(session.defaultStack).toEqual([]);
      });

      it('stashes a delegated child and preserves its claim record unchanged', async () => {
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'a');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        const before = (await manager.loadSession()).claims[claimed.claim.claimKey];

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result.status).toBe('stashed');
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBe(child.id);
        // `stash --claim-id` preserves the claim record (#519 non-recording).
        expect(session.claims[claimed.claim.claimKey]).toEqual(before);
      });

      it('refuses a delegated child whose persisted linkage no longer matches its claim record', async () => {
        // `claimRunbook` requires the incoming linkage to match the child's
        // persisted linkage at claim time, so the only way to produce a
        // divergence is a later mutation of the child's `parentLinkage` — the
        // same fixture shape as the `getActiveForClaimId` unlinked/linkage-
        // mismatch case (`session-service.test.ts:827-852`), here reusing
        // `linkageFor`'s varying `fill` to build the diverged linkage.
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'c');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );

        await manager.update(child.id, { parentLinkage: linkageFor(parent.id, 'd') });

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result.status).toBe('child-linkage-mismatch');
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('refuses a delegated child whose parent moved past the delegation', async () => {
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'b');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        // The child is not execution-owned, so the parent-side latch tombstones
        // the claim as the parent's cursor advances. The bearer then lands on the
        // tombstone arm and must be named superseded, not unknown.
        await manager.update(parent.id, { step: '2' });

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result).toEqual({
          status: 'superseded',
          claimId: claimed.claimId,
          reason: 'cursor-advanced',
        });
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('refuses a closed delegation the parent-side latch has not yet tombstoned', async () => {
        // The sibling test above enters `superseded` by the tombstone arm: the
        // latch retired the claim, so the bearer is absent from `session.claims`
        // and `ctx.claim` reports it. This one enters by the OTHER arm — the
        // in-transaction `classifyDelegationLiveness` call — which is reachable
        // only while the claim is still active. `invalidateClosedDelegatedClaims`
        // skips an execution-owned child (superseding it would RAISE from
        // `claims_guard_update` and roll back the parent's unrelated commit), so
        // owning the child across the parent's cursor advance is what defers the
        // tombstone; releasing ownership afterwards writes nothing to the parent
        // and therefore never re-runs the latch.
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'e');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );
        holdExecutionLease(child.id);
        await manager.update(parent.id, { step: '2' });
        releaseExecutionLease(child.id);

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result).toEqual({
          status: 'superseded',
          claimId: claimed.claimId,
          reason: 'cursor-advanced',
        });
        const session = await manager.loadSession();
        // The discriminator against the tombstone test: `session.claims` holds
        // active claims only, so the bearer still being there proves this
        // refusal came from the liveness classification rather than a lookup of
        // a retired claim. Without it both tests would pass on either arm.
        expect(Object.keys(session.claims)).toContain(claimed.claim.claimKey);
        expect(session.stashedRunbookId).toBeUndefined();
      });

      it('refuses a claim whose parent state is unreadable without touching the slot', async () => {
        // `claims.parent_run_id` is ON DELETE SET NULL, not CASCADE, so deleting
        // the parent leaves the claim active with its persisted delegation still
        // naming the vanished run — the same fixture `getActiveForClaimId`
        // reports as unlinked/parent-missing. `classifyDelegationLiveness` calls
        // that `parent-unreadable` and the taxonomy keeps it separate from
        // `closed`: a delegated claim naming an unreadable parent is a database
        // integrity signal, never a routine end-of-delegation.
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'f');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );

        await manager.delete(parent.id);

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimed.claimId));

        expect(result.status).toBe('parent-missing');
        if (result.status === 'parent-missing') {
          expect(result.claim.claimKey).toBe(claimed.claim.claimKey);
        }
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('refuses an execution-owned run before deciding anything about the bearer', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        holdExecutionLease(run.id);

        const outcome = await sessionService.stashForClaimId(claimId);

        expect(outcome.kind).toBe('execution_in_progress');
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('reports an unknown bearer as missing-claim without touching the slot', async () => {
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(run.id));

        const unknown = assertClaimId(`rdclm_${'0'.repeat(32)}_${'A'.repeat(43)}` satisfies string);
        const result = unwrapSessionMutation(await sessionService.stashForClaimId(unknown));

        expect(result).toEqual({ status: 'missing-claim', claimId: unknown });
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('refuses a tampered secret on an otherwise active claim without touching the slot', async () => {
        // Distinct from the unknown-bearer case above: the claim key IS active
        // in the session, but the presented secret does not verify against it —
        // the in-transaction check that makes this method safer on the common
        // path than the bearer-blind session write it replaced (#666).
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        const tampered = assertClaimId(claimId.replace(/.$/, claimId.endsWith('A') ? 'B' : 'A'));

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(tampered));

        expect(result).toEqual({ status: 'missing-claim', claimId: tampered });
        expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
      });

      it('separates re-stashing the same claim from a slot held by another run', async () => {
        const first = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
          runbookPath: 'a.md',
        });
        const second = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
          runbookPath: 'b.md',
        });
        const { claimId: firstClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(first.id),
        );
        const { claimId: secondClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(second.id),
        );

        unwrapSessionMutation(await sessionService.stashForClaimId(firstClaim));

        const again = unwrapSessionMutation(await sessionService.stashForClaimId(firstClaim));
        expect(again.status).toBe('already-stashed');

        const blocked = unwrapSessionMutation(await sessionService.stashForClaimId(secondClaim));
        expect(blocked.status).toBe('slot-occupied');
        if (blocked.status === 'slot-occupied') {
          expect(blocked.stashedRunbookId).toBe(first.id);
        }
        expect((await manager.loadSession()).stashedRunbookId).toBe(first.id);
      });

      it.each(['completed', 'stopped'] as const)(
        'refuses a %s terminal child',
        async (lifecycle) => {
          const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
            runbookPath: 'solo.md',
          });
          const { claimId } = unwrapSessionMutation(
            await sessionService.pushRunbookWithRunControlClaim(run.id),
          );
          await manager.update(run.id, { lifecycle });

          const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

          expect(result.status).toBe('terminal-child');
          if (result.status === 'terminal-child') {
            expect(result.lifecycle).toBe(lifecycle);
          }
          expect((await manager.loadSession()).stashedRunbookId).toBeUndefined();
        },
      );

      it('reports a terminal controlled run ahead of a slot held by another run', async () => {
        // Precedence, not coverage: both refusals are simultaneously true here,
        // and `terminal-child` is the one that ends the caller's work while
        // `slot-occupied` invites a pop-and-retry that can only fail again. The
        // same ordering `getActiveForClaimId` states for its parked-runbook gate.
        const occupant = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
          runbookPath: 'a.md',
        });
        const terminal = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
          runbookPath: 'b.md',
        });
        const { claimId: occupantClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(occupant.id),
        );
        const { claimId: terminalClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(terminal.id),
        );
        unwrapSessionMutation(await sessionService.stashForClaimId(occupantClaim));
        await manager.update(terminal.id, { lifecycle: 'completed' });

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(terminalClaim));

        expect(result.status).toBe('terminal-child');
        if (result.status === 'terminal-child') {
          expect(result.lifecycle).toBe('completed');
          expect(result.claim.controlledRunId).toBe(terminal.id);
        }
        expect((await manager.loadSession()).stashedRunbookId).toBe(occupant.id);
      });

      it('leaves other claimed runs on the default stack when one is stashed', async () => {
        // A single-element stack can't distinguish "remove the matching id" from
        // "clear the whole stack" — both leave `defaultStack` at `[]`. A second,
        // untouched run on the stack is what actually pins the `.filter` call at
        // `session-service.ts:1578` against a mutant that clears it outright.
        const stashed = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
          runbookPath: 'a.md',
        });
        const other = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
          runbookPath: 'b.md',
        });
        const { claimId: stashedClaim } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(stashed.id),
        );
        unwrapSessionMutation(await sessionService.pushRunbookWithRunControlClaim(other.id));

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(stashedClaim));

        expect(result.status).toBe('stashed');
        const session = await manager.loadSession();
        expect(session.stashedRunbookId).toBe(stashed.id);
        expect(session.defaultStack).toEqual([other.id]);
      });

      // Both claim-targeted stash methods hand the CLI a `VerifiedClaim`, never
      // the persisted `ClaimRecord`. The record carries `secretHash` — the
      // bearer proof — so an arm returning it is one careless
      // `output.detail(result.claim)` away from printing it. Asserted as the
      // exact key set rather than "no secretHash" so a field added to
      // `ClaimRecord` later cannot widen the seam without failing here, and
      // asserted on both methods in one object so a fix applied to only one of
      // the two mirrored unions is named in the diff.
      it('returns a verified claim, not the persisted record, from both stash and pop', async () => {
        const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
          runbookPath: 'parent.md',
        });
        const linkage = linkageFor(parent.id, 'a');
        const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
          runbookPath: 'child.md',
          parentLinkage: linkage,
        });
        const claimed = assertClaimed(
          await claimLiveDelegation(sessionService, manager, child.id, linkage),
        );

        const stashResult = unwrapSessionMutation(
          await sessionService.stashForClaimId(claimed.claimId),
        );
        const popResult = unwrapSessionMutation(
          await sessionService.unstashForClaimId(claimed.claimId),
        );

        expect({ stash: stashResult.status, pop: popResult.status }).toEqual({
          stash: 'stashed',
          pop: 'restored',
        });
        if (stashResult.status !== 'stashed' || popResult.status !== 'restored') return;
        const verifiedShape = ['claimKey', 'controlledRunId', 'delegation', 'grants'];
        expect({
          stashClaimKeys: Object.keys(stashResult.claim).sort(),
          popClaimKeys: Object.keys(popResult.claim).sort(),
        }).toEqual({ stashClaimKeys: verifiedShape, popClaimKeys: verifiedShape });
      });
    });

    it('stash preserves a claim record and unstashForClaimId restores only the matching child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('stashed');
      }

      const restored = unwrapSessionMutation(
        await sessionService.unstashForClaimId(claimed.claimId),
      );
      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.state.id).toBe(child.id);
      }
      expect(await sessionService.getStashedRunbookId()).toBeNull();

      // After pop the claim is active again.
      expect((await sessionService.getActiveForClaimId(claimed.claimId)).status).toBe('claimed');
    });

    it('unstashForClaimId distinguishes absent claim from non-stashed claim', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      const absent = unwrapSessionMutation(
        await sessionService.unstashForClaimId(
          assertClaimId(
            'rdclm_11111111111111111111111111111111_abcdefghijklmnopqrstuvwxyzABCDE1234567890-_',
          ),
        ),
      );
      expect(absent.status).toBe('missing-claim');

      const notStashed = unwrapSessionMutation(
        await sessionService.unstashForClaimId(claimed.claimId),
      );
      expect(notStashed.status).toBe('not-stashed');
      if (notStashed.status === 'not-stashed') {
        expect(notStashed.claim.controlledRunId).toBe(child.id);
      }
    });

    it('unstashForClaimId reports a retired non-delegated claim as claim-rotated', async () => {
      // The pop path's tombstone branch, for a claim with no delegation to classify
      // against: a run-control claim that was released while its run sat in the
      // stash. Mutation testing found this branch unreached — its optional-chain and
      // parent-read ternary both survived, because every other pop test presents a
      // delegated claim.
      const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
        runbookPath: 'solo.md',
      });
      await sessionService.pushRunbook(run.id);
      const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));
      unwrapSessionMutation(await stashRunbookUnverified(manager, run.id));
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: run.id, role: 'collateral' }]),
      );

      const result = unwrapSessionMutation(await sessionService.unstashForClaimId(claimId));

      expect(result.status).toBe('superseded');
      if (result.status === 'superseded') {
        expect(result.reason).toBe('claim-rotated');
      }
    });

    it('unstashForClaimId distinguishes terminal child and ended parent', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const terminalLinkage = linkageFor(parent.id, '1');
      const terminalChild = await manager.create(
        { source: 'project', path: 'terminal-child.md' },
        mockRunbook,
        {
          runbookPath: 'terminal-child.md',
          parentLinkage: terminalLinkage,
        },
      );
      const terminalClaimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, terminalChild.id, terminalLinkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, terminalChild.id));
      await manager.update(terminalChild.id, { lifecycle: 'completed' });

      const terminal = unwrapSessionMutation(
        await sessionService.unstashForClaimId(terminalClaimed.claimId),
      );
      expect(terminal.status).toBe('terminal-child');
      if (terminal.status === 'terminal-child') {
        expect(terminal.lifecycle).toBe('completed');
      }

      const endedParent = await manager.create(
        { source: 'project', path: 'ended-parent.md' },
        mockRunbook,
        {
          runbookPath: 'ended-parent.md',
        },
      );
      const endedLinkage = linkageFor(endedParent.id, '2');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: endedLinkage,
      });
      const endedClaimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, endedLinkage),
      );
      await manager.update(endedParent.id, { lifecycle: 'stopped' });
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: terminalChild.id, role: 'collateral' }]),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));

      // R2: ending the parent superseded the delegated claim. `rd pop` must say
      // so — a superseded bearer reported as `missing-claim` renders "does not
      // exist", which sends the holder looking for a copy/paste error instead of
      // back to the orchestrator.
      const parentEnded = unwrapSessionMutation(
        await sessionService.unstashForClaimId(endedClaimed.claimId),
      );
      expect(parentEnded.status).toBe('superseded');
      if (parentEnded.status === 'superseded') {
        expect(parentEnded.reason).toBe('parent-ended');
      }
    });

    it('unstashForClaimId refuses a stashed child whose linkage no longer matches its claim', async () => {
      // The pop-side partner of `stashForClaimId > refuses a delegated child
      // whose persisted linkage no longer matches its claim record`. Mutation
      // testing found this arm unreached on the pop path — the refusal's whole
      // block was NoCoverage, because every other pop test presents a claim
      // whose linkage still agrees. Same fixture shape as the stash test:
      // `claimRunbook` pins the incoming linkage against the child's persisted
      // one at claim time, so the only way to produce a divergence is to mutate
      // `parentLinkage` afterwards, which `linkageFor`'s varying fill does.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '3');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));

      await manager.update(child.id, { parentLinkage: linkageFor(parent.id, '4') });

      const result = unwrapSessionMutation(await sessionService.unstashForClaimId(claimed.claimId));

      expect(result.status).toBe('child-linkage-mismatch');
      if (result.status === 'child-linkage-mismatch') {
        expect(result.claim.claimKey).toBe(claimed.claim.claimKey);
      }
      // The refusal must leave the run parked. Emptying the slot on a refusal
      // would strand the run: pop is the only way out of the stash, and the
      // bearer that just failed to name it is the only one that ever could.
      // This is also what separates the refusal from a mutant that drops the
      // branch entirely and restores the run anyway.
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
    });

    it('unstashForClaimId refuses a stashed child whose parent state is unreadable', async () => {
      // The pop-side partner of `stashForClaimId > refuses a claim whose parent
      // state is unreadable without touching the slot`. `claims.parent_run_id`
      // is ON DELETE SET NULL rather than CASCADE, so deleting the parent
      // leaves the claim active with its persisted delegation still naming the
      // vanished run — which is what `classifyDelegationLiveness` reports as
      // `parent-unreadable`. Mutation testing found the arm NoCoverage: the two
      // pop tests that reach the classification at all both land on `closed`.
      //
      // The order matters. Parking the child first is what puts the pop past
      // the not-stashed guard, and the linkage check that precedes the parent
      // read still passes, because deleting the parent alters neither the
      // child's `parentLinkage` nor the claim's `delegation` — both go on
      // naming a run that is no longer there.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '5');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));

      await manager.delete(parent.id);

      const result = unwrapSessionMutation(await sessionService.unstashForClaimId(claimed.claimId));

      // Kept distinct from `superseded`: an unreadable parent is a database
      // integrity signal, never a routine end-of-delegation, and the two send
      // the holder to different places.
      expect(result.status).toBe('parent-missing');
      if (result.status === 'parent-missing') {
        expect(result.claim.claimKey).toBe(claimed.claim.claimKey);
      }
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
    });

    it('unstashForClaimId refuses a closed delegation the latch has not yet tombstoned', async () => {
      // `distinguishes terminal child and ended parent` already asserts pop
      // returns superseded — but it reaches that status by the TOMBSTONE arm:
      // ending the parent retires the claim, so the bearer is gone from
      // `session.claims` and the refusal is decided before the linkage and
      // liveness checks ever run. Mutation testing exposed the difference by
      // surviving `liveness.kind === 'closed'` → `false` with that test in the
      // suite. This is the pop-side partner of the stash test `refuses a closed
      // delegation the parent-side latch has not yet tombstoned`, and it enters
      // by the other arm: `invalidateClosedDelegatedClaims` skips an
      // execution-owned child, so owning the child across the parent's cursor
      // advance defers the tombstone and leaves the claim active over a
      // delegation that has already closed.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '6');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      // Park first: the stash write is guarded on the same run, so an
      // execution-owned child would refuse `execution_in_progress` instead.
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
      holdExecutionLease(child.id);
      await manager.update(parent.id, { step: '2' });
      releaseExecutionLease(child.id);

      const result = unwrapSessionMutation(await sessionService.unstashForClaimId(claimed.claimId));

      expect(result).toEqual({
        status: 'superseded',
        claimId: claimed.claimId,
        reason: 'cursor-advanced',
      });
      const session = await manager.loadSession();
      // The discriminator against the tombstone test: `session.claims` holds
      // active claims only, so the bearer still being present proves the
      // refusal came from the liveness classification rather than a lookup of a
      // retired claim. Without it this test would pass on either arm.
      expect(Object.keys(session.claims)).toContain(claimed.claim.claimKey);
      expect(session.stashedRunbookId).toBe(child.id);
    });

    it('unstashForClaimId refuses a stopped child, not only a completed one', async () => {
      // The terminal check is a disjunction over both terminal lifecycles, and
      // the sibling test above only ever presents `completed` — so mutation
      // testing found the `stopped` half could be deleted with the suite still
      // green. The two are distinct outcomes a runbook reaches by distinct
      // routes (`rundown complete` versus `rundown stop`), and pop must refuse
      // a run parked in either.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '7');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );
      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));
      await manager.update(child.id, { lifecycle: 'stopped' });

      const result = unwrapSessionMutation(await sessionService.unstashForClaimId(claimed.claimId));

      expect(result.status).toBe('terminal-child');
      if (result.status === 'terminal-child') {
        // The lifecycle rides on the refusal, so the holder is told which of
        // the two ended the run; asserting only the status would leave the
        // field free to report `completed` for a stopped child.
        expect(result.lifecycle).toBe('stopped');
      }
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
    });

    it('exposes a stashed claimed child read-only via includeStashed', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      unwrapSessionMutation(await stashRunbookUnverified(manager, child.id));

      // Default (write) gate refuses.
      const gated = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(gated.status).toBe('unlinked');
      if (gated.status === 'unlinked') {
        expect(gated.reason).toBe('stashed');
      }

      // includeStashed flips the gate so read-only commands like `rd status
      // --claim-id` can inspect the parked child.
      const inspected = await sessionService.getActiveForClaimId(claimed.claimId, {
        includeStashed: true,
      });
      expect(inspected.status).toBe('claimed');
      if (inspected.status === 'claimed') {
        expect(inspected.state.id).toBe(child.id);
        expect(inspected.claim.claimKey).toBe(claimed.claim.claimKey);
      }
    });

    it('releaseRuns clears defaultStack and claim records together when the child completes', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkage),
      );

      // Simulate the active-claimed-child state: child on default stack and
      // referenced by the claim record.
      await sessionService.pushRunbook(child.id);
      expect((await sessionService.getActive())?.id).toBe(child.id);

      // Child completes: terminal release pops the default-stack entry and
      // removes the claim record in one pass.
      await manager.update(child.id, { lifecycle: 'completed' });
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );

      const session = await manager.loadSession();
      expect(session.defaultStack).not.toContain(child.id);
      expect(session.claims[claimed.claim.claimKey]).toBeUndefined();

      // The claim id is now a retired tombstone rather than `unlinked`.
      const after = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(after.status).toBe('superseded');
    });

    it('lists open claimed children for a parent runbook', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);

      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a')),
      );

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([
        expect.objectContaining({
          claimKey: claimed.claim.claimKey,
          controlledRunId: child.id,
          delegation: expect.objectContaining({
            parentRunId: parent.id,
            parentStepId: '1.1',
          }),
        }),
      ]);
    });

    it('lists multiple open claimed children under one parent', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const childA = await manager.create({ source: 'project', path: 'a.md' }, mockRunbook, {
        runbookPath: 'a.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      const childB = await manager.create({ source: 'project', path: 'b.md' }, mockRunbook, {
        runbookPath: 'b.md',
        parentLinkage: linkageFor(parent.id, 'b', '1.2'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, childA.id, linkageFor(parent.id, 'a'));
      await claimLiveDelegation(
        sessionService,
        manager,
        childB.id,
        linkageFor(parent.id, 'b', '1.2'),
      );

      const open = await sessionService.listOpenClaimsForParent(parent.id);
      expect(open.map((claim) => claim.controlledRunId).sort()).toEqual(
        [childA.id, childB.id].sort(),
      );
    });

    it('returns only the open child when one of two siblings is terminal', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const openChild = await manager.create({ source: 'project', path: 'open.md' }, mockRunbook, {
        runbookPath: 'open.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      const doneChild = await manager.create({ source: 'project', path: 'done.md' }, mockRunbook, {
        runbookPath: 'done.md',
        parentLinkage: linkageFor(parent.id, 'b', '1.2'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, openChild.id, linkageFor(parent.id, 'a'));
      await claimLiveDelegation(
        sessionService,
        manager,
        doneChild.id,
        linkageFor(parent.id, 'b', '1.2'),
      );
      await manager.update(doneChild.id, { lifecycle: 'completed' });

      const open = await sessionService.listOpenClaimsForParent(parent.id);
      expect(open.map((claim) => claim.controlledRunId)).toEqual([openChild.id]);
    });

    it('does not list a completed claimed child as an open parent claim', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));
      await manager.update(child.id, { lifecycle: 'completed' });

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
    });

    it('does not list a stopped claimed child as an open parent claim', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));
      await manager.update(child.id, { lifecycle: 'stopped' });

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
    });

    it('excludes a claim whose child state is missing on disk', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));
      await manager.delete(child.id);

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
    });

    it('excludes claims belonging to a different parent', async () => {
      const parentA = await manager.create({ source: 'project', path: 'pa.md' }, mockRunbook, {
        runbookPath: 'pa.md',
      });
      const parentB = await manager.create({ source: 'project', path: 'pb.md' }, mockRunbook, {
        runbookPath: 'pb.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parentB.id, 'a'),
      });
      await sessionService.pushRunbook(parentB.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parentB.id, 'a'));

      await expect(sessionService.listOpenClaimsForParent(parentA.id)).resolves.toEqual([]);
    });

    it('does not list claims whose child linkage no longer matches the parent claim', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));

      // Diverge the child's persisted linkage tokenHash from the claim record so
      // linkageMatchesClaim() returns false (same field set getActiveForClaimId
      // checks). A different `fill` produces a different delegation tokenHash.
      // (Plan used 'z'; that is not valid hex, so we use 'f' — a valid hex fill
      // distinct from the claim's 'a'.)
      await manager.update(child.id, { parentLinkage: linkageFor(parent.id, 'f') });

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
    });

    it('excludes a claim whose parent delegated substep has already resolved (stale after advance)', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      const claimed = assertClaimed(
        await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a')),
      );

      // Simulate the "advance wins the lock first" TOCTOU ordering: a concurrent
      // bare parent advance resolved the delegated substep before this claim
      // landed. Mark the parent's substep (parentStepId @ parentFrameKey from the
      // linkage) done while the child stays non-terminal. The claim is now stale
      // and must NOT count as open — otherwise it wedges future bare parent
      // transitions even though the parent has moved on.
      expect(claimed.claim.delegation).toBeDefined();
      if (!claimed.claim.delegation) return;
      await manager.update(parent.id, {
        substepStates: [
          {
            id: claimed.claim.delegation.parentStepId,
            frameKey: claimed.claim.delegation.parentFrameKey,
            status: 'done',
            result: 'pass',
          },
        ],
      });

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
    });
  });

  describe('claimAndInitialLink', () => {
    async function prepareInitialLink(input: {
      readonly parent: RunbookState;
      readonly child: RunbookState;
      readonly fill: string;
    }) {
      const linkage = linkageFor(input.parent.id, input.fill);
      await seedLiveDelegation(manager, linkage);
      await manager.update(input.parent.id, {
        activeFrameKey: linkage.parentFrameKey,
        activeEntry: linkage.parentEntry,
        frameEntryCounts: replace({ [linkage.parentFrameKey]: linkage.parentEntry }),
      });
      const issued = await sessionService.issueRunControlClaim(input.parent.id);
      expect(issued.kind).toBe('committed');

      const captured = await manager.captureRunAuthorityState(input.parent.id);
      if (captured.kind !== 'captured') {
        throw new Error(`Expected captured parent authority, got ${captured.kind}`);
      }
      const actorService = new RunbookActorService(manager);
      const prepared = await actorService.prepareDelegationChildLink(
        captured.state,
        mockSteps,
        input.child.id,
        linkage,
      );
      if (prepared.kind !== 'prepared') {
        throw new Error(`Expected prepared parent link, got ${prepared.kind}`);
      }
      return { linkage, captured, preparedParent: prepared.prepared };
    }

    function claimGeneration(runId: RunId): number {
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      try {
        const row = raw
          .prepare('SELECT claim_generation AS generation FROM runs WHERE id = :runId')
          .get({ runId }) as { readonly generation: number } | undefined;
        if (row === undefined) throw new Error(`Missing run ${runId}`);
        return row.generation;
      } finally {
        raw.close();
      }
    }

    async function prepareInitialUnlink(
      parentId: RunId,
      childId: RunId,
      linkage: Parameters<SessionService['claimRunbook']>[1],
    ) {
      const captured = await manager.captureRunAuthorityState(parentId);
      if (captured.kind !== 'captured') {
        throw new Error(`Expected recaptured parent authority, got ${captured.kind}`);
      }
      const actorService = new RunbookActorService(manager);
      const unlink = await actorService.prepareDelegationChildUnlink(
        captured.state,
        mockSteps,
        childId,
        linkage,
      );
      if (unlink.kind !== 'prepared') {
        throw new Error(`Expected prepared parent unlink, got ${unlink.kind}`);
      }
      return { captured, preparedParent: unlink.prepared };
    }

    it('commits one claim with the machine-derived parent link', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'a');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: 'a' });
      const beforeGeneration = claimGeneration(child.id);

      const result = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage: prepared.linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });

      expect(result.kind).toBe('committed');
      if (result.kind !== 'committed') throw new Error(`Expected commit, got ${result.kind}`);
      expect(result.value.status).toBe('claimed');
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          prepared.linkage.parentStepId,
          prepared.linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBe(child.id);
      expect(await sessionService.findClaimForDelegation(prepared.linkage)).toEqual(
        expect.objectContaining({ controlledRunId: child.id }),
      );
      expect(claimGeneration(child.id)).toBe(beforeGeneration + 1);
    });

    // GATE ORDERING, which is all a core test can pin here: liveness is decided
    // before the linkage predicate. The claim names entry 2 against a delegation
    // whose credential was issued at entry 1, so the entry-identity arm of
    // `classifyDelegationLiveness` closes it — and the CHILD row still carries
    // entry 1, so the linkage predicate a few lines later would refuse it too,
    // as `linkage-mismatch`. Only the order decides which the caller sees, and
    // `delegation-superseded` is the more truthful of the two: the delegation is
    // gone, not merely disagreed with. Remove the issuance drift below and this
    // test reports `linkage-mismatch`, which is the check that it is ordering,
    // not merely refusal, that is under assertion.
    //
    // This does NOT pin the CLI-side production change (`claimAndLaunch` reading
    // the entry off the credential): a `packages/core` test importing no CLI code
    // cannot break on a CLI revert, and this input shape is unreachable from
    // production anyway, since `claimChildForPipeline` calls
    // `prepareDelegationChildLink` first and refuses before it gets here. That
    // change is pinned by `cli/__tests__/helpers/claim-and-launch.test.ts`.
    it('refuses a claim naming an entry the delegation never issued, ahead of the linkage-mismatch gate', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const originalLinkage = linkageFor(parent.id, 'a');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: originalLinkage,
      });
      const reenteredLinkage = { ...originalLinkage, parentEntry: 2 };
      // Deliberate issuance-vs-claim drift: the parent's substep was issued at
      // entry 1 and the claim presents entry 2. Named, not inherited from a
      // fixture default.
      await seedLiveDelegation(manager, reenteredLinkage, { issuedEntry: 1 });
      const reenteredParent = await manager.update(parent.id, {
        activeFrameKey: reenteredLinkage.parentFrameKey,
        activeEntry: reenteredLinkage.parentEntry,
        frameEntryCounts: replace({
          [reenteredLinkage.parentFrameKey]: reenteredLinkage.parentEntry,
        }),
      });
      const issued = await sessionService.issueRunControlClaim(parent.id);
      expect(issued.kind).toBe('committed');
      const captured = await manager.captureRunAuthorityState(parent.id);
      if (captured.kind !== 'captured') {
        throw new Error(`Expected captured parent authority, got ${captured.kind}`);
      }
      const actorService = new RunbookActorService(manager);
      const prepared = await actorService.prepareDelegationChildLink(
        reenteredParent,
        mockSteps,
        child.id,
        reenteredLinkage,
      );
      if (prepared.kind !== 'prepared') {
        throw new Error(`Expected prepared parent link, got ${prepared.kind}`);
      }

      const result = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage: reenteredLinkage,
        capturedParent: captured.authority,
        preparedParent: prepared.prepared,
      });

      expect(result).toEqual({
        kind: 'committed',
        value: {
          status: 'delegation-superseded',
          parentRunId: parent.id,
          parentStepId: reenteredLinkage.parentStepId,
          childRunId: child.id,
        },
      });
      expect(await sessionService.findClaimForDelegation(reenteredLinkage)).toBeNull();
      // The child's own stamp is untouched, so nothing downstream can read the
      // re-entered coordinate as authority.
      expect((await manager.load(child.id))?.parentLinkage).toEqual(originalLinkage);
      expect(
        findSubstepState(
          (await manager.load(parent.id))?.substepStates ?? [],
          reenteredLinkage.parentStepId,
          reenteredLinkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
    });

    it('throws before mutation when initial-link parent coordinates disagree', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const otherParent = await manager.create(
        { source: 'project', path: 'other-parent.md' },
        mockRunbook,
        { runbookPath: 'other-parent.md' },
      );
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: 'e' });
      const beforeParent = await manager.load(parent.id);

      await expect(
        sessionService.claimAndInitialLink({
          childRunId: child.id,
          linkage: { ...linkage, parentRunId: otherParent.id },
          capturedParent: prepared.captured.authority,
          preparedParent: prepared.preparedParent,
        }),
      ).rejects.toThrow('Initial delegation link names different parent runs');
      expect(await manager.load(parent.id)).toEqual(beforeParent);
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
    });

    it('refuses when the delegation was already claimed by another child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '6');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const foreignChild = await manager.create(
        { source: 'project', path: 'foreign-child.md' },
        mockRunbook,
        { runbookPath: 'foreign-child.md', parentLinkage: linkage },
      );
      const prepared = await prepareInitialLink({ parent, child, fill: '6' });
      assertClaimed(
        unwrapSessionMutation(await sessionService.claimRunbook(foreignChild.id, linkage)),
      );
      const beforeParent = await manager.load(parent.id);

      const result = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });

      expect(result).toEqual({
        kind: 'committed',
        value: expect.objectContaining({
          status: 'already-claimed',
          childRunId: foreignChild.id,
        }),
      });
      expect(await manager.load(parent.id)).toEqual(beforeParent);
      expect(await sessionService.findClaimForDelegation(linkage)).toEqual(
        expect.objectContaining({ controlledRunId: foreignChild.id }),
      );
    });

    it('rejects an unlink mutation passed to the initial claim operation', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '0');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: '0' });
      const invalidInput = {
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: { ...prepared.preparedParent, operation: 'unlink' },
      } as unknown as Parameters<SessionService['claimAndInitialLink']>[0];

      await expect(sessionService.claimAndInitialLink(invalidInput)).rejects.toThrow(
        'Initial delegation link received the wrong mutation operation',
      );
    });

    it('atomically rolls back the exact initial claim and machine-derived parent link', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: 'f' });
      const linked = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });
      expect(linked.kind).toBe('committed');

      const unlink = await prepareInitialUnlink(parent.id, child.id, linkage);

      const rolledBack = await sessionService.rollbackInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: unlink.captured.authority,
        preparedParent: unlink.preparedParent,
      });
      expect(rolledBack).toEqual({ kind: 'committed', value: { status: 'rolled-back' } });
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
    });

    it('rejects a link mutation passed to rollback', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: '1' });
      const invalidInput = {
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      } as unknown as Parameters<SessionService['rollbackInitialLink']>[0];

      await expect(sessionService.rollbackInitialLink(invalidInput)).rejects.toThrow(
        'Initial delegation rollback received the wrong mutation operation',
      );
    });

    it('refuses rollback when the delegation claim is controlled by a different child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '7');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: '7' });
      const linked = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });
      expect(linked.kind).toBe('committed');

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );
      const foreignChild = await manager.create(
        { source: 'project', path: 'foreign-child.md' },
        mockRunbook,
        { runbookPath: 'foreign-child.md', parentLinkage: linkage },
      );
      assertClaimed(
        unwrapSessionMutation(await sessionService.claimRunbook(foreignChild.id, linkage)),
      );
      const unlink = await prepareInitialUnlink(parent.id, child.id, linkage);

      const result = await sessionService.rollbackInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: unlink.captured.authority,
        preparedParent: unlink.preparedParent,
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'concurrent_modification', runId: parent.id }),
      );
      expect(await sessionService.findClaimForDelegation(linkage)).toEqual(
        expect.objectContaining({ controlledRunId: foreignChild.id }),
      );
      expect(
        findSubstepState(
          (await manager.load(parent.id))?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBe(child.id);
    });

    it('reports already-absent and still unlinks the parent when no claim exists', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, '8');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: '8' });
      await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });
      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );
      const unlink = await prepareInitialUnlink(parent.id, child.id, linkage);

      const result = await sessionService.rollbackInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: unlink.captured.authority,
        preparedParent: unlink.preparedParent,
      });

      expect(result).toEqual({ kind: 'committed', value: { status: 'already-absent' } });
      expect(
        findSubstepState(
          (await manager.load(parent.id))?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
      expect(await sessionService.findClaimForDelegation(linkage)).toBeNull();
    });

    it('throws before mutation when rollback parent coordinates disagree', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const otherParent = await manager.create(
        { source: 'project', path: 'other-parent.md' },
        mockRunbook,
        { runbookPath: 'other-parent.md' },
      );
      const linkage = linkageFor(parent.id, '9');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: '9' });
      await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });
      const unlink = await prepareInitialUnlink(parent.id, child.id, linkage);
      const mismatchedLinkage = { ...linkage, parentRunId: otherParent.id };

      await expect(
        sessionService.rollbackInitialLink({
          childRunId: child.id,
          linkage: mismatchedLinkage,
          capturedParent: unlink.captured.authority,
          preparedParent: unlink.preparedParent,
        }),
      ).rejects.toThrow('Initial delegation rollback names different parent runs');
      expect(await manager.load(parent.id)).toEqual(unlink.captured.state);
      expect(await sessionService.findClaimForDelegation(linkage)).not.toBeNull();
    });

    it('returns concurrent_modification after a parent CAS interleave without claiming or overwriting the parent', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: 'b' });
      await manager.update(parent.id, { variables: merge({ winner: 'interleaved' }) });

      const result = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage: prepared.linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });

      expect(result).toEqual(
        expect.objectContaining({ kind: 'concurrent_modification', runId: parent.id }),
      );
      expect(await sessionService.findClaimForDelegation(prepared.linkage)).toBeNull();
      const persistedParent = await manager.load(parent.id);
      expect(persistedParent?.variables).toEqual({ winner: 'interleaved' });
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          prepared.linkage.parentStepId,
          prepared.linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
    });

    it('returns typed missing when the child disappears without writing the parent', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'c');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const prepared = await prepareInitialLink({ parent, child, fill: 'c' });
      const beforeParent = await manager.load(parent.id);
      await manager.delete(child.id);

      const result = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage: prepared.linkage,
        capturedParent: prepared.captured.authority,
        preparedParent: prepared.preparedParent,
      });

      expect(result).toEqual(expect.objectContaining({ kind: 'missing', runId: child.id }));
      expect(await manager.load(parent.id)).toEqual(beforeParent);
      expect(await sessionService.findClaimForDelegation(prepared.linkage)).toBeNull();
    });

    it('is idempotent after recapture and bumps the child claim generation only once', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'd');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const firstPrepared = await prepareInitialLink({ parent, child, fill: 'd' });
      const beforeGeneration = claimGeneration(child.id);
      const first = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage: firstPrepared.linkage,
        capturedParent: firstPrepared.captured.authority,
        preparedParent: firstPrepared.preparedParent,
      });
      expect(first.kind).toBe('committed');
      if (first.kind !== 'committed') throw new Error(`Expected commit, got ${first.kind}`);
      if (first.value.status !== 'claimed') {
        throw new Error(`Expected first claim, got ${first.value.status}`);
      }
      expect(claimGeneration(child.id)).toBe(beforeGeneration + 1);

      const capturedAgain = await manager.captureRunAuthorityState(parent.id);
      if (capturedAgain.kind !== 'captured') {
        throw new Error(`Expected recaptured parent authority, got ${capturedAgain.kind}`);
      }
      const actorService = new RunbookActorService(manager);
      const preparedAgain = await actorService.prepareDelegationChildLink(
        capturedAgain.state,
        mockSteps,
        child.id,
        linkage,
      );
      if (preparedAgain.kind !== 'prepared') {
        throw new Error(`Expected prepared parent link, got ${preparedAgain.kind}`);
      }
      const second = await sessionService.claimAndInitialLink({
        childRunId: child.id,
        linkage,
        capturedParent: capturedAgain.authority,
        preparedParent: preparedAgain.prepared,
      });

      expect(second.kind).toBe('committed');
      if (second.kind !== 'committed') throw new Error(`Expected commit, got ${second.kind}`);
      expect(second.value).toEqual(expect.objectContaining({ status: 'already-claimed' }));
      if (second.value.status !== 'already-claimed') {
        throw new Error(`Expected replayed claim, got ${second.value.status}`);
      }
      expect(second.value.claim.claimKey).toBe(first.value.claim.claimKey);
      expect(claimGeneration(child.id)).toBe(beforeGeneration + 1);
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(2);
    });
  });

  describe('runGuardedParentAdvance', () => {
    it('runs the advance when the parent has no open claimed children', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      await sessionService.pushRunbook(parent.id);

      let ran = false;
      const result = await sessionService.runGuardedParentAdvance(parent.id, async () => {
        ran = true;
        return 'advanced-value';
      });

      expect(ran).toBe(true);
      expect(result).toEqual({ kind: 'advanced', value: 'advanced-value' });
    });

    it('refuses the advance (without running it) when an open claimed child exists', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));

      let ran = false;
      const result = await sessionService.runGuardedParentAdvance(parent.id, async () => {
        ran = true;
        return 'should-not-run';
      });

      expect(ran).toBe(false);
      expect(result.kind).toBe('open_delegated_children');
      if (result.kind === 'open_delegated_children') {
        expect(result.claims.map((claim) => claim.controlledRunId)).toEqual([child.id]);
      }
    });

    it('advances when the parent has open claims that have since gone terminal', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);
      await claimLiveDelegation(sessionService, manager, child.id, linkageFor(parent.id, 'a'));
      // The claimed child completed — it is no longer an open claim, so the
      // parent advance is permitted.
      await manager.update(child.id, { lifecycle: 'completed' });

      const result = await sessionService.runGuardedParentAdvance(parent.id, async () => 'ok');

      expect(result).toEqual({ kind: 'advanced', value: 'ok' });
    });

    it('refuses the guarded advance when a claim commits inside the window, preserving the bearer', async () => {
      // REWRITES the former test that asserted the claim was superseded and the advance
      // succeeded — that was the defect. The check is now atomic with the decisive write:
      // a claim committing before the write refuses the advance and keeps the bearer, exactly
      // as the retired session lock did (claim-first ⇒ advance refused).
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);

      // A second SessionService models a second process racing the same database.
      const claimant = new SessionService(new RunbookStateManager(testDir));
      const linkage = linkageFor(parent.id, 'a');
      // Seed the parent's live delegation so the racing claim passes the R2 claim-side latch.
      await seedLiveDelegation(manager, linkage);

      let claimed: Extract<ClaimRunbookResult, { status: 'claimed' }> | undefined;

      const advanceResult = await sessionService.runGuardedParentAdvance(
        parent.id,
        async (guard) => {
          // Claim commits INSIDE the window, before the guarded decisive write.
          claimed = assertClaimed(
            unwrapSessionMutation(await claimant.claimRunbook(child.id, linkage)),
          );
          // The decisive write, carrying the guard: resolve the delegated substep.
          await manager.update(
            parent.id,
            {
              substepStates: [
                {
                  id: linkage.parentStepId,
                  frameKey: linkage.parentFrameKey,
                  status: 'done',
                  result: 'pass',
                },
              ],
            },
            { guard },
          );
          return 'advanced';
        },
      );

      // The claim did commit — a real interleave — and the guard refused the advance.
      expect(claimed?.claim.controlledRunId).toBe(child.id);
      expect(advanceResult.kind).toBe('open_delegated_children');
      if (advanceResult.kind === 'open_delegated_children') {
        expect(advanceResult.claims.map((c) => c.controlledRunId)).toEqual([child.id]);
      }

      // The claimant's bearer is still ACTIVE — not superseded.
      const verification = await claimant.verifyClaimId(assertClaimId(claimed!.claimId));
      expect(verification.status).toBe('verified');

      // The parent did NOT advance: the decisive write rolled back. Asserted as the
      // EXACT post-rollback value, not `not.toBe('done')` — the negative also holds
      // when the parent fails to load or the substep vanishes, neither of which is
      // the rollback being proven. `seedLiveDelegation` left this substep 'running'.
      const parentAfter = await manager.load(parent.id);
      expect(parentAfter).toBeDefined();
      expect(
        findSubstepState(
          parentAfter?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.status,
      ).toBe('running');

      // The child is intact — still running, not merely "not terminal".
      const childAfter = await manager.load(child.id);
      expect(childAfter?.lifecycle).toBe('running');
    });

    it('propagates a non-guard failure from the advance unchanged', async () => {
      // The catch narrows on OpenDelegatedChildrenError and rethrows everything else.
      // Without that narrowing, ANY failure raised inside the decisive write — a
      // schema rejection on corrupt state, a driver error, a bug in sendAndSync —
      // would reach the caller as `open_delegated_children`: a refusal naming a cause
      // that did not occur, against a claim list read off an unrelated error object.
      // That is the RD-102 masking class, and the failure would be lost entirely.
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      await sessionService.pushRunbook(parent.id);

      const failure = new Error('the decisive write failed');
      // toBe, not toThrow: the contract is that the SAME error object surfaces, not
      // merely that something with a matching message does.
      await expect(
        sessionService.runGuardedParentAdvance(parent.id, () => Promise.reject(failure)),
      ).rejects.toBe(failure);
    });

    it('refuses the advance when a delegation outcome is waiting for collection', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      await sessionService.pushRunbook(parent.id);
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.update(parent.id, {
        step: '1',
        substep: '1',
        activeFrameKey: buildFrameKey('1'),
        activeEntry: 1,
        frameEntryCounts: replace({ [buildFrameKey('1')]: 1 }),
        resolvedCompletions: merge({
          [key]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        }),
      });

      let ran = false;
      const result = await sessionService.runGuardedParentAdvance(parent.id, async () => {
        ran = true;
        return 'should-not-run';
      });

      expect(ran).toBe(false);
      expect(result).toEqual({
        kind: 'delegation_collection_pending',
        parentRunId: parent.id,
        outcomeCompletionKeys: [key],
        message:
          'A delegated claim has reported an outcome that must be collected by the orchestrator.',
      });
    });
  });

  describe('releaseRuns default stack cleanup', () => {
    it('releaseRuns pops a default-stack child by id', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );

      // The release reports nothing, so the new top is read back off the
      // session: the run left the stack and the entry under it became active.
      expect((await manager.loadSession()).defaultStack).toEqual([parent.id]);
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });

    it('releaseRuns removes a non-top default-stack entry by id', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      const sibling = await manager.create({ source: 'project', path: 'sibling.md' }, mockRunbook, {
        runbookPath: 'sibling.md',
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);
      await sessionService.pushRunbook(sibling.id);

      unwrapSessionMutation(
        await sessionService.releaseRuns([{ runId: child.id, role: 'collateral' }]),
      );

      // Only the named entry left; the one above it is still the top.
      expect((await manager.loadSession()).defaultStack).toEqual([parent.id, sibling.id]);
      expect((await sessionService.getActive())?.id).toBe(sibling.id);
      unwrapSessionMutation(await popTopOfStackUnverified(manager));
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });

    it('releaseRuns removes all force-terminal chain ids in one session mutation', async () => {
      const sibling = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
      });
      const root = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const leaf = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });

      await sessionService.pushRunbook(sibling.id);
      await sessionService.pushRunbook(root.id);
      await sessionService.pushRunbook(leaf.id);

      // Both `collateral`: this case is about the stack, and the bare
      // multi-run release it replaces revoked every member's claims.
      unwrapSessionMutation(
        await sessionService.releaseRuns([
          { runId: leaf.id, role: 'collateral' },
          { runId: root.id, role: 'collateral' },
        ]),
      );

      // Both chain members left the stack in the one mutation, and the
      // untouched sibling is what the session now targets.
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([sibling.id]);
    });

    it('releaseRuns can retain the terminal root claim while removing descendant claims', async () => {
      const root = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const leaf = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const rootClaim = unwrapSessionMutation(await sessionService.issueRunControlClaim(root.id));
      const leafClaim = unwrapSessionMutation(await sessionService.issueRunControlClaim(leaf.id));

      unwrapSessionMutation(
        await sessionService.releaseRuns([
          { runId: leaf.id, role: 'collateral' },
          { runId: root.id, role: 'addressed' },
        ]),
      );

      const session = await manager.loadSession();
      expect(session.claims[rootClaim.claim.claimKey]).toBeDefined();
      expect(session.claims[leafClaim.claim.claimKey]).toBeUndefined();
    });
  });

  describe('resolveActiveInlineForceTerminalPlan', () => {
    it('targets the outermost contiguous-inline ancestor and cascades descendants first', async () => {
      const root = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'running' });
      const middle = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: root.id,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });
      const leaf = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: middle.id,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });

      await sessionService.pushRunbook(root.id);
      await sessionService.pushRunbook(middle.id);
      await sessionService.pushRunbook(leaf.id);

      const result = await sessionService.resolveActiveInlineForceTerminalPlan('complete');

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('expected resolved plan');
      expect(result.activeState.id).toBe(leaf.id);
      expect(result.targetState.id).toBe(root.id);
      expect(result.descendantStates.map((state) => state.id)).toEqual([leaf.id, middle.id]);
      expect(result.forceOrder.map((state) => state.id)).toEqual([leaf.id, middle.id, root.id]);
      expect(result.releaseRunIds).toEqual([leaf.id, middle.id, root.id]);
    });

    it('stops at a delegation boundary and targets the inline root inside the delegated child', async () => {
      const delegatedInlineRoot = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
        parentLinkage: {
          kind: 'delegation',
          parentRunId: mintInlineForceRunId(),
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
        },
      });
      const inlineLeaf = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: delegatedInlineRoot.id,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });

      await sessionService.pushRunbook(delegatedInlineRoot.id);
      await sessionService.pushRunbook(inlineLeaf.id);

      const result = await sessionService.resolveActiveInlineForceTerminalPlan('stop');

      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('expected resolved plan');
      expect(result.targetState.id).toBe(delegatedInlineRoot.id);
      expect(result.targetState.parentLinkage?.kind).toBe('delegation');
      expect(result.forceOrder.map((state) => state.id)).toEqual([
        inlineLeaf.id,
        delegatedInlineRoot.id,
      ]);
    });

    it('fails closed when an inline parent is missing', async () => {
      const missingParentId = mintInlineForceRunId();
      const leaf = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: missingParentId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });

      await sessionService.pushRunbook(leaf.id);

      await expect(
        sessionService.resolveActiveInlineForceTerminalPlan('complete'),
      ).resolves.toEqual({
        status: 'missing-inline-parent',
        kind: 'complete',
        activeState: expect.objectContaining({ id: leaf.id }),
        missingParentRunId: missingParentId,
      });
    });

    it('fails closed when an inline parent chain forms a cycle', async () => {
      const rootId = mintInlineForceRunId();
      const leafId = mintInlineForceRunId();
      const root = await makeState(manager, {
        id: rootId,
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: leafId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });
      const leaf = await makeState(manager, {
        id: leafId,
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: root.id,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });

      await sessionService.pushRunbook(root.id);
      await sessionService.pushRunbook(leaf.id);

      await expect(sessionService.resolveActiveInlineForceTerminalPlan('stop')).resolves.toEqual({
        status: 'inline-cycle',
        kind: 'stop',
        activeState: expect.objectContaining({ id: leaf.id }),
        repeatedRunId: leaf.id,
      });
    });

    it('returns none when no runbook is active', async () => {
      const result = await sessionService.resolveActiveInlineForceTerminalPlan('complete');
      expect(result).toEqual({ status: 'none', kind: 'complete' });
    });
  });
});

describe('projectStackPop', () => {
  // The undo of a bare `defaultStack.push`. Exercised directly because its
  // narrow input is the point: it takes the stack array, so a session field it
  // must not touch is not reachable from inside it.
  const RUN_ID = brandRunIdForTest(`rd_${'a'.repeat(32)}`);
  const OTHER_RUN_ID = brandRunIdForTest(`rd_${'b'.repeat(32)}`);

  it('removes the topmost entry for the run', () => {
    const stack = [OTHER_RUN_ID, RUN_ID];

    projectStackPop(stack, RUN_ID);

    expect(stack).toEqual([OTHER_RUN_ID]);
  });

  it('leaves a lower entry for the same run in place', () => {
    const stack = [RUN_ID, OTHER_RUN_ID, RUN_ID];

    projectStackPop(stack, RUN_ID);

    expect(stack).toEqual([RUN_ID, OTHER_RUN_ID]);
  });

  // Without the `index === -1` guard, `splice(-1, 1)` removes the LAST entry —
  // so an absent run would cost whoever holds the top their stack entry.
  it('removes nothing when the run is not on the stack', () => {
    const stack = [OTHER_RUN_ID];

    projectStackPop(stack, RUN_ID);

    expect(stack).toEqual([OTHER_RUN_ID]);
  });

  it('removes nothing from an empty stack', () => {
    const stack: RunId[] = [];

    projectStackPop(stack, RUN_ID);

    expect(stack).toEqual([]);
  });

  it('mutates the array in place rather than replacing it', () => {
    const stack = [OTHER_RUN_ID, RUN_ID];
    const same = stack;

    projectStackPop(stack, RUN_ID);

    // The caller passes `session.defaultStack` and reads the new top back off
    // the same reference, so a reassignment would leave the session unchanged.
    expect(same).toEqual([OTHER_RUN_ID]);
  });
});
