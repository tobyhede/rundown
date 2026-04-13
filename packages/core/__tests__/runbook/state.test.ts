import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { statePath as _statePath } from '../../src/paths.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Step, Runbook } from '../../src/runbook/types.js';

describe('RunbookStateManager', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let lifecycleService: ExecutionLifecycleService;
  let sessionService: SessionService;
  const mockSteps: Step[] = [
    {
      kind: 'base',
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
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1'));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        frameKey: buildFrameKey('1'),
        status: 'pending',
        result: undefined,
      });
    });

    it('initializes substepStates with frameKey', async () => {
      const substeps = [
        { id: '1', description: 'First', prompts: [] },
        { id: '2', description: 'Second', prompts: [] },
      ];

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        frameKey: buildFrameKey('1', 1),
        status: 'pending',
        result: undefined,
      });
    });

    it('preserves entries from other frames when frameKey is provided', async () => {
      const substeps = [{ id: '1', description: 'First', prompts: [] }];

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });

      // Initialize iteration 1
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));
      // Initialize iteration 2 — should preserve iteration 1 entries
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 2));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        frameKey: buildFrameKey('1', 1),
        status: 'pending',
        result: undefined,
      });
      expect(updated?.substepStates?.[1]).toEqual({
        id: '1',
        frameKey: buildFrameKey('1', 2),
        status: 'pending',
        result: undefined,
      });
    });

    it('replaces entries from same frame on re-initialization', async () => {
      const substeps = [{ id: '1', description: 'First', prompts: [] }];

      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });

      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));
      // Re-initialize same frame — should replace, not duplicate
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(1);
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('completes substep with result', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      await manager.update(state.id, {
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });

      await manager.completeSubstep(state.id, '1', 'pass', buildFrameKey('1'));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        frameKey: buildFrameKey('1'),
        status: 'done',
        result: 'pass',
      });
    });

    it('completes substep scoped by frameKey', async () => {
      const state = await manager.create('test.runbook.md', mockRunbook, {
        runbookPath: 'test.runbook.md',
      });
      // Initialize substeps for two different frames (simulating FOR loop iterations)
      const frameA = buildFrameKey('1', 1);
      const frameB = buildFrameKey('1', 2);
      await manager.update(state.id, {
        substepStates: [
          { id: '1', frameKey: frameA, status: 'running' },
          { id: '1', frameKey: frameB, status: 'running' },
        ],
      });

      // Complete only the substep in frame A
      await manager.completeSubstep(state.id, '1', 'pass', frameA);

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(2);
      // Frame A is done
      expect(updated?.substepStates?.[0]).toEqual({
        id: '1',
        frameKey: frameA,
        status: 'done',
        result: 'pass',
      });
      // Frame B remains running
      expect(updated?.substepStates?.[1]).toEqual({
        id: '1',
        frameKey: frameB,
        status: 'running',
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

    it('loads legacy targetPath fields and strips them on save', async () => {
      const state = await manager.create('legacy.md', mockRunbook, { runbookPath: 'legacy.md' });
      const resolvedKey = '1||1|';

      await manager.update(state.id, {
        resolvedCompletions: {
          [resolvedKey]: {
            agentId: 'agent-1',
            result: 'pass',
            targetStep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: new Date().toISOString(),
          },
        },
      });

      const stateFilePath = _statePath(testDir, state.id);
      const raw = JSON.parse(await readFile(stateFilePath, 'utf8')) as Record<string, unknown>;

      const resolved = (raw.resolvedCompletions as Record<string, Record<string, unknown>>)[
        resolvedKey
      ];
      resolved.targetPath = '1';
      await writeFile(stateFilePath, JSON.stringify(raw), { mode: 0o600 });

      const loaded = await manager.load(state.id);
      expect(loaded).not.toBeNull();
      const loadedResolved = loaded?.resolvedCompletions?.[resolvedKey] as
        | { targetPath?: string }
        | undefined;
      expect(loadedResolved?.targetPath).toBeUndefined();

      await manager.update(state.id, { stepName: 'updated' });
      const saved = await readFile(stateFilePath, 'utf8');
      expect(saved).not.toContain('targetPath');
    });
  });

  describe('isPrompted', () => {
    it('returns true when parent has prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, {
        runbookPath: 'parent.md',
        prompted: true,
      });

      const result = await lifecycleService.isPrompted(parent.id);
      expect(result).toBe(true);
    });

    it('returns false when parent has no prompted flag', async () => {
      const parent = await manager.create('parent.md', mockRunbook, { runbookPath: 'parent.md' });

      const result = await lifecycleService.isPrompted(parent.id);
      expect(result).toBe(false);
    });

    it('returns false for nonexistent parent', async () => {
      const result = await lifecycleService.isPrompted('nonexistent');
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

      const statePath = _statePath(testDir, state.id);
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
      const stateFilePath = _statePath(testDir, state.id);
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
      const stateFilePath = _statePath(testDir, state.id);
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
      const stateFilePath = _statePath(testDir, state.id);
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
        if (Error.isError(e)) {
          expect(e.message).toContain('dynamic-step snapshots');
          expect(e.message).toContain('no longer supported');
          expect(e.message).toContain('restart execution');
        }
      }
    });
  });

  describe('templateVars persistence (unified model)', () => {
    it('persists templateVars with arrays through create/load round-trip', async () => {
      const templateVars = {
        items: ['a', 'b'] as const,
        env: 'prod',
      };

      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        templateVars: templateVars as Record<string, any>,
      });

      // Verify templateVars are present in created state
      expect(state.templateVars?.items).toEqual(['a', 'b']);
      expect(state.templateVars?.env).toBe('prod');

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars?.items).toEqual(['a', 'b']);
    });
  });
});
