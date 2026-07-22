import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import {
  assertClaimId,
  assertClaimLookupKey,
  createDelegatedChildGrants,
  type DelegationClaimLinkage,
} from '../../src/runbook/claim-id.js';
import type { ClaimRunbookResult } from '../../src/runbook/claim-id.js';
import type { Step, Runbook, RunId, RunbookState, ParentLinkage } from '../../src/runbook/types.js';
import type { SessionMutationResult } from '../../src/runbook/storage/runbook-store.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { assertExecutionEpoch } from '../../src/runbook/storage/mutation-result.js';
import { makeClaimRecord } from '../../src/testing/claim-fixtures.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  findSubstepState,
} from '../../src/runbook/targeting.js';
import { merge, replace } from '../../src/runbook/state-update-ops.js';
import {
  linkageFor,
  assertClaimed,
  claimLiveDelegation,
  seedLiveDelegation,
  unwrapSessionMutation,
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
  let sessionService: SessionService;
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps,
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'session-test-'));
    manager = new RunbookStateManager(testDir);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /** Mark a run as actively execution-owned without changing its session rows. */
  function markExecutionOwned(runId: RunId): void {
    const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
    raw
      .prepare(
        `UPDATE runs
            SET exec_pid = :pid, exec_token = :token, exec_epoch = :epoch
          WHERE id = :runId`,
      )
      .run({ pid: process.pid, token: `sha256:${'a'.repeat(64)}`, epoch: 1, runId });
    raw.close();
  }

  /** Seed a recovery-pending attempt for a run without active execution ownership. */
  function markRecoveryPending(runId: RunId, epoch = 7): void {
    const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
    raw
      .prepare(
        `INSERT INTO execution_attempts
           (run_id, exec_epoch, exec_token, phase, owner_pid, started_at)
         VALUES (:runId, :epoch, :token, 'recovery_pending', :pid, :now)`,
      )
      .run({
        runId,
        epoch,
        token: `sha256:${'b'.repeat(64)}`,
        pid: process.pid,
        now: '2026-07-22T00:00:00.000Z',
      });
    raw.close();
  }

  describe('ownership-sensitive session mutation results', () => {
    type MutationFixture = {
      readonly runId: RunId;
      readonly invoke: () => Promise<SessionMutationResult<unknown>>;
    };
    type MutationCase = {
      readonly name: string;
      readonly setup: () => Promise<MutationFixture>;
    };

    async function createRun(name: string): Promise<RunbookState> {
      return manager.create({ source: 'project', path: `${name}.md` }, mockRunbook, {
        runbookPath: `${name}.md`,
      });
    }

    const mutationCases: readonly MutationCase[] = [
      {
        name: 'issueRunControlClaim',
        setup: async () => {
          const run = await createRun('issue');
          return { runId: run.id, invoke: () => sessionService.issueRunControlClaim(run.id) };
        },
      },
      {
        name: 'pushRunbookWithRunControlClaim',
        setup: async () => {
          const run = await createRun('push-with-claim');
          return {
            runId: run.id,
            invoke: () => sessionService.pushRunbookWithRunControlClaim(run.id),
          };
        },
      },
      {
        name: 'claimRunbook',
        setup: async () => {
          const parent = await createRun('claim-parent');
          const linkage = linkageFor(parent.id, 'a');
          const child = await manager.create(
            { source: 'project', path: 'claim-child.md' },
            mockRunbook,
            { runbookPath: 'claim-child.md', parentLinkage: linkage },
          );
          await seedLiveDelegation(manager, linkage);
          return {
            runId: child.id,
            invoke: () => sessionService.claimRunbook(child.id, linkage),
          };
        },
      },
      {
        name: 'releaseRunbook',
        setup: async () => {
          const run = await createRun('release-one');
          await sessionService.pushRunbook(run.id);
          return { runId: run.id, invoke: () => sessionService.releaseRunbook(run.id) };
        },
      },
      {
        name: 'releaseRunbooks',
        setup: async () => {
          const run = await createRun('release-many');
          await sessionService.pushRunbook(run.id);
          return { runId: run.id, invoke: () => sessionService.releaseRunbooks([run.id]) };
        },
      },
      {
        name: 'pruneClaimsForChildren',
        setup: async () => {
          const run = await createRun('prune-claims');
          unwrapSessionMutation(await sessionService.issueRunControlClaim(run.id));
          return {
            runId: run.id,
            invoke: () => sessionService.pruneClaimsForChildren([run.id]),
          };
        },
      },
      {
        name: 'popRunbook',
        setup: async () => {
          const run = await createRun('pop');
          await sessionService.pushRunbook(run.id);
          return { runId: run.id, invoke: () => sessionService.popRunbook() };
        },
      },
      {
        name: 'stash',
        setup: async () => {
          const run = await createRun('stash-active');
          await sessionService.pushRunbook(run.id);
          return { runId: run.id, invoke: () => sessionService.stash() };
        },
      },
      {
        name: 'stashRunbook',
        setup: async () => {
          const run = await createRun('stash-specific');
          await sessionService.pushRunbook(run.id);
          return { runId: run.id, invoke: () => sessionService.stashRunbook(run.id) };
        },
      },
      {
        name: 'unstashForClaimId',
        setup: async () => {
          const parent = await createRun('unstash-claim-parent');
          const linkage = linkageFor(parent.id, 'a');
          const child = await manager.create(
            { source: 'project', path: 'unstash-claim-child.md' },
            mockRunbook,
            { runbookPath: 'unstash-claim-child.md', parentLinkage: linkage },
          );
          await seedLiveDelegation(manager, linkage);
          const claimed = assertClaimed(
            unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage)),
          );
          unwrapSessionMutation(await sessionService.stashRunbook(child.id));
          return {
            runId: child.id,
            invoke: () => sessionService.unstashForClaimId(claimed.claimId),
          };
        },
      },
      {
        name: 'unstash',
        setup: async () => {
          const run = await createRun('unstash');
          await sessionService.pushRunbook(run.id);
          unwrapSessionMutation(await sessionService.stash());
          return { runId: run.id, invoke: () => sessionService.unstash() };
        },
      },
    ];

    describe.each(mutationCases)('$name', ({ setup }) => {
      it('returns committed on success', async () => {
        const fixture = await setup();
        await expect(fixture.invoke()).resolves.toMatchObject({ status: 'committed' });
      });

      it('returns execution-in-progress for an owned affected run', async () => {
        const fixture = await setup();
        markExecutionOwned(fixture.runId);
        await expect(fixture.invoke()).resolves.toEqual({
          status: 'execution-in-progress',
          runId: fixture.runId,
          message: `Run ${fixture.runId} has an execution in progress.`,
        });
      });

      it('returns recovery-required for a recovery-pending affected run', async () => {
        const fixture = await setup();
        markRecoveryPending(fixture.runId);
        await expect(fixture.invoke()).resolves.toEqual({
          status: 'recovery-required',
          runId: fixture.runId,
          epoch: assertExecutionEpoch(7),
          message: `Run ${fixture.runId} needs recovery: its execution outcome is unknown.`,
        });
      });
    });

    it('wraps a successful domain result in the committed arm', async () => {
      const state = await manager.create(
        { source: 'project', path: 'owned-result.md' },
        mockRunbook,
        { runbookPath: 'owned-result.md' },
      );

      const result = await sessionService.issueRunControlClaim(state.id);

      expect(result.status).toBe('committed');
      if (result.status !== 'committed') return;
      expect(result.value.claim.controlledRunId).toBe(state.id);
    });

    it('normalizes an exact trigger abort to execution-in-progress', async () => {
      const state = await manager.create(
        { source: 'project', path: 'execution-owned.md' },
        mockRunbook,
        { runbookPath: 'execution-owned.md' },
      );
      const issued = await sessionService.issueRunControlClaim(state.id);
      expect(issued.status).toBe('committed');
      markExecutionOwned(state.id);

      await expect(sessionService.issueRunControlClaim(state.id)).resolves.toEqual({
        status: 'execution-in-progress',
        runId: state.id,
        message: `Run ${state.id} has an execution in progress.`,
      });
    });

    it('captures an exact trigger abort before rollback can erase its ownership witness', async () => {
      const state = await manager.create(
        { source: 'project', path: 'trigger-owned.md' },
        mockRunbook,
        { runbookPath: 'trigger-owned.md' },
      );
      const issued = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));

      const result = await manager.mutateSessionGuarded([state.id], (ctx) => {
        ctx.tx
          .prepare(
            `UPDATE runs
                SET exec_pid = :pid, exec_token = :token, exec_epoch = :epoch
              WHERE id = :runId`,
          )
          .run({
            pid: process.pid,
            token: `sha256:${'c'.repeat(64)}`,
            epoch: 2,
            runId: state.id,
          });
        ctx.session.claims[issued.claim.claimKey] = { ...issued.claim, grants: [] };
        return 'must-roll-back';
      });

      expect(result).toEqual({
        status: 'execution-in-progress',
        runId: state.id,
        message: `Run ${state.id} has an execution in progress.`,
      });
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      expect(
        raw.prepare('SELECT exec_token FROM runs WHERE id = :runId').get({ runId: state.id }),
      ).toEqual({ exec_token: null });
      raw.close();
      expect((await manager.loadSession()).claims[issued.claim.claimKey].grants).toEqual(
        issued.claim.grants,
      );
    });

    it('refuses recovery-required before changing session state', async () => {
      const state = await manager.create(
        { source: 'project', path: 'recovery-pending.md' },
        mockRunbook,
        { runbookPath: 'recovery-pending.md' },
      );
      markRecoveryPending(state.id);

      await expect(sessionService.pushRunbookWithRunControlClaim(state.id)).resolves.toEqual({
        status: 'recovery-required',
        runId: state.id,
        epoch: assertExecutionEpoch(7),
        message: `Run ${state.id} needs recovery: its execution outcome is unknown.`,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([]);
    });

    it('returns the first multi-run recovery refusal and rolls back every release', async () => {
      const first = await manager.create(
        { source: 'project', path: 'first-release.md' },
        mockRunbook,
        { runbookPath: 'first-release.md' },
      );
      const second = await manager.create(
        { source: 'project', path: 'second-release.md' },
        mockRunbook,
        { runbookPath: 'second-release.md' },
      );
      await sessionService.pushRunbook(first.id);
      await sessionService.pushRunbook(second.id);
      markRecoveryPending(second.id, 9);
      markRecoveryPending(first.id, 10);

      await expect(sessionService.releaseRunbooks([second.id, first.id])).resolves.toEqual({
        status: 'recovery-required',
        runId: second.id,
        epoch: assertExecutionEpoch(9),
        message: `Run ${second.id} needs recovery: its execution outcome is unknown.`,
      });
      expect((await manager.loadSession()).defaultStack).toEqual([first.id, second.id]);
    });
  });

  describe('atomic delegated claim and initial link', () => {
    async function setupInitialLink(fill: string) {
      const parent = await manager.create(
        { source: 'project', path: `parent-${fill}.md` },
        mockRunbook,
        { runbookPath: `parent-${fill}.md` },
      );
      const linkage = linkageFor(parent.id, fill);
      const child = await manager.create(
        { source: 'project', path: `child-${fill}.md` },
        mockRunbook,
        { runbookPath: `child-${fill}.md`, parentLinkage: linkage },
      );
      await seedLiveDelegation(manager, linkage);
      return { parent, child, linkage };
    }

    it.each([
      'completed',
      'stopped',
    ] as const)('refuses to claim a %s delegated child', async (lifecycle) => {
      const { child, linkage } = await setupInitialLink('a');
      await manager.update(child.id, { lifecycle });

      const result = unwrapSessionMutation(await sessionService.claimRunbook(child.id, linkage));

      expect(result).toEqual({
        status: 'terminal-child',
        childRunId: child.id,
        lifecycle,
      });
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(0);
    });

    it('commits the child claim and matching parent childRunId together', async () => {
      const { parent, child, linkage } = await setupInitialLink('a');

      const result = unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      );

      expect(result.status).toBe('claimed');
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBe(child.id);
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(1);
    });

    it('rolls back the inserted claim when the parent state CAS cannot commit', async () => {
      const { parent, child, linkage } = await setupInitialLink('b');
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      raw.exec(`
        CREATE TRIGGER fail_initial_parent_link
        BEFORE UPDATE OF state_json ON runs
        WHEN OLD.id = '${parent.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected_parent_cas_failure');
        END;
      `);
      raw.close();

      await expect(
        sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      ).rejects.toThrow('injected_parent_cas_failure');

      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(0);
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
    });

    it('is idempotent for the same request without bumping child generation', async () => {
      const { child, linkage } = await setupInitialLink('c');
      unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      );
      const before = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'))
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(child.id) as { readonly generation: number };

      const replay = unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      );

      expect(replay.status).toBe('already-claimed');
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      const after = raw
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(child.id) as { readonly generation: number };
      raw.close();
      expect(after.generation).toBe(before.generation);
    });

    it('does not replace an existing live link with a different child', async () => {
      const { parent, child, linkage } = await setupInitialLink('d');
      unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      );
      const other = await manager.create(
        { source: 'project', path: 'other-child.md' },
        mockRunbook,
        { runbookPath: 'other-child.md', parentLinkage: linkage },
      );

      const result = unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: other.id, linkage }),
      );

      expect(result.status).toBe('parent-concurrent-modification');
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBe(child.id);
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(1);
    });

    it('rollback clears only the matching token and child link and tombstones its claim', async () => {
      const { parent, child, linkage } = await setupInitialLink('e');
      unwrapSessionMutation(
        await sessionService.claimAndInitialLink({ childRunId: child.id, linkage }),
      );

      const result = unwrapSessionMutation(
        await sessionService.rollbackInitialLink({ childRunId: child.id, linkage }),
      );

      expect(result.status).toBe('rolled-back');
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(0);
    });

    it('rollback removes only the claim matching every delegation coordinate', async () => {
      const { parent, child, linkage } = await setupInitialLink('a');
      const foreignParent = await manager.create(
        { source: 'project', path: 'foreign-parent.md' },
        mockRunbook,
        { runbookPath: 'foreign-parent.md' },
      );
      const nondelegatedChild = await manager.create(
        { source: 'project', path: 'nondelegated-decoy.md' },
        mockRunbook,
        {
          runbookPath: 'nondelegated-decoy.md',
          runId: brandRunIdForTest(`rd_${'0'.repeat(32)}`),
        },
      );
      const decoySpecs = [
        {
          claimKey: assertClaimLookupKey(`rdclk_${'1'.repeat(32)}`),
          parentRunId: linkage.parentRunId,
          parentStepId: linkage.parentStepId,
          parentFrameKey: buildFrameKey('2'),
          tokenHash: assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`),
        },
        {
          claimKey: assertClaimLookupKey(`rdclk_${'2'.repeat(32)}`),
          parentRunId: linkage.parentRunId,
          parentStepId: '1.2',
          parentFrameKey: linkage.parentFrameKey,
          tokenHash: linkage.tokenHash,
        },
        {
          claimKey: assertClaimLookupKey(`rdclk_${'3'.repeat(32)}`),
          parentRunId: foreignParent.id,
          parentStepId: linkage.parentStepId,
          parentFrameKey: linkage.parentFrameKey,
          tokenHash: linkage.tokenHash,
        },
      ];
      const decoys: ReturnType<typeof makeClaimRecord>[] = [
        makeClaimRecord({
          claimKey: assertClaimLookupKey(`rdclk_${'0'.repeat(32)}`),
          controlledRunId: nondelegatedChild.id,
          grants: [{ action: 'mutate-run', runId: nondelegatedChild.id }],
        }),
      ];
      for (const [index, spec] of decoySpecs.entries()) {
        const decoyRunId = brandRunIdForTest(`rd_${(index + 1).toString(16).padStart(32, '0')}`);
        const decoyChild = await manager.create(
          { source: 'project', path: `decoy-child-${index}.md` },
          mockRunbook,
          { runbookPath: `decoy-child-${index}.md`, runId: decoyRunId },
        );
        const delegation: DelegationClaimLinkage = {
          childRunId: decoyChild.id,
          tokenHash: spec.tokenHash,
          parentRunId: spec.parentRunId,
          parentStepId: spec.parentStepId,
          parentStep: linkage.parentStep,
          parentFrameKey: spec.parentFrameKey,
          parentEntry: linkage.parentEntry,
        };
        await seedLiveDelegation(manager, { kind: 'delegation', ...delegation });
        decoys.push(
          makeClaimRecord({
            claimKey: spec.claimKey,
            controlledRunId: decoyChild.id,
            delegation,
            grants: createDelegatedChildGrants({ linkage: delegation }),
          }),
        );
      }
      await manager.mutateSession((ctx) => {
        expect(
          ctx.linkInitialDelegation({ childRunId: child.id, linkage }, '2026-07-22T12:00:00.000Z'),
        ).toBe('linked');
      });
      const targetClaim = makeClaimRecord({
        claimKey: assertClaimLookupKey(`rdclk_${'4'.repeat(32)}`),
        controlledRunId: child.id,
        delegation: {
          childRunId: child.id,
          tokenHash: linkage.tokenHash,
          parentRunId: linkage.parentRunId,
          parentStepId: linkage.parentStepId,
          parentStep: linkage.parentStep,
          parentFrameKey: linkage.parentFrameKey,
          parentEntry: linkage.parentEntry,
        },
        grants: createDelegatedChildGrants({
          linkage: {
            childRunId: child.id,
            tokenHash: linkage.tokenHash,
            parentRunId: linkage.parentRunId,
            parentStepId: linkage.parentStepId,
            parentStep: linkage.parentStep,
            parentFrameKey: linkage.parentFrameKey,
            parentEntry: linkage.parentEntry,
          },
        }),
      });
      await manager.mutateSession((ctx) => {
        for (const decoy of decoys) {
          ctx.session.claims[decoy.claimKey] = decoy;
        }
        ctx.session.claims[targetClaim.claimKey] = targetClaim;
      });
      expect(Object.keys((await manager.loadSession()).claims)).toEqual([
        ...decoys.map((decoy) => decoy.claimKey),
        targetClaim.claimKey,
      ]);

      const result = unwrapSessionMutation(
        await sessionService.rollbackInitialLink({ childRunId: child.id, linkage }),
      );

      expect(result).toEqual({ status: 'rolled-back' });
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.delegation?.childRunId,
      ).toBeNull();
      const persistedClaims = (await manager.loadSession()).claims;
      expect(Object.keys(persistedClaims).sort()).toEqual(
        decoys.map((decoy) => decoy.claimKey).sort(),
      );
      for (const decoy of decoys) {
        expect(persistedClaims[decoy.claimKey]).toEqual(decoy);
        expect(await manager.load(decoy.controlledRunId)).not.toBeNull();
      }
    });

    it('stale rollback cannot clear a newer token and child link', async () => {
      const { parent, child: oldChild, linkage: oldLinkage } = await setupInitialLink('f');
      unwrapSessionMutation(
        await sessionService.claimAndInitialLink({
          childRunId: oldChild.id,
          linkage: oldLinkage,
        }),
      );

      const newLinkage = linkageFor(parent.id, '6');
      await seedLiveDelegation(manager, newLinkage);
      const newChild = await manager.create(
        { source: 'project', path: 'newer-child.md' },
        mockRunbook,
        { runbookPath: 'newer-child.md', parentLinkage: newLinkage },
      );
      unwrapSessionMutation(
        await sessionService.claimAndInitialLink({
          childRunId: newChild.id,
          linkage: newLinkage,
        }),
      );

      const result = unwrapSessionMutation(
        await sessionService.rollbackInitialLink({
          childRunId: oldChild.id,
          linkage: oldLinkage,
        }),
      );

      expect(result.status).toBe('already-absent');
      const persistedParent = await manager.load(parent.id);
      expect(
        findSubstepState(
          persistedParent?.substepStates ?? [],
          newLinkage.parentStepId,
          newLinkage.parentFrameKey,
        )?.delegation,
      ).toMatchObject({ tokenHash: newLinkage.tokenHash, childRunId: newChild.id });
      expect(Object.values((await manager.loadSession()).claims)).toHaveLength(1);
    });
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

      const stashedId = unwrapSessionMutation(await sessionService.stash());

      expect(stashedId).toBe(state.id);
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

      expect(first).toBe(s1.id);
      expect(second).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBe(s1.id);
      expect((await sessionService.getActive())?.id).toBe(s2.id);
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
      const before = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'))
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(child.id) as { readonly generation: number };

      await manager.update(parent.id, { lifecycle: 'completed' });

      // R2: an authoritative parent state commit tombstones the linked delegated
      // claim (parent terminalization). The bearer therefore no longer resolves
      // as an active claim — the tombstone is not surfaced in loadSession.
      const resolved = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(resolved.status).toBe('missing');
      const raw = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      const after = raw
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(child.id) as { readonly generation: number };
      raw.close();
      expect(after.generation).toBe(before.generation + 1);
    });

    it('invalidates a reissued token exactly once and leaves the newly claimed token active', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const oldLinkage = linkageFor(parent.id, '7');
      const oldChild = await manager.create(
        { source: 'project', path: 'old-child.md' },
        mockRunbook,
        { runbookPath: 'old-child.md', parentLinkage: oldLinkage },
      );
      await seedLiveDelegation(manager, oldLinkage);
      const oldClaim = assertClaimed(
        unwrapSessionMutation(
          await sessionService.claimAndInitialLink({
            childRunId: oldChild.id,
            linkage: oldLinkage,
          }),
        ),
      );
      const rawBefore = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      const before = rawBefore
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(oldChild.id) as { readonly generation: number };
      rawBefore.close();

      const newLinkage = linkageFor(parent.id, '8');
      await seedLiveDelegation(manager, newLinkage);

      const rawAfter = new DatabaseSync(join(testDir, '.rundown', 'rundown.db'));
      const after = rawAfter
        .prepare('SELECT claim_generation AS generation FROM runs WHERE id = ?')
        .get(oldChild.id) as { readonly generation: number };
      rawAfter.close();
      expect(after.generation).toBe(before.generation + 1);
      expect((await sessionService.getActiveForClaimId(oldClaim.claimId)).status).toBe('missing');

      const newChild = await manager.create(
        { source: 'project', path: 'new-child.md' },
        mockRunbook,
        { runbookPath: 'new-child.md', parentLinkage: newLinkage },
      );
      const newest = assertClaimed(
        unwrapSessionMutation(
          await sessionService.claimAndInitialLink({
            childRunId: newChild.id,
            linkage: newLinkage,
          }),
        ),
      );
      expect((await sessionService.getActiveForClaimId(newest.claimId)).status).toBe('claimed');
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

      expect((await sessionService.getActiveForClaimId(claimed.claimId)).status).toBe('missing');
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
      expect(resolution.status).toBe('missing');
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
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('missing');
    });

    it('pruneClaimsForChildren removes claims for multiple child run ids', async () => {
      // Two distinct claimed children (one completed, one stopped) each retain a
      // terminal tombstone. A single prune call covering both child ids must
      // remove both claim records and resolve each to `missing` afterward.
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
      expect((await sessionService.getActiveForClaimId(a.claimId)).status).toBe('missing');
      expect((await sessionService.getActiveForClaimId(b.claimId)).status).toBe('missing');
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

      // R2: ending the parent superseded the delegated claim, so its bearer no
      // longer resolves as a live claim — it reports as a missing claim rather
      // than a live ended-parent outcome.
      const parentEnded = unwrapSessionMutation(
        await sessionService.unstashForClaimId(endedClaimed.claimId),
      );
      expect(parentEnded.status).toBe('missing-claim');
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

      // The claim id is now `missing` rather than `unlinked`.
      const after = await sessionService.getActiveForClaimId(claimed.claimId);
      expect(after.status).toBe('missing');
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

      // The parent did NOT advance: the decisive write rolled back.
      const parentAfter = await manager.load(parent.id);
      expect(
        findSubstepState(
          parentAfter?.substepStates ?? [],
          linkage.parentStepId,
          linkage.parentFrameKey,
        )?.status,
      ).not.toBe('done');

      // The child is intact (non-terminal).
      const childAfter = await manager.load(child.id);
      expect(childAfter?.lifecycle).not.toBe('stopped');
      expect(childAfter?.lifecycle).not.toBe('completed');
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
