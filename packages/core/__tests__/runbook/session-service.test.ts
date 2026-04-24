import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
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
});
