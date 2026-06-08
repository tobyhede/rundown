import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import type { Step, Runbook, RunId } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { brandRunIdForTest } from '../../src/testing/effective-vars.js';
import { linkageFor, assertClaimed } from './claim-test-helpers.js';

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

      const newTopId = await sessionService.popRunbook();
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
      await sessionService.popRunbook();
      expect((await sessionService.getActive())?.id).toBe(wf2.id);
      await sessionService.popRunbook();
      expect((await sessionService.getActive())?.id).toBe(wf1.id);
      await sessionService.popRunbook();
      expect(await sessionService.getActive()).toBeNull();
    });
  });

  describe('Stash and pop operations', () => {
    it('stash saves current runbook and removes from stack', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);

      const stashedId = await sessionService.stash();

      expect(stashedId).toBe(state.id);
      expect(await sessionService.getActive()).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBe(state.id);
    });

    it('unstash restores stashed runbook', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      const restored = await sessionService.unstash();

      expect(restored?.id).toBe(state.id);
      expect((await sessionService.getActive())?.id).toBe(state.id);
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('unstash returns null and clears stash when persisted state is missing', async () => {
      const state = await manager.create({ source: 'project', path: 'temp.md' }, mockRunbook, {
        runbookPath: 'temp.md',
      });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      await manager.delete(state.id);

      const restored = await sessionService.unstash();
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

      const first = await sessionService.stash();

      await sessionService.pushRunbook(s2.id);
      const second = await sessionService.stash();

      expect(first).toBe(s1.id);
      expect(second).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBe(s1.id);
      expect((await sessionService.getActive())?.id).toBe(s2.id);
    });
  });

  describe('claim-id runbook targeting', () => {
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
        await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
      );

      expect((await sessionService.getActive())?.id).toBe(parent.id);
      const session = await manager.loadSession();
      expect(session.defaultStack).toEqual([parent.id]);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('claimed');
      if (resolved.status === 'claimed') {
        expect(resolved.state.id).toBe(child.id);
      }
    });

    it('reuses the same claim id for the same child', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });

      const first = assertClaimed(await sessionService.claimRunbook(child.id, linkage));
      const second = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      expect(second.claim.claimId).toBe(first.claim.claimId);
      expect(second.claim.claimedAt).toBe(first.claim.claimedAt);
      expect(second.claim.updatedAt >= first.claim.updatedAt).toBe(true);
    });

    it('refreshes an existing delegation claim before treating a new child id as claimable', async () => {
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
      const first = assertClaimed(await sessionService.claimRunbook(existingChild.id, linkage));

      const missingChildId = brandRunIdForTest(`rd_${'f'.repeat(32)}`);
      const second = assertClaimed(await sessionService.claimRunbook(missingChildId, linkage));

      expect(second.claim.claimId).toBe(first.claim.claimId);
      expect(second.claim.childRunId).toBe(existingChild.id);
      expect(second.claim.claimedAt).toBe(first.claim.claimedAt);
      expect(second.claim.updatedAt >= first.claim.updatedAt).toBe(true);
    });

    it('returns missing for an unknown claim id', async () => {
      const resolved = await sessionService.getActiveForClaimId(
        assertClaimId('rdclm_abcdefghijklmnopqrstu1'),
      );
      expect(resolved).toEqual({
        status: 'missing',
        claimId: 'rdclm_abcdefghijklmnopqrstu1',
      });
    });

    it('returns stale for a claim whose child state is missing', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'c');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.delete(child.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('stale');
      if (resolved.status === 'stale') {
        expect(resolved.reason).toBe('missing-state');
      }
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.update(child.id, { lifecycle: 'completed' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.update(child.id, { lifecycle: 'stopped' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.update(child.id, {
        parentLinkage: {
          ...linkage,
          parentStepId: '2.1',
        },
      });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('child-linkage-mismatch');
      }
    });

    it('returns unlinked when the parent has ended', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.update(parent.id, { lifecycle: 'completed' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('parent-ended');
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await manager.delete(parent.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('parent-missing');
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

      const result = await sessionService.claimRunbook(child.id, linkage);
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
      const result = await sessionService.claimRunbook(child.id, drifted);

      expect(result.status).toBe('linkage-mismatch');
      if (result.status === 'linkage-mismatch') {
        expect(result.childRunId).toBe(child.id);
        expect(result.incoming).toBe(drifted);
        expect(result.persisted).toEqual(linkage);
      }
    });

    it('claimRunbook refuses to refresh an existing child claim with different linkage', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const originalLinkage = linkageFor(parent.id, '5');
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: originalLinkage,
      });
      const first = assertClaimed(await sessionService.claimRunbook(child.id, originalLinkage));

      const incomingLinkage = linkageFor(parent.id, '6');
      await manager.update(child.id, { parentLinkage: incomingLinkage });

      const result = await sessionService.claimRunbook(child.id, incomingLinkage);

      expect(result.status).toBe('linkage-mismatch');
      if (result.status === 'linkage-mismatch') {
        expect(result.childRunId).toBe(child.id);
        expect(result.incoming).toBe(incomingLinkage);
        expect(result.persisted).toEqual({
          kind: 'delegation',
          parentRunId: first.claim.parentRunId,
          parentStepId: first.claim.parentStepId,
          parentStep: first.claim.parentStep,
          parentFrameKey: first.claim.parentFrameKey,
          parentEntry: first.claim.parentEntry,
          tokenHash: first.claim.tokenHash,
        });
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

      const result = await sessionService.claimRunbook(child.id, linkage);
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await sessionService.releaseRunbook(child.id);

      expect((await sessionService.getActiveForClaimId(claimed.claim.claimId)).status).toBe(
        'missing',
      );
    });

    /**
     * Claim a delegated child and drive its lifecycle to a terminal state.
     *
     * @param fill - Unique single char used to derive the linkage token hash.
     * @param childLifecycle - Terminal lifecycle to stamp on the child run.
     * @returns The claim id and child run id.
     */
    async function setupClaimedChild(
      fill: string,
      childLifecycle: 'completed' | 'stopped',
    ): Promise<{ claimId: ReturnType<typeof assertClaimId>; childRunId: RunId }> {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });
      const linkage = linkageFor(parent.id, fill);
      const child = await manager.create({ source: 'project', path: 'child.md' }, mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));
      await manager.update(child.id, { lifecycle: childLifecycle });
      return { claimId: claimed.claim.claimId, childRunId: child.id };
    }

    it('releaseRunbook({ retainClaimsAsTerminal: true }) keeps the claim as a terminal tombstone', async () => {
      const { claimId, childRunId } = await setupClaimedChild('e', 'completed');

      const result = await sessionService.releaseRunbook(childRunId, {
        retainClaimsAsTerminal: true,
      });

      expect(result.status).toBe('released');
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('terminal');
      if (resolution.status === 'terminal') {
        expect(resolution.lifecycle).toBe('completed');
      }
    });

    it('releaseRunbook() (default) still deletes the claim record', async () => {
      const { claimId, childRunId } = await setupClaimedChild('7', 'completed');

      await sessionService.releaseRunbook(childRunId);

      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('missing');
    });

    it('pruneClaimsForChildren removes claims pointing at the given child run ids', async () => {
      const { claimId, childRunId } = await setupClaimedChild('6', 'completed');
      await sessionService.releaseRunbook(childRunId, { retainClaimsAsTerminal: true });

      const removed = await sessionService.pruneClaimsForChildren([childRunId]);

      expect(removed).toEqual([claimId]);
      const resolution = await sessionService.getActiveForClaimId(claimId);
      expect(resolution.status).toBe('missing');
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await sessionService.stashRunbook(child.id);
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('stashed');
      }

      const restored = await sessionService.unstashForClaimId(claimed.claim.claimId);
      expect(restored.status).toBe('restored');
      if (restored.status === 'restored') {
        expect(restored.state.id).toBe(child.id);
      }
      expect(await sessionService.getStashedRunbookId()).toBeNull();

      // After pop the claim is active again.
      expect((await sessionService.getActiveForClaimId(claimed.claim.claimId)).status).toBe(
        'claimed',
      );
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      const absent = await sessionService.unstashForClaimId(
        assertClaimId('rdclm_abcdefghijklmnopqrstu1'),
      );
      expect(absent.status).toBe('missing-claim');

      const notStashed = await sessionService.unstashForClaimId(claimed.claim.claimId);
      expect(notStashed.status).toBe('not-stashed');
      if (notStashed.status === 'not-stashed') {
        expect(notStashed.claim.childRunId).toBe(child.id);
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
        await sessionService.claimRunbook(terminalChild.id, terminalLinkage),
      );
      await sessionService.stashRunbook(terminalChild.id);
      await manager.update(terminalChild.id, { lifecycle: 'completed' });

      const terminal = await sessionService.unstashForClaimId(terminalClaimed.claim.claimId);
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
      const endedClaimed = assertClaimed(await sessionService.claimRunbook(child.id, endedLinkage));
      await manager.update(endedParent.id, { lifecycle: 'stopped' });
      await sessionService.releaseRunbook(terminalChild.id);
      await sessionService.stashRunbook(child.id);

      const parentEnded = await sessionService.unstashForClaimId(endedClaimed.claim.claimId);
      expect(parentEnded.status).toBe('parent-ended');
      if (parentEnded.status === 'parent-ended') {
        expect(parentEnded.lifecycle).toBe('stopped');
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      await sessionService.stashRunbook(child.id);

      // Default (write) gate refuses.
      const gated = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(gated.status).toBe('unlinked');
      if (gated.status === 'unlinked') {
        expect(gated.reason).toBe('stashed');
      }

      // includeStashed flips the gate so read-only commands like `rd status
      // --claim-id` can inspect the parked child.
      const inspected = await sessionService.getActiveForClaimId(claimed.claim.claimId, {
        includeStashed: true,
      });
      expect(inspected.status).toBe('claimed');
      if (inspected.status === 'claimed') {
        expect(inspected.state.id).toBe(child.id);
        expect(inspected.claim.claimId).toBe(claimed.claim.claimId);
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
      const claimed = assertClaimed(await sessionService.claimRunbook(child.id, linkage));

      // Simulate the active-claimed-child state: child on default stack and
      // referenced by the claim record.
      await sessionService.pushRunbook(child.id);
      expect((await sessionService.getActive())?.id).toBe(child.id);

      // Child completes: terminal release pops the default-stack entry and
      // removes the claim record in one pass.
      await manager.update(child.id, { lifecycle: 'completed' });
      const released = await sessionService.releaseRunbook(child.id);
      expect(released.status).toBe('released');

      const session = await manager.loadSession();
      expect(session.defaultStack).not.toContain(child.id);
      expect(session.claims[claimed.claim.claimId]).toBeUndefined();

      // The claim id is now `missing` rather than `unlinked`.
      const after = await sessionService.getActiveForClaimId(claimed.claim.claimId);
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
        await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a')),
      );

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([
        expect.objectContaining({
          kind: 'claim-record',
          claimId: claimed.claim.claimId,
          childRunId: child.id,
          parentRunId: parent.id,
          parentStepId: '1.1',
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
        parentLinkage: linkageFor(parent.id, 'b'),
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.claimRunbook(childA.id, linkageFor(parent.id, 'a'));
      await sessionService.claimRunbook(childB.id, linkageFor(parent.id, 'b'));

      const open = await sessionService.listOpenClaimsForParent(parent.id);
      expect(open.map((claim) => claim.childRunId).sort()).toEqual([childA.id, childB.id].sort());
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
        parentLinkage: linkageFor(parent.id, 'b'),
      });
      await sessionService.pushRunbook(parent.id);
      await sessionService.claimRunbook(openChild.id, linkageFor(parent.id, 'a'));
      await sessionService.claimRunbook(doneChild.id, linkageFor(parent.id, 'b'));
      await manager.update(doneChild.id, { lifecycle: 'completed' });

      const open = await sessionService.listOpenClaimsForParent(parent.id);
      expect(open.map((claim) => claim.childRunId)).toEqual([openChild.id]);
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
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a'));
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
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a'));
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
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a'));
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
      await sessionService.claimRunbook(child.id, linkageFor(parentB.id, 'a'));

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
      await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a'));

      // Diverge the child's persisted linkage tokenHash from the claim record so
      // linkageMatchesClaim() returns false (same field set getActiveForClaimId
      // checks). A different `fill` produces a different delegation tokenHash.
      // (Plan used 'z'; that is not valid hex, so we use 'f' — a valid hex fill
      // distinct from the claim's 'a'.)
      await manager.update(child.id, { parentLinkage: linkageFor(parent.id, 'f') });

      await expect(sessionService.listOpenClaimsForParent(parent.id)).resolves.toEqual([]);
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

      const released = await sessionService.releaseRunbook(child.id);
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

      const released = await sessionService.releaseRunbook(child.id);
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(true);
        expect(released.nextDefaultRunbookId).toBe(sibling.id);
      }

      expect((await sessionService.getActive())?.id).toBe(sibling.id);
      await sessionService.popRunbook();
      expect((await sessionService.getActive())?.id).toBe(parent.id);
    });
  });
});
