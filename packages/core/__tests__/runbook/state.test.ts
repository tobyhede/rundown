import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { type Step, type Runbook } from '../../src/runbook/types.js';

describe('RunbookStateManager', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  const mockSteps: Step[] = [{
    name: '1',
    description: 'Initial step'
  }];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ws-test-'));
    manager = new RunbookStateManager(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getChildRunbookResult', () => {
    it('should return pass when child has completed=true', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, { runbookPath: 'child.runbook.md' });
      await manager.update(child.id, { variables: { completed: true } });

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBe('pass');
    });

    it('should return fail when child has stopped=true', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, { runbookPath: 'child.runbook.md' });
      await manager.update(child.id, { variables: { stopped: true } });

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBe('fail');
    });

    it('should return null when child is still active', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, { runbookPath: 'child.runbook.md' });
      await manager.pushRunbook(child.id);

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });

    it('should return pass when child state deleted', async () => {
      const result = await manager.getChildRunbookResult('nonexistent-id');
      expect(result).toBe('pass');
    });

    it('should return null when child is stashed', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, { runbookPath: 'child.runbook.md' });
      await manager.pushRunbook(child.id);
      await manager.stash();

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });
  });

  describe('RunbookStateManager substep initialization', () => {
    it('initializes substepStates when step has static substeps', async () => {
      const substeps = [
        { id: '1', description: 'First reviewer', prompts: [] },
        { id: '2', description: 'Second reviewer', prompts: [] }
      ];

      const state = await manager.create('test.runbook.md', mockRunbook, { runbookPath: 'test.runbook.md' });
      await manager.initializeSubsteps(state.id, substeps);

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'pending',
        agentId: undefined,
        result: undefined
      });
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('binds agent to substep', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, { runbookPath: 'test.runbook.md' });
      await manager.update(state.id, {
        substepStates: [{ id: '1', status: 'pending' }]
      });

      await manager.bindSubstepAgent(state.id, '1', 'agent-123');

      const updated = await manager.load(state.id);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'running',
        agentId: 'agent-123',
        result: undefined
      });
    });

    it('completes substep with result', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, { runbookPath: 'test.runbook.md' });
      await manager.update(state.id, {
        substepStates: [{ id: '1', status: 'running', agentId: 'agent-123' }]
      });

      await manager.completeSubstep(state.id, '1', 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'done',
        agentId: 'agent-123',
        result: 'pass'
      });
    });
  });

  describe('updateFromActor flattened states', () => {
    it('extracts substep ID from flattened machine state (step::N::M)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::1::2',
          context: { variables: {}, retryCount: 0, substep: '2' }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);
      expect(updated.step).toBe('1');
      expect(updated.substep).toBe('2');
    });

    it('extracts step number from simple machine state (step::N)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::3',
          context: { variables: {}, retryCount: 0 }
        })
      };

      const steps: Step[] = [
        ...mockSteps,
        { name: '2', description: 'S2' },
        { name: '3', description: 'S3' }
      ];

      const updated = await manager.updateFromActor(state.id, actor as any, steps);
      expect(updated.step).toBe('3');
      expect(updated.substep).toBeUndefined();
    });
  });

  describe('create with prompted flag', () => {
    it('defaults to auto mode (prompted undefined)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      expect(state.prompted).toBeUndefined();
    });

    it('accepts prompted option', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md', prompted: true });
      expect(state.prompted).toBe(true);
    });
  });

  describe('Per-agent runbook stacks', () => {
    it('pushRunbook adds to default stack when no agentId', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.pushRunbook(state.id);

      const active = await manager.getActive();
      expect(active?.id).toBe(state.id);
    });

    it('pushRunbook adds to agent-specific stack', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.pushRunbook(state.id, 'agent-001');

      const active = await manager.getActive('agent-001');
      expect(active?.id).toBe(state.id);

      // Default stack should be empty
      const defaultActive = await manager.getActive();
      expect(defaultActive).toBeNull();
    });

    it('popRunbook removes from stack and returns new top', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });
      const child = await manager.create('child.md', mockRunbook, { runbookPath: 'child.md' });

      await manager.pushRunbook(parent.id);
      await manager.pushRunbook(child.id);

      const newTopId = await manager.popRunbook();
      expect(newTopId).toBe(parent.id);

      const active = await manager.getActive();
      expect(active?.id).toBe(parent.id);
    });

    it('supports arbitrary nesting depth', async () => {
      const wf1 = await manager.create('level1.md', mockRunbook, { runbookPath: 'level1.md' });
      const wf2 = await manager.create('level2.md', mockRunbook, { runbookPath: 'level2.md' });
      const wf3 = await manager.create('level3.md', mockRunbook, { runbookPath: 'level3.md' });
      const wf4 = await manager.create('level4.md', mockRunbook, { runbookPath: 'level4.md' });

      await manager.pushRunbook(wf1.id);
      await manager.pushRunbook(wf2.id);
      await manager.pushRunbook(wf3.id);
      await manager.pushRunbook(wf4.id);

      expect((await manager.getActive())?.id).toBe(wf4.id);

      await manager.popRunbook();
      expect((await manager.getActive())?.id).toBe(wf3.id);

      await manager.popRunbook();
      expect((await manager.getActive())?.id).toBe(wf2.id);

      await manager.popRunbook();
      expect((await manager.getActive())?.id).toBe(wf1.id);

      await manager.popRunbook();
      expect(await manager.getActive()).toBeNull();
    });

    it('parallel agents have independent stacks', async () => {
      const main = await manager.create('main.md', mockRunbook, { runbookPath: 'main.md' });
      const child1 = await manager.create('child1.md', mockRunbook, { runbookPath: 'child1.md' });
      const child2 = await manager.create('child2.md', mockRunbook, { runbookPath: 'child2.md' });

      await manager.pushRunbook(main.id);
      await manager.pushRunbook(child1.id, 'agent-001');
      await manager.pushRunbook(child2.id, 'agent-002');

      // Each agent sees their own runbook
      expect((await manager.getActive())?.id).toBe(main.id);
      expect((await manager.getActive('agent-001'))?.id).toBe(child1.id);
      expect((await manager.getActive('agent-002'))?.id).toBe(child2.id);

      // Pop one agent doesn't affect others
      await manager.popRunbook('agent-001');
      expect(await manager.getActive('agent-001')).toBeNull();
      expect((await manager.getActive('agent-002'))?.id).toBe(child2.id);
      expect((await manager.getActive())?.id).toBe(main.id);
    });
  });

  describe('Stash and pop operations', () => {
    it('stash saves current runbook and removes from stack', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.pushRunbook(state.id);

      const stashedId = await manager.stash();

      expect(stashedId).toBe(state.id);
      expect(await manager.getActive()).toBeNull();
      expect(await manager.getStashedRunbookId()).toBe(state.id);
    });

    it('stash returns null when no active runbook', async () => {
      const stashedId = await manager.stash();
      expect(stashedId).toBeNull();
    });

    it('pop restores stashed runbook', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.pushRunbook(state.id);
      await manager.stash();

      const restored = await manager.pop();

      expect(restored?.id).toBe(state.id);
      expect((await manager.getActive())?.id).toBe(state.id);
      expect(await manager.getStashedRunbookId()).toBeNull();
    });

    it('pop returns null when nothing stashed', async () => {
      const restored = await manager.pop();
      expect(restored).toBeNull();
    });

    it('stash works with agent-specific stacks', async () => {
      const state = await manager.create('agent.md', mockRunbook, { runbookPath: 'agent.md' });
      await manager.pushRunbook(state.id, 'agent-x');

      const stashedId = await manager.stash('agent-x');

      expect(stashedId).toBe(state.id);
      expect(await manager.getActive('agent-x')).toBeNull();
    });

    it('pop restores to agent-specific stack', async () => {
      const state = await manager.create('agent.md', mockRunbook, { runbookPath: 'agent.md' });
      await manager.pushRunbook(state.id, 'agent-y');
      await manager.stash('agent-y');

      const restored = await manager.pop('agent-y');

      expect(restored?.id).toBe(state.id);
      expect((await manager.getActive('agent-y'))?.id).toBe(state.id);
    });
  });

  describe('Agent bindings', () => {
    it('bindAgent creates new binding', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await manager.bindAgent(state.id, 'agent-abc', { step: '1' });

      const binding = await manager.getAgentBinding(state.id, 'agent-abc');
      expect(binding).toEqual({
        stepId: { step: '1' },
        status: 'running'
      });
    });

    it('getAgentBinding returns null for unbound agent', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      const binding = await manager.getAgentBinding(state.id, 'nonexistent');

      expect(binding).toBeNull();
    });

    it('updateAgentBinding modifies existing binding', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.bindAgent(state.id, 'agent-def', { step: '2' });

      await manager.updateAgentBinding(state.id, 'agent-def', {
        status: 'done',
        result: 'pass'
      });

      const binding = await manager.getAgentBinding(state.id, 'agent-def');
      expect(binding?.status).toBe('done');
      expect(binding?.result).toBe('pass');
    });

    it('updateAgentBinding throws for missing binding', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await expect(
        manager.updateAgentBinding(state.id, 'missing-agent', { status: 'done' })
      ).rejects.toThrow('No binding for agent');
    });

    it('bindAgent throws for missing runbook', async () => {
      await expect(
        manager.bindAgent('nonexistent-id', 'agent', { step: '1' })
      ).rejects.toThrow('not found');
    });
  });

  describe('Pending steps', () => {
    it('pushPendingStep adds to queue', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await manager.pushPendingStep(state.id, { stepId: { step: '1' } });
      await manager.pushPendingStep(state.id, { stepId: { step: '2' } });

      const updated = await manager.load(state.id);
      expect(updated?.pendingSteps).toHaveLength(2);
    });

    it('popPendingStep removes from queue in FIFO order', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await manager.pushPendingStep(state.id, { stepId: { step: 'first' } });
      await manager.pushPendingStep(state.id, { stepId: { step: 'second' } });

      const first = await manager.popPendingStep(state.id);
      const second = await manager.popPendingStep(state.id);
      const empty = await manager.popPendingStep(state.id);

      expect(first?.stepId).toEqual({ step: 'first' });
      expect(second?.stepId).toEqual({ step: 'second' });
      expect(empty).toBeNull();
    });

    it('popPendingStep returns null for nonexistent runbook', async () => {
      const result = await manager.popPendingStep('nonexistent');
      expect(result).toBeNull();
    });

    it('pushPendingStep throws for missing runbook', async () => {
      await expect(
        manager.pushPendingStep('nonexistent', { stepId: { step: '1' } })
      ).rejects.toThrow('not found');
    });
  });

  describe('List and delete operations', () => {
    it('list returns all runbook states', async () => {
      await manager.create('one.md', mockRunbook, { runbookPath: 'one.md' });
      await manager.create('two.md', mockRunbook, { runbookPath: 'two.md' });
      await manager.create('three.md', mockRunbook, { runbookPath: 'three.md' });

      const states = await manager.list();

      expect(states).toHaveLength(3);
    });

    it('list returns empty array when no states exist', async () => {
      const states = await manager.list();
      expect(states).toEqual([]);
    });

    it('delete removes runbook state', async () => {
      const state = await manager.create('delete.md', mockRunbook, { runbookPath: 'delete.md' });

      await manager.delete(state.id);

      const loaded = await manager.load(state.id);
      expect(loaded).toBeNull();
    });

    it('delete silently handles nonexistent runbook', async () => {
      // Should not throw
      await manager.delete('nonexistent-id');
    });
  });

  describe('Load and save operations', () => {
    it('load returns null for nonexistent runbook', async () => {
      const result = await manager.load('nonexistent-id');
      expect(result).toBeNull();
    });

    it('setLastResult updates last result', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await manager.setLastResult(state.id, 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.lastResult).toBe('pass');
    });

    it('update throws for missing runbook', async () => {
      await expect(
        manager.update('nonexistent', { step: '2' })
      ).rejects.toThrow('not found');
    });
  });

  describe('isParentPrompted', () => {
    it('returns true when parent has prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, {
        runbookPath: 'parent.md',
        prompted: true
      });

      const result = await manager.isParentPrompted(parent.id);
      expect(result).toBe(true);
    });

    it('returns false when parent has no prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });

      const result = await manager.isParentPrompted(parent.id);
      expect(result).toBe(false);
    });

    it('returns false for nonexistent parent', async () => {
      const result = await manager.isParentPrompted('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('runbookSrc storage', () => {
    it('should store runbookSrc when provided to create()', async () => {
      const runbookSrc = '# Test Runbook\n\n## 1. Step 1\n\nRendered content';

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
        runbookSrc,
      });

      expect(state.runbookSrc).toBe(runbookSrc);

      // Verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.runbookSrc).toBe(runbookSrc);
    });

    it('should allow runbookSrc to be undefined', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });

      expect(state.runbookSrc).toBeUndefined();
    });
  });

  describe('file permissions', () => {
    it('should set restrictive file permissions on state files', async () => {
      // Skip on Windows - permission bits are not reliable
      if (process.platform === 'win32') {
        return;
      }

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });

      const statePath = join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const stats = await stat(statePath);

      // Check mode is 0o600 (owner read/write only)
      // Note: mode includes file type bits, so mask with 0o777
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('FOR loop context persistence', () => {
    it('persists FOR fields through round-trip', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Update with forStack
      const updated = await manager.update(state.id, {
        forStack: [{ stepId: '1', iteration: 2, start: 1, end: 3, variable: 'item' }],
        iterationResults: ['pass', 'pass']
      });

      // Verify forStack is set
      expect(updated.forStack).toEqual([{ stepId: '1', iteration: 2, start: 1, end: 3, variable: 'item' }]);
      expect(updated.iterationResults).toEqual(['pass', 'pass']);

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toEqual([{ stepId: '1', iteration: 2, start: 1, end: 3, variable: 'item' }]);
      expect(loaded?.iterationResults).toEqual(['pass', 'pass']);
    });

    it('syncs FOR context fields from actor snapshot', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::1',
          context: {
            variables: { test: 'value' },
            retryCount: 0,
            forStack: [{ stepId: '1', iteration: 1, start: 1, end: 3, variable: 'item' }],
            iterationResults: ['pass'],
            lastAction: { type: 'START' }
          }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);

      expect(updated.forStack).toEqual([{ stepId: '1', iteration: 1, start: 1, end: 3, variable: 'item' }]);
      expect(updated.iterationResults).toEqual(['pass']);
      expect(updated.lastAction).toEqual({ type: 'START' });
    });

    it('clears FOR fields when runbook completes', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // First, set forStack
      await manager.update(state.id, {
        forStack: [{ stepId: '1', iteration: 2, start: 1, end: 3, variable: 'item' }],
        iterationResults: ['pass', 'pass']
      });

      // Now simulate completion via updateFromActor
      const completeActor = {
        getPersistedSnapshot: () => ({
          value: 'COMPLETE',
          context: {
            variables: { completed: true },
            retryCount: 0
          }
        })
      };

      const completed = await manager.updateFromActor(state.id, completeActor as any, mockSteps);

      // FOR fields should be cleared
      expect(completed.forStack).toBeUndefined();
      expect(completed.iterationResults).toBeUndefined();
    });

    it('migrates old snapshot context on createActor', async () => {
      // Test the createActor migration path directly
      // Start with a normal actor that has been running
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor1 = await manager.createActor(state.id, mockSteps);
      expect(actor1).not.toBeNull();

      // Get its snapshot
      const snapshot1 = actor1!.getPersistedSnapshot() as any;

      // Now manually modify the snapshot to have old-style flat fields
      const oldSnapshot = {
        ...snapshot1,
        context: {
          ...snapshot1.context,
          forIteration: 2,
          forStart: 1,
          forEnd: 3,
          forVariable: 'item',
          // Remove forStack to simulate old state
          forStack: undefined
        }
      };

      // Save this old snapshot
      await manager.update(state.id, { snapshot: oldSnapshot });

      // Create a new actor - should trigger migration
      const actor2 = await manager.createActor(state.id, mockSteps);
      expect(actor2).not.toBeNull();

      // Get the migrated snapshot
      const snapshot2 = actor2!.getPersistedSnapshot() as any;
      const context = snapshot2.context;

      // Should have forStack, not flat fields
      expect(context.forStack).toEqual([{
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        variable: 'item'
      }]);
      expect(context.forIteration).toBeUndefined();
      expect(context.forStart).toBeUndefined();
      expect(context.forEnd).toBeUndefined();
      expect(context.forVariable).toBeUndefined();
    });
  });

  describe('implicit ForContext filtering', () => {
    it('implicit ForContext entries are not persisted', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::1::1',
          context: {
            forStack: [{ stepId: '1', iteration: 1, start: 1, end: 1, implicit: true }],
            iterationResults: [],
            retryCount: 0,
            variables: {},
            lastAction: { type: 'START' },
          }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);
      expect(updated.forStack).toBeUndefined();
    });

    it('iterationResults not persisted for implicit loops', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::1::1',
          context: {
            forStack: [{ stepId: '1', iteration: 1, start: 1, end: 1, implicit: true }],
            iterationResults: ['pass'],
            retryCount: 0,
            variables: {},
            lastAction: { type: 'CONTINUE' },
          }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);
      expect(updated.iterationResults).toBeUndefined();
    });

    it('explicit ForContext entries are persisted normally', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::1::1',
          context: {
            forStack: [{ stepId: '1', iteration: 2, start: 1, end: 3, variable: 'batch' }],
            iterationResults: ['pass'],
            retryCount: 0,
            variables: {},
            lastAction: { type: 'CONTINUE' },
          }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);
      expect(updated.forStack).toHaveLength(1);
      expect(updated.iterationResults).toEqual(['pass']);
    });

    it('iterationResults preserved after explicit FOR loop exits (empty forStack)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step::2',
          context: {
            forStack: [],
            iterationResults: ['pass', 'fail', 'pass'],
            retryCount: 0,
            variables: {},
            lastAction: { type: 'CONTINUE' },
          }
        })
      };

      const steps: Step[] = [
        ...mockSteps,
        { name: '2', description: 'After loop' }
      ];

      const updated = await manager.updateFromActor(state.id, actor as any, steps);
      expect(updated.forStack).toBeUndefined(); // empty stack not persisted
      expect(updated.iterationResults).toEqual(['pass', 'fail', 'pass']); // preserved
    });
  });

  describe('Legacy snapshot rejection', () => {
    it('rejects state with GOTO_NEXT action in lastAction', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with GOTO_NEXT
      const fs = await import('fs/promises');
      const path = await import('path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        lastAction: { type: 'GOTO_NEXT' }
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('rejects state with instance field', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with instance field
      const fs = await import('fs/promises');
      const path = await import('path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        instance: 2
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('provides helpful error message for legacy snapshots', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with GOTO_NEXT
      const fs = await import('fs/promises');
      const path = await import('path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        lastAction: { type: 'GOTO_NEXT' }
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw with helpful message
      try {
        await manager.load(state.id);
        throw new Error('Should have thrown');
      } catch (e) {
        if (e instanceof Error) {
          expect(e.message).toContain('dynamic-step snapshots');
          expect(e.message).toContain('no longer supported');
          expect(e.message).toContain('restart execution');
        }
      }
    });
  });
});
