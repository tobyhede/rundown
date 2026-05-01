import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { assertClaimId } from '../../src/runbook/claim-id.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import type { Step, Runbook } from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';

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
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await sessionService.pushRunbook(state.id);

      const active = await sessionService.getActive();
      expect(active?.id).toBe(state.id);
    });

    it('popRunbook removes from stack and returns new top', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });

      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(child.id);

      const newTopId = await sessionService.popRunbook();
      expect(newTopId).toBe(parent.id);

      const active = await sessionService.getActive();
      expect(active?.id).toBe(parent.id);
    });

    it('supports arbitrary nesting depth', async () => {
      const wf1 = await manager.create('level1.md', mockRunbook, { runbookPath: 'level1.md' });
      const wf2 = await manager.create('level2.md', mockRunbook, { runbookPath: 'level2.md' });
      const wf3 = await manager.create('level3.md', mockRunbook, { runbookPath: 'level3.md' });

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
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await sessionService.pushRunbook(state.id);

      const stashedId = await sessionService.stash();

      expect(stashedId).toBe(state.id);
      expect(await sessionService.getActive()).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBe(state.id);
    });

    it('unstash restores stashed runbook', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      const restored = await sessionService.unstash();

      expect(restored?.id).toBe(state.id);
      expect((await sessionService.getActive())?.id).toBe(state.id);
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });

    it('unstash returns null and clears stash when persisted state is missing', async () => {
      const state = await manager.create('temp.md', mockRunbook, { runbookPath: 'temp.md' });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      await manager.delete(state.id);

      const restored = await sessionService.unstash();
      expect(restored).toBeNull();
      expect(await sessionService.getStashedRunbookId()).toBeNull();
      expect(await sessionService.getActive()).toBeNull();
    });

    it('stash refuses to overwrite existing stash', async () => {
      const s1 = await manager.create('a.md', mockRunbook, { runbookPath: 'a.md' });
      const s2 = await manager.create('b.md', mockRunbook, { runbookPath: 'b.md' });
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
    const linkageFor = (parentId: string, fill: string) => ({
      kind: 'delegation' as const,
      parentRunId: parentId,
      parentStepId: '1.1',
      tokenHash: assertDelegationTokenHash(`sha256:${fill.repeat(64)}`),
    });

    it('registers a delegated child claim without changing the default stack', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkageFor(parent.id, 'a'),
      });
      await sessionService.pushRunbook(parent.id);

      const claimed = await sessionService.claimRunbook(child.id, linkageFor(parent.id, 'a'));

      expect(claimed.status).toBe('claimed');
      expect((await sessionService.getActive())?.id).toBe(parent.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('claimed');
      if (resolved.status === 'claimed') {
        expect(resolved.state.id).toBe(child.id);
      }
    });

    it('reuses the same claim id for the same child', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'b');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });

      const first = await sessionService.claimRunbook(child.id, linkage);
      const second = await sessionService.claimRunbook(child.id, linkage);

      expect(second.claim.claimId).toBe(first.claim.claimId);
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
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'c');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

      await manager.delete(child.id);

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('stale');
      if (resolved.status === 'stale') {
        expect(resolved.reason).toBe('missing-state');
      }
    });

    it('returns terminal for a completed claim child', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'd');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

      await manager.update(child.id, { lifecycle: 'completed' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('terminal');
      if (resolved.status === 'terminal') {
        expect(resolved.lifecycle).toBe('completed');
      }
    });

    it('returns unlinked for a child whose delegation linkage no longer matches the claim', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'e');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

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

    it('returns unlinked when the parent is missing or ended', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

      await manager.update(parent.id, { lifecycle: 'completed' });

      const resolved = await sessionService.getActiveForClaimId(claimed.claim.claimId);
      expect(resolved.status).toBe('unlinked');
      if (resolved.status === 'unlinked') {
        expect(resolved.reason).toBe('parent-ended');
      }
    });

    it('releaseRunbook removes matching claim records', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, 'f');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

      await sessionService.releaseRunbook(child.id);

      expect((await sessionService.getActiveForClaimId(claimed.claim.claimId)).status).toBe(
        'missing',
      );
    });

    it('stash preserves a claim record and unstashForClaimId restores only the matching child', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const linkage = linkageFor(parent.id, '1');
      const child = await manager.create('child.md', mockRunbook, {
        runbookPath: 'child.md',
        parentLinkage: linkage,
      });
      const claimed = await sessionService.claimRunbook(child.id, linkage);

      await sessionService.stashRunbook(child.id);
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
      expect((await sessionService.getActiveForClaimId(claimed.claim.claimId)).status).toBe(
        'claimed',
      );

      const restored = await sessionService.unstashForClaimId(claimed.claim.claimId);
      expect(restored?.id).toBe(child.id);
      expect(await sessionService.getStashedRunbookId()).toBeNull();
    });
  });

  describe('releaseRunbook default stack cleanup', () => {
    it('releaseRunbook pops a default-stack child by id', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
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
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const sibling = await manager.create('sibling.md', mockRunbook, {
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
