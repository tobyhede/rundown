import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isError } from '../../src/errors.js';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RUN_ID_PATTERN, statePath as _statePath } from '../../src/paths.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Step, Runbook } from '../../src/runbook/types.js';
import { makeBaseStep, makeSubstep } from '../helpers/step-factories.js';

describe('RunbookStateManager', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let lifecycleService: ExecutionLifecycleService;
  let sessionService: SessionService;
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps,
  };
  const VALID_RUN_ID = 'wf_0123456789abcdef0123456789abcdef';

  function projectRunbookRef(path = 'test.runbook.md') {
    return { source: 'project' as const, path };
  }

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'ws-test-'));
    manager = new RunbookStateManager(testDir);
    lifecycleService = new ExecutionLifecycleService(manager);
    sessionService = new SessionService(manager);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('run ids and persisted runbook identity', () => {
    it('creates wf_ run ids with 32 lowercase hex chars', async () => {
      const state = await manager.create(projectRunbookRef('probe.runbook.md'), mockRunbook, {});
      const removedPathField = `runbook${'Path'}`;

      expect(state.id).toMatch(RUN_ID_PATTERN);
      expect(state.runbook).toEqual({ source: 'project', path: 'probe.runbook.md' });
      expect(removedPathField in state).toBe(false);

      const raw = JSON.parse(await fs.readFile(_statePath(testDir, state.id), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(raw.runbook).toEqual({ source: 'project', path: 'probe.runbook.md' });
      expect(raw).not.toHaveProperty(removedPathField);
    });

    it('uses a preallocated run id when provided', async () => {
      const state = await manager.create(projectRunbookRef('probe.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });

      expect(state.id).toBe(VALID_RUN_ID);
      expect(await manager.load(VALID_RUN_ID)).toMatchObject({
        id: VALID_RUN_ID,
        runbook: { source: 'project', path: 'probe.runbook.md' },
      });
    });

    it('rejects non-canonical runbook refs before writing state', async () => {
      const writeSpy = jest.spyOn(fs, 'writeFile');
      syncBuiltinESMExports();

      await expect(
        manager.create({ source: 'project', path: '../escape.runbook.md' }, mockRunbook, {
          runId: VALID_RUN_ID,
        }),
      ).rejects.toThrow('Invalid runbook');

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
      syncBuiltinESMExports();
    });

    it.each([
      'wf_short',
      'wf_ABCDEF0123456789ABCDEF0123456789',
      'plain_id',
      '../escape',
    ])('rejects invalid run id %s before file access', async (badRunId) => {
      const readSpy = jest.spyOn(fs, 'readFile');
      const writeSpy = jest.spyOn(fs, 'writeFile');
      const unlinkSpy = jest.spyOn(fs, 'unlink');
      const rmSpy = jest.spyOn(fs, 'rm');
      syncBuiltinESMExports();

      expect(() => _statePath(testDir, badRunId)).toThrow('Invalid RunId');
      await expect(manager.load(badRunId)).rejects.toThrow('Invalid RunId');
      await expect(manager.update(badRunId, { lifecycle: 'completed' })).rejects.toThrow(
        'Invalid RunId',
      );
      await expect(manager.delete(badRunId)).rejects.toThrow('Invalid RunId');
      await expect(
        manager.create(projectRunbookRef('probe.runbook.md'), mockRunbook, { runId: badRunId }),
      ).rejects.toThrow('Invalid RunId');

      expect(readSpy).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
      readSpy.mockRestore();
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
      rmSpy.mockRestore();
      syncBuiltinESMExports();
    });

    it.each([
      {
        name: 'delegation childRunId',
        mutate: (raw: Record<string, unknown>) => ({
          ...raw,
          substepStates: [
            {
              id: '1.1',
              frameKey: '1.1',
              status: 'running',
              delegation: {
                tokenHash: `sha256:${'a'.repeat(64)}`,
                childRunbookPath: 'child.runbook.md',
                contextSnapshot: { vars: {}, ancestors: [] },
                childRunId: '../escape',
                createdAt: '2025-01-01T00:00:00.000Z',
                cancelledAt: null,
              },
            },
          ],
        }),
      },
      {
        name: 'ancestor runId',
        mutate: (raw: Record<string, unknown>) => ({
          ...raw,
          substepStates: [
            {
              id: '1.1',
              frameKey: '1.1',
              status: 'running',
              delegation: {
                tokenHash: `sha256:${'a'.repeat(64)}`,
                childRunbookPath: 'child.runbook.md',
                contextSnapshot: {
                  vars: {},
                  ancestors: [
                    {
                      runId: 'old-id',
                      runbook: 'parent.runbook.md',
                      step: '1',
                      substep: null,
                      vars: {},
                    },
                  ],
                },
                childRunId: null,
                createdAt: '2025-01-01T00:00:00.000Z',
                cancelledAt: null,
              },
            },
          ],
        }),
      },
    ])('rejects invalid nested run ids on manager.load(): $name', async ({ mutate }) => {
      const state = await manager.create(projectRunbookRef('nested.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });
      const stateFile = _statePath(testDir, state.id);
      const raw = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;

      await fs.writeFile(stateFile, JSON.stringify(mutate(raw), null, 2));

      await expect(manager.load(state.id)).rejects.toThrow('schema validation failed');
    });
  });

  describe('terminalAt', () => {
    it('sets terminalAt when lifecycle first becomes completed', async () => {
      const state = await manager.create(projectRunbookRef('terminal.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });

      const completed = await manager.update(state.id, { lifecycle: 'completed' });

      expect(completed.lifecycle).toBe('completed');
      expect(completed.terminalAt).toEqual(expect.any(String));
      expect(completed.terminalAt).toBe(completed.updatedAt);
      expect(Number.isNaN(Date.parse(completed.terminalAt!))).toBe(false);

      const reloaded = await manager.load(state.id);
      expect(reloaded?.terminalAt).toBe(completed.terminalAt);
      expect(reloaded?.updatedAt).toBe(completed.updatedAt);
      expect(reloaded?.terminalAt).toBe(reloaded?.updatedAt);
    });

    it('sets terminalAt when lifecycle first becomes stopped', async () => {
      const state = await manager.create(projectRunbookRef('terminal.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });

      const stopped = await manager.update(state.id, { lifecycle: 'stopped' });

      expect(stopped.lifecycle).toBe('stopped');
      expect(stopped.terminalAt).toEqual(expect.any(String));
      expect(stopped.terminalAt).toBe(stopped.updatedAt);
      expect(Number.isNaN(Date.parse(stopped.terminalAt!))).toBe(false);

      const reloaded = await manager.load(state.id);
      expect(reloaded?.terminalAt).toBe(stopped.terminalAt);
      expect(reloaded?.updatedAt).toBe(stopped.updatedAt);
      expect(reloaded?.terminalAt).toBe(reloaded?.updatedAt);
    });

    it('preserves terminalAt after later terminal updates', async () => {
      const state = await manager.create(projectRunbookRef('terminal.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });

      const completed = await manager.update(state.id, { lifecycle: 'completed' });
      const preserved = await manager.update(state.id, { lifecycle: 'stopped' });

      expect(preserved.lifecycle).toBe('stopped');
      expect(preserved.terminalAt).toBe(completed.terminalAt);
    });

    it('does not set terminalAt for non-terminal updates', async () => {
      const state = await manager.create(projectRunbookRef('terminal.runbook.md'), mockRunbook, {
        runId: VALID_RUN_ID,
      });

      const running = await manager.update(state.id, { step: '1' });

      expect(running.lifecycle).toBe('running');
      expect(running.terminalAt).toBeUndefined();
    });
  });

  describe('getChildRunbookResult', () => {
    it('should return pass when child has lifecycle completed', async () => {
      const child = await manager.create(
        { source: 'project' as const, path: 'child.runbook.md' },
        mockRunbook,
        {},
      );
      await manager.update(child.id, { lifecycle: 'completed' });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('pass');
    });

    it('should return fail when child has lifecycle stopped', async () => {
      const child = await manager.create(
        { source: 'project' as const, path: 'child.runbook.md' },
        mockRunbook,
        {},
      );
      await manager.update(child.id, { lifecycle: 'stopped' });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('fail');
    });

    it('should return null when child is still active', async () => {
      const child = await manager.create(
        { source: 'project' as const, path: 'child.runbook.md' },
        mockRunbook,
        {},
      );
      await sessionService.pushRunbook(child.id);

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });

    it('should return pass when child state deleted', async () => {
      const result = await lifecycleService.getChildRunbookResult(
        'wf_ffffffffffffffffffffffffffffffff',
      );
      expect(result).toBe('pass');
    });

    it('should return null when child is stashed', async () => {
      const child = await manager.create(
        { source: 'project' as const, path: 'child.runbook.md' },
        mockRunbook,
        {},
      );
      await sessionService.pushRunbook(child.id);
      await sessionService.stash();

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });
  });

  describe('RunbookStateManager substep initialization', () => {
    it('initializes substepStates when step has static substeps', async () => {
      const substeps = [
        makeSubstep({ id: '1', description: 'First reviewer' }),
        makeSubstep({ id: '2', description: 'Second reviewer' }),
      ];

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
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
        makeSubstep({ id: '1', description: 'First' }),
        makeSubstep({ id: '2', description: 'Second' }),
      ];

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
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
      const substeps = [makeSubstep({ id: '1', description: 'First' })];

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

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
      const substeps = [makeSubstep({ id: '1', description: 'First' })];

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));
      // Re-initialize same frame — should replace, not duplicate
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(1);
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('completes substep with result', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
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
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
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
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
      expect(state.prompted).toBeUndefined();
    });

    it('accepts prompted option', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {
          prompted: true,
        },
      );
      expect(state.prompted).toBe(true);
    });
  });

  describe('List and delete operations', () => {
    it('list returns all runbook states', async () => {
      await manager.create({ source: 'project' as const, path: 'one.runbook.md' }, mockRunbook, {});
      await manager.create({ source: 'project' as const, path: 'two.runbook.md' }, mockRunbook, {});
      await manager.create(
        { source: 'project' as const, path: 'three.runbook.md' },
        mockRunbook,
        {},
      );

      const states = await manager.list();

      expect(states).toHaveLength(3);
    });

    it('list returns empty array when no states exist', async () => {
      const states = await manager.list();
      expect(states).toEqual([]);
    });

    it('delete removes runbook state', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'delete.runbook.md' },
        mockRunbook,
        {},
      );

      await manager.delete(state.id);

      const loaded = await manager.load(state.id);
      expect(loaded).toBeNull();
    });

    it('delete silently handles nonexistent runbook', async () => {
      // Should not throw
      await manager.delete('wf_ffffffffffffffffffffffffffffffff');
    });
  });

  describe('Load and save operations', () => {
    it('rejects legacy per-agent stacks session shape', async () => {
      await fs.mkdir(join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          stacks: {
            'agent:legacy-agent:session:legacy-session': ['legacy-run-id'],
          },
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(/Legacy session ownership format/);
    });

    it('rejects legacy ownedRunbooks session shape', async () => {
      await fs.mkdir(join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: ['parent'],
          ownedRunbooks: {},
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(/Legacy session ownership format/);
    });

    it('rejects legacy stashedRunbookOwnership session shape', async () => {
      await fs.mkdir(join(testDir, '.rundown'), { recursive: true });
      await fs.writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: ['parent'],
          stashedRunbookOwnership: { agent: 'foo', session: 'bar' },
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(/Legacy session ownership format/);
    });

    it('load returns null for nonexistent runbook', async () => {
      const result = await manager.load('wf_ffffffffffffffffffffffffffffffff');
      expect(result).toBeNull();
    });

    it('setLastResult updates last result', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      await lifecycleService.setLastResult(state.id, 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.lastResult).toBe('pass');
    });

    it('update throws for missing runbook', async () => {
      await expect(
        manager.update('wf_ffffffffffffffffffffffffffffffff', { step: '2' }),
      ).rejects.toThrow('not found');
    });

    it('loads legacy targetPath fields and strips them on save', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'legacy.runbook.md' },
        mockRunbook,
        {},
      );
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
      const raw = JSON.parse(await fs.readFile(stateFilePath, 'utf8')) as Record<string, unknown>;

      const resolved = (raw.resolvedCompletions as Record<string, Record<string, unknown>>)[
        resolvedKey
      ];
      resolved.targetPath = '1';
      await fs.writeFile(stateFilePath, JSON.stringify(raw), { mode: 0o600 });

      const loaded = await manager.load(state.id);
      expect(loaded).not.toBeNull();
      const loadedResolved = loaded?.resolvedCompletions?.[resolvedKey] as
        | { targetPath?: string }
        | undefined;
      expect(loadedResolved?.targetPath).toBeUndefined();

      await manager.update(state.id, { stepName: 'updated' });
      const saved = await fs.readFile(stateFilePath, 'utf8');
      expect(saved).not.toContain('targetPath');
    });
  });

  describe('update variables/templateVars semantics', () => {
    it('replaces templateVars wholesale when updates.templateVars is defined', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {
          templateVars: { env: 'staging', port: 3000 },
        },
      );

      const updated = await manager.update(state.id, {
        templateVars: { env: 'prod' },
      });

      expect(updated.templateVars).toEqual({ env: 'prod' });
      expect(updated.templateVars).not.toHaveProperty('port');
    });

    it('preserves existing templateVars when updates.templateVars is undefined', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {
          templateVars: { env: 'staging', port: 3000 },
        },
      );

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.templateVars).toEqual({ env: 'staging', port: 3000 });
    });

    it('shallow-merges variables when updates.variables is defined', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
      await manager.update(state.id, { variables: { A: '1', B: '2' } });

      const updated = await manager.update(state.id, { variables: { B: 'two', C: '3' } });

      expect(updated.variables).toEqual({ A: '1', B: 'two', C: '3' });
    });

    it('preserves existing variables when updates.variables is undefined', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );
      await manager.update(state.id, { variables: { A: '1' } });

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.variables).toEqual({ A: '1' });
    });
  });

  describe('isPrompted', () => {
    it('returns true when parent has prompted flag', async () => {
      const parent = await manager.create(
        { source: 'project' as const, path: 'parent.runbook.md' },
        mockRunbook,
        {
          prompted: true,
        },
      );

      const result = await lifecycleService.isPrompted(parent.id);
      expect(result).toBe(true);
    });

    it('returns false when parent has no prompted flag', async () => {
      const parent = await manager.create(
        { source: 'project' as const, path: 'parent.runbook.md' },
        mockRunbook,
        {},
      );

      const result = await lifecycleService.isPrompted(parent.id);
      expect(result).toBe(false);
    });

    it('returns false for nonexistent parent', async () => {
      const result = await lifecycleService.isPrompted('wf_ffffffffffffffffffffffffffffffff');
      expect(result).toBe(false);
    });
  });

  describe('runbookSrc storage', () => {
    it('should store runbookSrc when provided to create()', async () => {
      const runbookSrc = '# Test Runbook\n\n## 1. Step 1\n\nRendered content';

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookSrc,
        },
      );

      expect(state.runbookSrc).toBe(runbookSrc);

      // Verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.runbookSrc).toBe(runbookSrc);
    });

    it('should allow runbookSrc to be undefined', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      expect(state.runbookSrc).toBeUndefined();
    });
  });

  describe('file permissions', () => {
    it('should set restrictive file permissions on state files', async () => {
      // Skip on Windows - permission bits are not reliable
      if (process.platform === 'win32') {
        return;
      }

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      const statePath = _statePath(testDir, state.id);
      const stats = await fs.stat(statePath);

      // Check mode is 0o600 (owner read/write only)
      // Note: mode includes file type bits, so mask with 0o777
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('FOR loop context persistence', () => {
    it('persists FOR fields through round-trip', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

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
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      // Manually save legacy state with GOTO_NEXT
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
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      // Manually save legacy state with instance field
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
      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {},
      );

      // Manually save legacy state with GOTO_NEXT
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
        if (isError(e)) {
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

      const state = await manager.create(
        { source: 'project' as const, path: 'test.runbook.md' },
        mockRunbook,
        {
          templateVars: templateVars,
        },
      );

      // Verify templateVars are present in created state
      expect(state.templateVars?.items).toEqual(['a', 'b']);
      expect(state.templateVars?.env).toBe('prod');

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars?.items).toEqual(['a', 'b']);
    });
  });

  describe('RunbookStateManager.delete — output capture cleanup', () => {
    it('removes the per-run outputs directory alongside the state JSON', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'demo.runbook.md' },
        mockRunbook,
        {},
      );
      // Simulate captured output files written during a run
      const outDir = join(testDir, '.rundown', 'runs', state.id, 'outputs', '1');
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(join(outDir, 'Version'), 'v1.2.3');

      await manager.delete(state.id);

      // Both the state file and the outputs dir should be gone
      await expect(
        fs.stat(join(testDir, '.rundown', 'runs', `${state.id}.json`)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.stat(join(testDir, '.rundown', 'runs', state.id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('is a no-op when the outputs directory does not exist', async () => {
      const state = await manager.create(
        { source: 'project' as const, path: 'demo.runbook.md' },
        mockRunbook,
        {},
      );
      // No outputs dir created — delete must still succeed
      await expect(manager.delete(state.id)).resolves.toBeUndefined();
    });
  });
});
