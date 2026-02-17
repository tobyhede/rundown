import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import type { Step, Runbook } from '../../src/runbook/types.js';

describe('RunbookStateManager', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let lifecycleService: ExecutionLifecycleService;
  let sessionService: SessionService;
  const mockSteps: Step[] = [
    {
      name: '1',
      description: 'Initial step',
    },
  ];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps,
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ws-test-'));
    manager = new RunbookStateManager(testDir);
    lifecycleService = new ExecutionLifecycleService(manager);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getChildRunbookResult', () => {
    it('should return pass when child has completed=true', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, {
        runbookPath: 'child.runbook.md',
      });
      await manager.update(child.id, { variables: { completed: true } });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('pass');
    });

    it('should return fail when child has stopped=true', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, {
        runbookPath: 'child.runbook.md',
      });
      await manager.update(child.id, { variables: { stopped: true } });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('fail');
    });

    it('should return null when child is still active', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, {
        runbookPath: 'child.runbook.md',
      });
      await sessionService.pushRunbook(child.id);

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });

    it('should return pass when child state deleted', async () => {
      const result = await lifecycleService.getChildRunbookResult('nonexistent-id');
      expect(result).toBe('pass');
    });

    it('should return null when child is stashed', async () => {
      const child = await manager.create('child.runbook.md', mockRunbook, {
        runbookPath: 'child.runbook.md',
      });
      await sessionService.pushRunbook(child.id);
      await sessionService.stash();

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });
  });

  describe('RunbookStateManager substep initialization', () => {
    it('initializes substepStates when step has static substeps', async () => {
      const substeps = [
        { id: '1', description: 'First reviewer', prompts: [] },
        { id: '2', description: 'Second reviewer', prompts: [] },
      ];

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      await manager.initializeSubsteps(state.id, substeps);

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'pending',
        agentId: undefined,
        result: undefined,
      });
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('binds agent to substep', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      await manager.update(state.id, {
        substepStates: [{ id: '1', status: 'pending' }],
      });

      await manager.bindSubstepAgent(state.id, '1', 'agent-123');

      const updated = await manager.load(state.id);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'running',
        agentId: 'agent-123',
        result: undefined,
      });
    });

    it('completes substep with result', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      await manager.update(state.id, {
        substepStates: [{ id: '1', status: 'running', agentId: 'agent-123' }],
      });

      await manager.completeSubstep(state.id, '1', 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        status: 'done',
        agentId: 'agent-123',
        result: 'pass',
      });
    });
  });

  describe('create with prompted flag', () => {
    it('defaults to auto mode (prompted undefined)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      expect(state.prompted).toBeUndefined();
    });

    it('accepts prompted option', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        prompted: true,
      });
      expect(state.prompted).toBe(true);
    });
  });

  describe('Agent bindings', () => {
    it('bindAgent creates new binding', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await manager.bindAgent(state.id, 'agent-abc', { step: '1' });

      const binding = await manager.getAgentBinding(state.id, 'agent-abc');
      expect(binding).toEqual({
        stepId: { step: '1' },
        status: 'running',
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
        result: 'pass',
      });

      const binding = await manager.getAgentBinding(state.id, 'agent-def');
      expect(binding?.status).toBe('done');
      expect(binding?.result).toBe('pass');
    });

    it('updateAgentBinding throws for missing binding', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await expect(
        manager.updateAgentBinding(state.id, 'missing-agent', { status: 'done' }),
      ).rejects.toThrow('No binding for agent');
    });

    it('bindAgent throws for missing runbook', async () => {
      await expect(manager.bindAgent('nonexistent-id', 'agent', { step: '1' })).rejects.toThrow(
        'not found',
      );
    });
  });

  describe('Pending steps', () => {
    it('pushPendingStep adds to queue', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      await lifecycleService.pushPendingStep(state.id, { stepId: { step: '1' } });
      await lifecycleService.pushPendingStep(state.id, { stepId: { step: '2' } });

      const updated = await manager.load(state.id);
      expect(updated?.pendingSteps).toHaveLength(2);
    });

    it('popPendingStep removes from queue in FIFO order', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      await lifecycleService.pushPendingStep(state.id, { stepId: { step: 'first' } });
      await lifecycleService.pushPendingStep(state.id, { stepId: { step: 'second' } });

      const first = await lifecycleService.popPendingStep(state.id);
      const second = await lifecycleService.popPendingStep(state.id);
      const empty = await lifecycleService.popPendingStep(state.id);

      expect(first?.stepId).toEqual({ step: 'first' });
      expect(second?.stepId).toEqual({ step: 'second' });
      expect(empty).toBeNull();
    });

    it('popPendingStep returns null for nonexistent runbook', async () => {
      const result = await lifecycleService.popPendingStep('nonexistent');
      expect(result).toBeNull();
    });

    it('pushPendingStep throws for missing runbook', async () => {
      await expect(
        lifecycleService.pushPendingStep('nonexistent', { stepId: { step: '1' } }),
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

      await lifecycleService.setLastResult(state.id, 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.lastResult).toBe('pass');
    });

    it('update throws for missing runbook', async () => {
      await expect(manager.update('nonexistent', { step: '2' })).rejects.toThrow('not found');
    });
  });

  describe('isParentPrompted', () => {
    it('returns true when parent has prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, {
        runbookPath: 'parent.md',
        prompted: true,
      });

      const result = await lifecycleService.isParentPrompted(parent.id);
      expect(result).toBe(true);
    });

    it('returns false when parent has no prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });

      const result = await lifecycleService.isParentPrompted(parent.id);
      expect(result).toBe(false);
    });

    it('returns false for nonexistent parent', async () => {
      const result = await lifecycleService.isParentPrompted('nonexistent');
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
        forStack: [
          {
            stepId: '1',
            iteration: 2,
            start: 1,
            end: 3,
            variable: 'item',
            implicit: false,
            source: { kind: 'range' as const },
          },
        ],
        iterationResults: ['pass', 'pass'],
      });

      // Verify forStack is set
      expect(updated.forStack).toEqual([
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'item',
          implicit: false,
          source: { kind: 'range' as const },
        },
      ]);
      expect(updated.iterationResults).toEqual(['pass', 'pass']);

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toEqual([
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'item',
          implicit: false,
          source: { kind: 'range' as const },
        },
      ]);
      expect(loaded?.iterationResults).toEqual(['pass', 'pass']);
    });
  });

  describe('Legacy snapshot rejection', () => {
    it('rejects state with GOTO_NEXT action in lastAction', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with GOTO_NEXT
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        lastAction: { type: 'GOTO_NEXT' },
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('rejects state with instance field', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with instance field
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        instance: 2,
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('provides helpful error message for legacy snapshots', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // Manually save legacy state with GOTO_NEXT
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const stateFilePath = path.join(testDir, '.claude/rundown/runs', `${state.id}.json`);
      const legacyState = {
        ...state,
        lastAction: { type: 'GOTO_NEXT' },
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

  describe('sources persistence', () => {
    it('persists sources through create/load round-trip', async () => {
      const sources = {
        items: {
          kind: 'array' as const,
          items: ['a', 'b'],
        },
      };

      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        sources,
      });

      // Verify sources are present in created state
      expect(state.sources).toEqual(sources);

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.sources).toEqual(sources);
    });
  });
});
