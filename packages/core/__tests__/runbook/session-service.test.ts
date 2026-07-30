import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunbookStateManager, type SessionData } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { SessionService, projectRunbookRelease } from '../../src/runbook/session-service.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
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
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
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

    it('popRunbook removes from stack and returns new top', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });

      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const newTopId = unwrapSessionMutation(await sessionService.popRunbook());
      expect(newTopId).toBe(parent.id);

      const active = await sessionService.getActive();
      expect(active?.id).toBe(parent.id);
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
      unwrapSessionMutation(await sessionService.popRunbook());
      expect((await sessionService.getActive())?.id).toBe(wf2.id);
      unwrapSessionMutation(await sessionService.popRunbook());
      expect((await sessionService.getActive())?.id).toBe(wf1.id);
      unwrapSessionMutation(await sessionService.popRunbook());
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

    it('unstash returns null and clears stash when persisted state is missing', async () => {
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
      const state = await manager.create({ source: 'project', path: 'atomic.md' }, mockRunbook, {
        runbookPath: 'atomic.md',
      });
      await sessionService.pushRunbook(state.id);
      const loadSession = jest.spyOn(manager, 'loadSession');
      const load = jest.spyOn(manager, 'load');
      const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

      const result = unwrapSessionMutation(await sessionService.stash());

      expect(result.status).toBe('stashed');
      // Asserted as one named object so the failure diff says which property
      // moved: a non-zero unlocked read is a resolve-then-commit split, and a
      // second guarded transaction is the same defect wearing a lock.
      expect({
        guardedTransactions: mutateSessionGuarded.mock.calls.length,
        unlockedSessionReads: loadSession.mock.calls.length,
        unlockedStateReads: load.mock.calls.length,
      }).toEqual({ guardedTransactions: 1, unlockedSessionReads: 0, unlockedStateReads: 0 });
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

      unwrapSessionMutation(await sessionService.releaseRunbook(run.id));

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
      unwrapSessionMutation(await sessionService.releaseRunbook(run.id));

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
      unwrapSessionMutation(await sessionService.stashRunbook(child.id));
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
        unwrapSessionMutation(await sessionService.stashRunbook(child.id));
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
      unwrapSessionMutation(await sessionService.stashRunbook(run.id));

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
      unwrapSessionMutation(await sessionService.stashRunbook(child.id));

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
      unwrapSessionMutation(await sessionService.stashRunbook(child.id));
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

    it('releaseRunbook removes matching claim records', async () => {
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

      unwrapSessionMutation(await sessionService.releaseRunbook(child.id));

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

    it('releaseRunbook({ retainClaimsAsTerminal: true }) keeps the claim as a terminal tombstone', async () => {
      const { claimId, childRunId } = await setupClaimedChild('e', 'completed');

      const result = unwrapSessionMutation(
        await sessionService.releaseRunbook(childRunId, {
          retainClaimsAsTerminal: true,
        }),
      );

      expect(result.status).toBe('released');
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('completed');
      }
    });

    it('releaseRunbook() (default) still deletes the claim record', async () => {
      const { claimId, childRunId } = await setupClaimedChild('7', 'completed');

      unwrapSessionMutation(await sessionService.releaseRunbook(childRunId));

      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('superseded');
      if (resolution.status === 'superseded') {
        expect(resolution.reason).toBe('claim-rotated');
      }
    });

    it('releaseRunbook({ retainClaimsAsTerminal: true }) keeps a stopped child as a terminal tombstone', async () => {
      // Sibling of the `completed` tombstone test: a stopped (aborted/failed)
      // child must also retain its claim as a terminal tombstone so a later
      // getActiveForClaimId resolves `terminal` rather than `missing`, and the
      // resolved lifecycle reflects `stopped`.
      const { claimId, childRunId } = await setupClaimedChild('d', 'stopped');

      const result = unwrapSessionMutation(
        await sessionService.releaseRunbook(childRunId, {
          retainClaimsAsTerminal: true,
        }),
      );

      expect(result.status).toBe('released');
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('stopped');
      }
    });

    it('pruneClaimsForChildren removes claims pointing at the given child run ids', async () => {
      const { claimId, claimKey, childRunId } = await setupClaimedChild('6', 'completed');
      unwrapSessionMutation(
        await sessionService.releaseRunbook(childRunId, { retainClaimsAsTerminal: true }),
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
        await sessionService.releaseRunbook(a.childRunId, { retainClaimsAsTerminal: true }),
      );
      unwrapSessionMutation(
        await sessionService.releaseRunbook(b.childRunId, { retainClaimsAsTerminal: true }),
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
        await sessionService.releaseRunbook(childRunId, { retainClaimsAsTerminal: true }),
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
        // existed the stash committed, because `stashRunbook` authorized on the
        // run id alone and `mintRunControlClaim` keeps the run claim-targeted.
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
        const run = await manager.create({ source: 'project', path: 'solo.md' }, mockRunbook, {
          runbookPath: 'solo.md',
        });
        const { claimId } = unwrapSessionMutation(
          await sessionService.pushRunbookWithRunControlClaim(run.id),
        );
        const loadSession = jest.spyOn(manager, 'loadSession');
        const load = jest.spyOn(manager, 'load');
        const mutateSessionGuarded = jest.spyOn(manager, 'mutateSessionGuarded');

        const result = unwrapSessionMutation(await sessionService.stashForClaimId(claimId));

        expect(result.status).toBe('stashed');
        // One named object so the failure diff says which property moved: a
        // non-zero unlocked read is a resolve-then-commit split, and a second
        // guarded transaction is the same defect wearing a lock.
        expect({
          guardedTransactions: mutateSessionGuarded.mock.calls.length,
          unlockedSessionReads: loadSession.mock.calls.length,
          unlockedStateReads: load.mock.calls.length,
        }).toEqual({ guardedTransactions: 1, unlockedSessionReads: 0, unlockedStateReads: 0 });
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
        // the in-transaction check that makes this method safer than
        // `stashRunbook` on the common path (#666).
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

      unwrapSessionMutation(await sessionService.stashRunbook(child.id));
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
      unwrapSessionMutation(await sessionService.stashRunbook(run.id));
      unwrapSessionMutation(await sessionService.releaseRunbook(run.id));

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
      unwrapSessionMutation(await sessionService.stashRunbook(terminalChild.id));
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
      unwrapSessionMutation(await sessionService.releaseRunbook(terminalChild.id));
      unwrapSessionMutation(await sessionService.stashRunbook(child.id));

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

      unwrapSessionMutation(await sessionService.stashRunbook(child.id));

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

    it('releaseRunbook clears defaultStack and claim records together when the child completes', async () => {
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
      const released = unwrapSessionMutation(await sessionService.releaseRunbook(child.id));
      expect(released.status).toBe('released');

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

      await sessionService.releaseRunbook(child.id);
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
      await sessionService.releaseRunbook(child.id);
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

  describe('releaseRunbook default stack cleanup', () => {
    it('releaseRunbook pops a default-stack child by id', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const released = unwrapSessionMutation(await sessionService.releaseRunbook(child.id));
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(true);
        expect(released.nextDefaultRunbookId).toBe(parent.id);
      }
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });

    it('releaseRunbook removes a non-top default-stack entry by id', async () => {
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

      const released = unwrapSessionMutation(await sessionService.releaseRunbook(child.id));
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(true);
        expect(released.nextDefaultRunbookId).toBe(sibling.id);
      }

      expect((await sessionService.getActive())?.id).toBe(sibling.id);
      unwrapSessionMutation(await sessionService.popRunbook());
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });

    it('releaseRunbooks removes all force-terminal chain ids in one session mutation', async () => {
      const sibling = await makeState(manager, {
        id: mintInlineForceRunId(),
        lifecycle: 'running',
      });
      const root = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const leaf = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });

      await sessionService.pushRunbook(sibling.id);
      await sessionService.pushRunbook(root.id);
      await sessionService.pushRunbook(leaf.id);

      const result = unwrapSessionMutation(
        await sessionService.releaseRunbooks([leaf.id, root.id]),
      );

      expect(result.releasedRunIds).toEqual([leaf.id, root.id]);
      expect(result.nextDefaultRunbookId).toBe(sibling.id);
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([sibling.id]);
    });

    it('releaseRunbooks can retain the terminal root claim while removing descendant claims', async () => {
      const root = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const leaf = await makeState(manager, { id: mintInlineForceRunId(), lifecycle: 'completed' });
      const rootClaim = unwrapSessionMutation(await sessionService.issueRunControlClaim(root.id));
      const leafClaim = unwrapSessionMutation(await sessionService.issueRunControlClaim(leaf.id));

      unwrapSessionMutation(
        await sessionService.releaseRunbooks([leaf.id, root.id], {
          retainClaimsAsTerminalRunId: root.id,
        }),
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

describe('projectRunbookRelease', () => {
  // The in-memory half of a terminal release. The fence applies this projection
  // to a session snapshot INSIDE the same transaction as the state write, so it
  // is exercised here directly rather than through a store round trip.
  const RUN_ID = brandRunIdForTest(`rd_${'e'.repeat(32)}`);
  const OTHER_RUN_ID = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
  const THIRD_RUN_ID = brandRunIdForTest(`rd_${'d'.repeat(32)}`);

  function session(overrides: Partial<SessionData> = {}): SessionData {
    return { defaultStack: [], claims: {}, ...overrides };
  }

  it('clears a stashed run and reports it released', async () => {
    // The stash is a third place a run id can be parked, alongside the default
    // stack and the claim table. Leaving it behind would strand `rundown pop` on
    // a terminal run.
    const data = session({ stashedRunbookId: RUN_ID });

    expect(projectRunbookRelease(data, RUN_ID)).toEqual({
      status: 'released',
      runbookId: RUN_ID,
      // Released on the strength of the stash alone: the stack never held it.
      removedFromDefaultStack: false,
      nextDefaultRunbookId: null,
    });
    expect(data.stashedRunbookId).toBeUndefined();
  });

  it('leaves a stash belonging to a different run untouched', async () => {
    // Anti-vacuity for the case above: an unconditional clear would also pass it.
    const data = session({ stashedRunbookId: OTHER_RUN_ID, defaultStack: [RUN_ID] });

    projectRunbookRelease(data, RUN_ID);

    expect(data.stashedRunbookId).toBe(OTHER_RUN_ID);
  });

  it('reports not-found when the run is in no session structure at all', async () => {
    const data = session({ defaultStack: [OTHER_RUN_ID] });

    expect(projectRunbookRelease(data, RUN_ID)).toEqual({
      status: 'not-found',
      runbookId: RUN_ID,
    });
    expect(data.defaultStack).toEqual([OTHER_RUN_ID]);
  });

  it('pops the run from the default stack and names the new top as the next default', async () => {
    // Three deep, and the released run is NOT on top: the next default has to be
    // the last remaining entry, so a projection that returned the first entry —
    // or the one that happened to sit under the released run — is caught.
    const data = session({ defaultStack: [THIRD_RUN_ID, RUN_ID, OTHER_RUN_ID] });

    expect(projectRunbookRelease(data, RUN_ID)).toEqual({
      status: 'released',
      runbookId: RUN_ID,
      removedFromDefaultStack: true,
      nextDefaultRunbookId: OTHER_RUN_ID,
    });
    expect(data.defaultStack).toEqual([THIRD_RUN_ID, OTHER_RUN_ID]);
  });

  it('names a null next default when the released run emptied the stack', async () => {
    const data = session({ defaultStack: [RUN_ID] });

    expect(projectRunbookRelease(data, RUN_ID)).toEqual({
      status: 'released',
      runbookId: RUN_ID,
      removedFromDefaultStack: true,
      nextDefaultRunbookId: null,
    });
    expect(data.defaultStack).toEqual([]);
  });

  it('deletes controlling claims by default but retains them as terminal tombstones on request', async () => {
    // Retention is what lets `rundown pass --claim-id` on a finished run resolve
    // `terminal` instead of `missing`, so the two modes must stay distinguishable.
    const claim = makeClaimRecord({ controlledRunId: RUN_ID });
    const deleted = session({ claims: { [claim.claimKey]: claim } });
    const retained = session({ claims: { [claim.claimKey]: claim } });

    // Released on the strength of the claim alone, with the stack untouched.
    expect(projectRunbookRelease(deleted, RUN_ID)).toEqual({
      status: 'released',
      runbookId: RUN_ID,
      removedFromDefaultStack: false,
      nextDefaultRunbookId: null,
    });
    expect(deleted.claims).toEqual({});

    expect(projectRunbookRelease(retained, RUN_ID, { retainClaimsAsTerminal: true })).toEqual({
      status: 'released',
      runbookId: RUN_ID,
      removedFromDefaultStack: false,
      nextDefaultRunbookId: null,
    });
    expect(retained.claims[claim.claimKey]).toEqual(claim);
  });
});
