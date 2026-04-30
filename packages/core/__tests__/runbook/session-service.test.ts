import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import {
  SessionOwnershipMismatchError,
  SessionStashOwnershipMissingError,
  SessionStashOwnershipRequiredError,
} from '../../src/runbook/agent-ownership.js';
import { SessionService } from '../../src/runbook/session-service.js';
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

    it('popRunbook returns null on empty stack without side effects', async () => {
      const result = await sessionService.popRunbook();
      expect(result).toBeNull();
      expect(await sessionService.getActive()).toBeNull();
    });

    it('supports arbitrary nesting depth', async () => {
      const wf1 = await manager.create('level1.md', mockRunbook, { runbookPath: 'level1.md' });
      const wf2 = await manager.create('level2.md', mockRunbook, { runbookPath: 'level2.md' });
      const wf3 = await manager.create('level3.md', mockRunbook, { runbookPath: 'level3.md' });
      const wf4 = await manager.create('level4.md', mockRunbook, { runbookPath: 'level4.md' });

      await sessionService.pushRunbook(wf1.id);
      await sessionService.pushRunbook(wf2.id);
      await sessionService.pushRunbook(wf3.id);
      await sessionService.pushRunbook(wf4.id);

      expect((await sessionService.getActive())?.id).toBe(wf4.id);

      await sessionService.popRunbook();
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

    it('stash returns null when no active runbook', async () => {
      const stashedId = await sessionService.stash();
      expect(stashedId).toBeNull();
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

    it('unstash rejects an agent-owned stash without transferring ownership', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const identity = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };
      const linkage = {
        kind: 'delegation' as const,
        parentRunId: parent.id,
        parentStepId: '1',
        tokenHash: assertDelegationTokenHash(`sha256:${'1'.repeat(64)}`),
      };
      await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      await sessionService.stashRunbook(child.id);

      await expect(sessionService.unstash()).rejects.toBeInstanceOf(
        SessionStashOwnershipRequiredError,
      );

      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
      expect((await sessionService.getStashedRunbookOwnership())?.childRunId).toBe(child.id);
      expect(await sessionService.getActive()).toBeNull();
      expect((await sessionService.getActiveForOwner(identity)).status).toBe('unowned');
    });

    it('unstash returns null when nothing stashed', async () => {
      const restored = await sessionService.unstash();
      expect(restored).toBeNull();
    });

    it('unstash returns null and clears stash when persisted state is missing', async () => {
      const state = await manager.create('temp.md', mockRunbook, { runbookPath: 'temp.md' });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      // Simulate state file deletion
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

      // Push second runbook after stashing first
      await sessionService.pushRunbook(s2.id);
      const second = await sessionService.stash();

      // First stash succeeds, second is refused
      expect(first).toBe(s1.id);
      expect(second).toBeNull();
      // Original stash preserved
      expect(await sessionService.getStashedRunbookId()).toBe(s1.id);
      // Second runbook remains on the stack (not popped)
      expect((await sessionService.getActive())?.id).toBe(s2.id);
    });
  });

  describe('agent-owned runbook targeting', () => {
    const identity = {
      kind: 'agent-session' as const,
      agent_id: 'agent-a',
      session_id: 'session-a',
    };
    const otherIdentity = {
      kind: 'agent-session' as const,
      agent_id: 'agent-b',
      session_id: 'session-b',
    };
    const linkageFor = (parentId: string, hashFill: string) => ({
      kind: 'delegation' as const,
      parentRunId: parentId,
      parentStepId: '1',
      tokenHash: assertDelegationTokenHash(`sha256:${hashFill.repeat(64)}`),
    });

    it('registers a delegated child for an owner without changing the default stack', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);

      await sessionService.claimRunbookForOwner(identity, child.id, linkageFor(parent.id, 'a'));

      expect((await sessionService.getActive())?.id).toBe(parent.id);

      const owned = await sessionService.getActiveForOwner(identity);
      expect(owned.status).toBe('owned');
      if (owned.status === 'owned') {
        expect(owned.state.id).toBe(child.id);
        expect(owned.ownership.agent_id).toBe('agent-a');
        expect(owned.ownership.childRunId).toBe(child.id);
      }
    });

    it('returns stale for missing owned state and does not fall back to the default stack', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);
      await sessionService.claimRunbookForOwner(identity, child.id, linkageFor(parent.id, 'b'));

      await manager.delete(child.id);

      const owned = await sessionService.getActiveForOwner(identity);
      expect(owned.status).toBe('stale');
      if (owned.status === 'stale') {
        expect(owned.reason).toBe('missing-state');
        expect(owned.ownership.childRunId).toBe(child.id);
      }
    });

    it('returns claimed and updates the entry on idempotent re-claim by the same identity', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);

      const linkage = linkageFor(parent.id, 'd');
      const first = await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const second = await sessionService.claimRunbookForOwner(identity, child.id, linkage);

      expect(first.status).toBe('claimed');
      expect(second.status).toBe('claimed');
      if (first.status === 'claimed' && second.status === 'claimed') {
        expect(second.ownership.childRunId).toBe(child.id);
        expect(second.ownership.claimedAt).toBe(first.ownership.claimedAt);
        expect(second.ownership.tokenHash).toBe(first.ownership.tokenHash);
        expect(second.ownership.updatedAt >= first.ownership.updatedAt).toBe(true);
        const session = await manager.loadSession();
        expect(session.ownedRunbooks[first.ownership.ownerKey]).toHaveLength(1);
      }
    });

    it('rejects claims from a different agent against an existing ownership entry', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);

      const linkage = linkageFor(parent.id, 'e');
      const claimed = await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      expect(claimed.status).toBe('claimed');

      const conflict = await sessionService.claimRunbookForOwner(otherIdentity, child.id, linkage);

      expect(conflict.status).toBe('conflict');
      if (conflict.status === 'conflict') {
        expect(conflict.existing.agent_id).toBe('agent-a');
        expect(conflict.existing.childRunId).toBe(child.id);
      }

      // Intruder must not have been recorded as an owner.
      expect((await sessionService.getActiveForOwner(otherIdentity)).status).toBe('unowned');
      // Original owner is unaffected.
      const ownedByA = await sessionService.getActiveForOwner(identity);
      expect(ownedByA.status).toBe('owned');
      if (ownedByA.status === 'owned') {
        expect(ownedByA.ownership.agent_id).toBe('agent-a');
      }
    });

    it('releaseRunbook clears owned children without popping the parent', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);
      await sessionService.claimRunbookForOwner(identity, child.id, linkageFor(parent.id, 'c'));

      const released = await sessionService.releaseRunbook(child.id);
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(false);
        expect(released.removedOwnerKeys).toHaveLength(1);
        expect(released.nextDefaultRunbookId).toBe(parent.id);
      }

      expect((await sessionService.getActive())?.id).toBe(parent.id);
      expect((await sessionService.getActiveForOwner(identity)).status).toBe('unowned');
      expect((await manager.loadSession()).ownedRunbooks).not.toHaveProperty(
        'agent:agent-a:session:session-a',
      );
    });

    it('keeps same-owner claims on a stack with the second child active', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));
      await sessionService.claimRunbookForOwner(identity, childB.id, linkageFor(parent.id, '2'));

      const owned = await sessionService.getActiveForOwner(identity);
      expect(owned.status).toBe('owned');
      if (owned.status === 'owned') {
        expect(owned.state.id).toBe(childB.id);
      }

      const session = await manager.loadSession();
      const ownerStack = Object.values(session.ownedRunbooks).flat();
      expect(ownerStack.map((ownership) => ownership.childRunId)).toEqual([childA.id, childB.id]);
    });

    it('getActiveForOwner returns the stack top', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));
      await sessionService.claimRunbookForOwner(identity, childB.id, linkageFor(parent.id, '2'));

      const active = await sessionService.getActiveForOwner(identity);

      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.state.id).toBe(childB.id);
        expect(active.ownership.childRunId).toBe(childB.id);
      }
    });

    it('moves an existing owned child to the stack top when it is re-claimed', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));
      await sessionService.claimRunbookForOwner(identity, childB.id, linkageFor(parent.id, '2'));
      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));

      const active = await sessionService.getActiveForOwner(identity);
      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.state.id).toBe(childA.id);
        expect(active.ownership.childRunId).toBe(childA.id);
      }

      const session = await manager.loadSession();
      const ownerStack = Object.values(session.ownedRunbooks).flat();
      expect(ownerStack.map((ownership) => ownership.childRunId)).toEqual([childB.id, childA.id]);
    });

    it('returns unowned for an empty owned stack', async () => {
      const ownerKey = 'agent:agent-a:session:session-a';
      await manager.saveSession({ defaultStack: [], ownedRunbooks: { [ownerKey]: [] } });

      expect((await sessionService.getActiveForOwner(identity)).status).toBe('unowned');
    });

    it('releaseRunbook removes a mid-stack owned entry without affecting other entries', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });
      const childC = await manager.create('child-c.md', mockRunbook, {
        runbookPath: 'child-c.md',
      });

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));
      await sessionService.claimRunbookForOwner(identity, childB.id, linkageFor(parent.id, '2'));
      await sessionService.claimRunbookForOwner(identity, childC.id, linkageFor(parent.id, '3'));

      const released = await sessionService.releaseRunbook(childB.id);
      expect(released.status).toBe('released');

      const session = await manager.loadSession();
      const ownerStack = Object.values(session.ownedRunbooks).flat();
      expect(ownerStack.map((ownership) => ownership.childRunId)).toEqual([childA.id, childC.id]);
      const active = await sessionService.getActiveForOwner(identity);
      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.state.id).toBe(childC.id);
      }
    });

    it('releaseRunbook walks all agent stacks', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageFor(parent.id, '1'));
      await sessionService.claimRunbookForOwner(
        otherIdentity,
        childB.id,
        linkageFor(parent.id, '2'),
      );

      const released = await sessionService.releaseRunbook(childB.id);
      expect(released.status).toBe('released');
      expect((await sessionService.getActiveForOwner(otherIdentity)).status).toBe('unowned');
      expect((await sessionService.getActiveForOwner(identity)).status).toBe('owned');
    });

    it('stash claim pop sequence restores the stashed child on top of the owner stack', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });
      const linkageA = linkageFor(parent.id, '1');
      const linkageB = linkageFor(parent.id, '2');

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageA);
      await sessionService.stashRunbook(childA.id);
      await sessionService.claimRunbookForOwner(identity, childB.id, linkageB);
      await sessionService.unstashForOwner(identity);

      const session = await manager.loadSession();
      const ownerStack = Object.values(session.ownedRunbooks).flat();
      expect(ownerStack.map((ownership) => ownership.childRunId)).toEqual([childB.id, childA.id]);

      const active = await sessionService.getActiveForOwner(identity);
      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.state.id).toBe(childA.id);
      }
    });

    it('restores a stashed middle child on top of an in-progress owner stack', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('child-a.md', mockRunbook, {
        runbookPath: 'child-a.md',
      });
      const childB = await manager.create('child-b.md', mockRunbook, {
        runbookPath: 'child-b.md',
      });
      const childC = await manager.create('child-c.md', mockRunbook, {
        runbookPath: 'child-c.md',
      });
      const linkageA = linkageFor(parent.id, '1');
      const linkageB = linkageFor(parent.id, '2');
      const linkageC = linkageFor(parent.id, '3');

      await sessionService.claimRunbookForOwner(identity, childA.id, linkageA);
      const claimedB = await sessionService.claimRunbookForOwner(identity, childB.id, linkageB);
      expect(claimedB.status).toBe('claimed');
      if (claimedB.status !== 'claimed') return;

      await sessionService.stashRunbook(childB.id);
      await sessionService.claimRunbookForOwner(identity, childC.id, linkageC);
      await sessionService.unstashForOwner(identity);

      const session = await manager.loadSession();
      const ownerStack = Object.values(session.ownedRunbooks).flat();
      expect(ownerStack.map((ownership) => ownership.childRunId)).toEqual([
        childA.id,
        childC.id,
        childB.id,
      ]);

      const active = await sessionService.getActiveForOwner(identity);
      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.state.id).toBe(childB.id);
        expect(active.ownership.claimedAt).toBe(claimedB.ownership.claimedAt);
        expect(active.ownership.tokenHash).toBe(claimedB.ownership.tokenHash);
        expect(active.ownership.parentRunId).toBe(parent.id);
        expect(active.ownership.parentStepId).toBe('1');
      }
    });

    it('rejects same-owner re-claim of a stashed child with conflict', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const linkage = linkageFor(parent.id, '1');

      const claimed = await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      await sessionService.stashRunbook(child.id);
      const conflict = await sessionService.claimRunbookForOwner(identity, child.id, linkage);

      expect(claimed.status).toBe('claimed');
      expect(conflict.status).toBe('conflict');
      if (conflict.status === 'conflict') {
        expect(conflict.existing.childRunId).toBe(child.id);
      }
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
      expect((await sessionService.getActiveForOwner(identity)).status).toBe('unowned');
    });

    it('rejects different-owner claim of a stashed child with conflict', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const linkage = linkageFor(parent.id, '1');

      await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      await sessionService.stashRunbook(child.id);
      const conflict = await sessionService.claimRunbookForOwner(otherIdentity, child.id, linkage);

      expect(conflict.status).toBe('conflict');
      if (conflict.status === 'conflict') {
        expect(conflict.existing.agent_id).toBe('agent-a');
      }
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
      expect((await sessionService.getActiveForOwner(otherIdentity)).status).toBe('unowned');
    });

    it('unstashForOwner preserves original claimedAt and tokenHash', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const linkage = linkageFor(parent.id, '1');

      const claimed = await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') return;
      await sessionService.stashRunbook(child.id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await sessionService.unstashForOwner(identity);

      const active = await sessionService.getActiveForOwner(identity);
      expect(active.status).toBe('owned');
      if (active.status === 'owned') {
        expect(active.ownership.claimedAt).toBe(claimed.ownership.claimedAt);
        expect(active.ownership.tokenHash).toBe(claimed.ownership.tokenHash);
        expect(active.ownership.updatedAt >= claimed.ownership.updatedAt).toBe(true);
      }
    });

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

    it('releaseRunbook clears an anonymous stashed runbook by id', async () => {
      const state = await manager.create('anonymous.md', mockRunbook, {
        runbookPath: 'anonymous.md',
      });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      const released = await sessionService.releaseRunbook(state.id);
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(false);
        expect(released.removedOwnerKeys).toEqual([]);
      }
      expect(await sessionService.getStashedRunbookId()).toBeNull();
      expect(await sessionService.getStashedRunbookOwnership()).toBeNull();
    });

    it('releaseRunbook clears an agent-owned stashed runbook by id', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      const identity = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };
      const linkage = {
        kind: 'delegation' as const,
        parentRunId: parent.id,
        parentStepId: '1',
        tokenHash: assertDelegationTokenHash(`sha256:${'2'.repeat(64)}`),
      };
      await sessionService.claimRunbookForOwner(identity, child.id, linkage);
      await sessionService.stashRunbook(child.id);

      const released = await sessionService.releaseRunbook(child.id);
      expect(released.status).toBe('released');
      if (released.status === 'released') {
        expect(released.removedFromDefaultStack).toBe(false);
        expect(released.removedOwnerKeys).toEqual([]);
      }
      expect(await sessionService.getStashedRunbookId()).toBeNull();
      expect(await sessionService.getStashedRunbookOwnership()).toBeNull();
      expect((await sessionService.getActiveForOwner(identity)).status).toBe('unowned');
    });
  });

  describe('unstashForOwner ownership guard', () => {
    it('throws when an identified caller tries to restore an anonymous stash', async () => {
      const state = await manager.create('anonymous.md', mockRunbook, {
        runbookPath: 'anonymous.md',
      });
      await sessionService.pushRunbook(state.id);
      await sessionService.stash();

      const agentA = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };
      await expect(sessionService.unstashForOwner(agentA)).rejects.toBeInstanceOf(
        SessionStashOwnershipMissingError,
      );

      expect(await sessionService.getStashedRunbookId()).toBe(state.id);
      expect(await sessionService.getStashedRunbookOwnership()).toBeNull();
      expect((await sessionService.getActiveForOwner(agentA)).status).toBe('unowned');
    });

    it('throws SessionOwnershipMismatchError when caller is not the stash owner', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });
      await sessionService.pushRunbook(parent.id);

      const agentA = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };
      const linkage = {
        kind: 'delegation' as const,
        parentRunId: parent.id,
        parentStepId: '1',
        tokenHash: assertDelegationTokenHash(`sha256:${'f'.repeat(64)}`),
      };
      await sessionService.claimRunbookForOwner(agentA, child.id, linkage);
      await sessionService.stashRunbook(child.id);

      const intruder = {
        kind: 'agent-session' as const,
        agent_id: 'agent-b',
        session_id: 'session-b',
      };
      await expect(sessionService.unstashForOwner(intruder)).rejects.toBeInstanceOf(
        SessionOwnershipMismatchError,
      );

      // Stash must remain intact for the rightful owner to recover.
      expect(await sessionService.getStashedRunbookId()).toBe(child.id);
      const ownership = await sessionService.getStashedRunbookOwnership();
      expect(ownership?.agent_id).toBe('agent-a');
    });
  });

  describe('concurrent session.json mutations', () => {
    const linkageFor = (parentId: string, hashFill: string) => ({
      kind: 'delegation' as const,
      parentRunId: parentId,
      parentStepId: '1',
      tokenHash: assertDelegationTokenHash(`sha256:${hashFill.repeat(64)}`),
    });

    it('persists both ownership records when two distinct claims race', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const childA = await manager.create('childA.md', mockRunbook, { runbookPath: 'childA.md' });
      const childB = await manager.create('childB.md', mockRunbook, { runbookPath: 'childB.md' });
      await sessionService.pushRunbook(parent.id);

      const agentA = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };
      const agentB = {
        kind: 'agent-session' as const,
        agent_id: 'agent-b',
        session_id: 'session-b',
      };

      const [resultA, resultB] = await Promise.all([
        sessionService.claimRunbookForOwner(agentA, childA.id, linkageFor(parent.id, '1')),
        sessionService.claimRunbookForOwner(agentB, childB.id, linkageFor(parent.id, '2')),
      ]);

      expect(resultA.status).toBe('claimed');
      expect(resultB.status).toBe('claimed');

      // Both ownership records must persist — without serialization the second
      // saveSession would clobber the first because they share a stale snapshot.
      const ownedByA = await sessionService.getActiveForOwner(agentA);
      const ownedByB = await sessionService.getActiveForOwner(agentB);
      expect(ownedByA.status).toBe('owned');
      expect(ownedByB.status).toBe('owned');
      if (ownedByA.status === 'owned') {
        expect(ownedByA.ownership.childRunId).toBe(childA.id);
      }
      if (ownedByB.status === 'owned') {
        expect(ownedByB.ownership.childRunId).toBe(childB.id);
      }
    });

    it('preserves both side effects when a stash and a claim race', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const stashCandidate = await manager.create('stash-candidate.md', mockRunbook, {
        runbookPath: 'stash-candidate.md',
      });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });

      // parent on stack, stash candidate on top of it
      await sessionService.pushRunbook(parent.id);
      await sessionService.pushRunbook(stashCandidate.id);

      const agentA = {
        kind: 'agent-session' as const,
        agent_id: 'agent-a',
        session_id: 'session-a',
      };

      const [stashedId, claimResult] = await Promise.all([
        sessionService.stash(),
        sessionService.claimRunbookForOwner(agentA, child.id, linkageFor(parent.id, 'a')),
      ]);

      expect(stashedId).toBe(stashCandidate.id);
      expect(claimResult.status).toBe('claimed');

      // Both effects must be visible: stash slot holds the candidate, ownership recorded for agentA.
      expect(await sessionService.getStashedRunbookId()).toBe(stashCandidate.id);
      const ownedByA = await sessionService.getActiveForOwner(agentA);
      expect(ownedByA.status).toBe('owned');
      if (ownedByA.status === 'owned') {
        expect(ownedByA.ownership.childRunId).toBe(child.id);
      }
    });
  });
});
