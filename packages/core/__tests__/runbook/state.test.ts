import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { type Step, type Runbook } from '../../src/runbook/types.js';

describe('RunbookStateManager', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  const mockSteps: Step[] = [{
    name: '1',
    description: 'Initial step',
    isDynamic: false
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
      const child = await manager.create('child.runbook.md', mockRunbook);
      await manager.update(child.id, { variables: { completed: true } });

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBe('pass');
    });

    it('should return fail when child has stopped=true', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook);
      await manager.update(child.id, { variables: { stopped: true } });

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBe('fail');
    });

    it('should return null when child is still active', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook);
      await manager.pushRunbook(child.id);

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });

    it('should return pass when child state deleted', async () => {
      const result = await manager.getChildRunbookResult('nonexistent-id');
      expect(result).toBe('pass');
    });

    it('should return null when child is stashed', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook);
      await manager.pushRunbook(child.id);
      await manager.stash();

      const result = await manager.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });
  });

  describe('RunbookStateManager substep initialization', () => {
    it('initializes substepStates when step has static substeps', async () => {
      const substeps = [
        { id: '1', description: 'First reviewer', isDynamic: false, prompts: [] },
        { id: '2', description: 'Second reviewer', isDynamic: false, prompts: [] }
      ];

      const state = await manager.create('test.runbook.md', mockRunbook);
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

    it('does not initialize for dynamic substeps', async () => {
      const substeps = [
        { id: '{n}', description: 'Dynamic step', isDynamic: true, prompts: [] }
      ];

      const state = await manager.create('test.runbook.md', mockRunbook);
      await manager.initializeSubsteps(state.id, substeps);

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toEqual([]);
    });
  });

  describe('RunbookStateManager dynamic substeps', () => {
    it('adds dynamic substep with incrementing ID', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook);
      await manager.update(state.id, { substepStates: [] });

      const id1 = await manager.addDynamicSubstep(state.id);
      expect(id1).toBe('1');

      const id2 = await manager.addDynamicSubstep(state.id);
      expect(id2).toBe('2');

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0].id).toBe('1');
      expect(updated?.substepStates?.[1].id).toBe('2');
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('binds agent to substep', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook);
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
      const state = await manager.create('test.runbook.md', mockRunbook);
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
    it('extracts substep ID from flattened machine state (step_N_M)', async () => {
      const state = await manager.create('test.md', mockRunbook);
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step_1_2',
          context: { variables: {}, retryCount: 0, substep: '2' }
        })
      };

      const updated = await manager.updateFromActor(state.id, actor as any, mockSteps);
      expect(updated.step).toBe('1');
      expect(updated.substep).toBe('2');
    });

    it('extracts step number from simple machine state (step_N)', async () => {
      const state = await manager.create('test.md', mockRunbook);
      const actor = {
        getPersistedSnapshot: () => ({
          value: 'step_3',
          context: { variables: {}, retryCount: 0 }
        })
      };

      const steps: Step[] = [
        ...mockSteps,
        { name: '2', description: 'S2', isDynamic: false },
        { name: '3', description: 'S3', isDynamic: false }
      ];

      const updated = await manager.updateFromActor(state.id, actor as any, steps);
      expect(updated.step).toBe('3');
      expect(updated.substep).toBeUndefined();
    });
  });

  describe('create with prompted flag', () => {
    it('defaults to auto mode (prompted undefined)', async () => {
      const state = await manager.create('test.md', mockRunbook);
      expect(state.prompted).toBeUndefined();
    });

    it('accepts prompted option', async () => {
      const state = await manager.create('test.md', mockRunbook, { prompted: true });
      expect(state.prompted).toBe(true);
    });
  });

  describe('dynamic runbook initialization', () => {
    it('initializes dynamic runbook with instance=1 and step={N}', async () => {
      const dynamicRunbook: Runbook = {
        title: 'Dynamic Test',
        steps: [{
          name: '{N}',
          description: 'Process Batch',
          isDynamic: true,
        }],
      };

      const state = await manager.create('dynamic.runbook.md', dynamicRunbook);

      expect(state.step).toBe('{N}');        // Keep {N} for machine integrity
      expect(state.instance).toBe(1);         // Use instance field for display
      expect(state.stepName).toBe('Process Batch');
    });

    it('does not set instance for non-dynamic runbooks', async () => {
      const staticRunbook: Runbook = {
        title: 'Static Test',
        steps: [{
          name: 'Setup',
          description: 'Setup Step',
          isDynamic: false,
        }],
      };

      const state = await manager.create('static.runbook.md', staticRunbook);

      expect(state.step).toBe('Setup');
      expect(state.instance).toBeUndefined();
    });
  });

  describe('Per-agent runbook stacks', () => {
    it('pushRunbook adds to default stack when no agentId', async () => {
      const state = await manager.create('test.md', mockRunbook);
      await manager.pushRunbook(state.id);

      const active = await manager.getActive();
      expect(active?.id).toBe(state.id);
    });

    it('pushRunbook adds to agent-specific stack', async () => {
      const state = await manager.create('test.md', mockRunbook);
      await manager.pushRunbook(state.id, 'agent-001');

      const active = await manager.getActive('agent-001');
      expect(active?.id).toBe(state.id);

      // Default stack should be empty
      const defaultActive = await manager.getActive();
      expect(defaultActive).toBeNull();
    });

    it('popRunbook removes from stack and returns new top', async () => {
      const parent = await manager.create('parent.md', mockRunbook);
      const child = await manager.create('child.md', mockRunbook);

      await manager.pushRunbook(parent.id);
      await manager.pushRunbook(child.id);

      const newTopId = await manager.popRunbook();
      expect(newTopId).toBe(parent.id);

      const active = await manager.getActive();
      expect(active?.id).toBe(parent.id);
    });

    it('supports arbitrary nesting depth', async () => {
      const wf1 = await manager.create('level1.md', mockRunbook);
      const wf2 = await manager.create('level2.md', mockRunbook);
      const wf3 = await manager.create('level3.md', mockRunbook);
      const wf4 = await manager.create('level4.md', mockRunbook);

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
      const main = await manager.create('main.md', mockRunbook);
      const child1 = await manager.create('child1.md', mockRunbook);
      const child2 = await manager.create('child2.md', mockRunbook);

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
});
