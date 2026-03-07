import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Runbook, Step } from '../../src/runbook/types.js';

const mockSteps: Step[] = [
  { kind: 'base', name: '1', description: 'Step 1' },
  { kind: 'base', name: '2', description: 'Step 2' },
];
const mockRunbook: Runbook = {
  title: 'Test',
  description: 'A test runbook',
  steps: mockSteps,
};

describe('ExecutionLifecycleService', () => {
  let tempDir: string;
  let manager: RunbookStateManager;
  let service: ExecutionLifecycleService;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'els-test-'));
    manager = new RunbookStateManager(tempDir);
    service = new ExecutionLifecycleService(manager);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ensureActiveEntry', () => {
    it('initializes entry to 1 on first call', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const result = await service.ensureActiveEntry(state.id);

      expect(result.entry).toBe(1);
      expect(result.frameKey).toBeDefined();
      expect(result.state).toBeDefined();
    });

    it('persists initialized entry to disk', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      await service.ensureActiveEntry(state.id);

      const loaded = await manager.load(state.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.activeEntry).toBe(1);
    });

    it('increments entry on frame switch', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      // Initialize at step 1
      const result1 = await service.ensureActiveEntry(state.id);
      expect(result1.entry).toBe(1);

      // Capture previous state before frame switch
      const prev = await manager.load(state.id);
      expect(prev).not.toBeNull();

      // Move to step 2 (frame switch)
      const next = await manager.update(state.id, {
        step: '2',
        stepName: 'Step 2',
      });

      const result2 = await service.ensureActiveEntry(state.id, prev!, next);
      expect(result2.entry).toBe(2);
    });

    it('increments entry on GOTO re-entry to same frame', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      // Initialize
      await service.ensureActiveEntry(state.id);
      const prev = await manager.load(state.id);
      expect(prev).not.toBeNull();

      // Simulate GOTO re-entry: same step, lastAction is GOTO
      const next = await manager.update(state.id, {
        lastAction: { type: 'GOTO', target: '1' },
      });

      const result = await service.ensureActiveEntry(state.id, prev!, next);
      expect(result.entry).toBe(2);
    });

    it('increments entry on RETRY re-entry to same frame', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      // Initialize
      await service.ensureActiveEntry(state.id);
      const prev = await manager.load(state.id);
      expect(prev).not.toBeNull();

      // Simulate RETRY re-entry
      const next = await manager.update(state.id, {
        lastAction: { type: 'RETRY' },
      });

      const result = await service.ensureActiveEntry(state.id, prev!, next);
      expect(result.entry).toBe(2);
    });

    it('returns without persisting when unchanged', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      // Initialize
      await service.ensureActiveEntry(state.id);
      const loaded = await manager.load(state.id);
      expect(loaded).not.toBeNull();

      // Call again with same state (no transition)
      const result = await service.ensureActiveEntry(state.id, loaded!, loaded!);
      expect(result.entry).toBe(loaded!.activeEntry);

      // Entry should not have changed on disk
      const loaded2 = await manager.load(state.id);
      expect(loaded2!.activeEntry).toBe(loaded!.activeEntry);
    });

    it('uses provided nextState instead of loading from disk', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const result1 = await service.ensureActiveEntry(state.id);
      const prev = await manager.load(state.id);
      expect(prev).not.toBeNull();

      // Update to step 2 and pass nextState explicitly
      const next = await manager.update(state.id, {
        step: '2',
        stepName: 'Step 2',
      });

      const result2 = await service.ensureActiveEntry(state.id, prev!, next);
      expect(result2.entry).toBeGreaterThan(result1.entry);
    });
  });

  describe('upsertResolvedCompletion', () => {
    it('stores a new completion', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      await service.upsertResolvedCompletion(state.id, '1||1|', completion);

      const retrieved = await service.getResolvedCompletion(state.id, '1||1|');
      expect(retrieved).toEqual(completion);
    });

    it('overwrites existing completion', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion1 = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      const completion2 = {
        agentId: 'agent-2',
        result: 'fail' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      const key = '1||1|';
      await service.upsertResolvedCompletion(state.id, key, completion1);
      await service.upsertResolvedCompletion(state.id, key, completion2);

      const retrieved = await service.getResolvedCompletion(state.id, key);
      expect(retrieved).toEqual(completion2);
    });

    it('persists completion to disk', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      await service.upsertResolvedCompletion(state.id, '1||1|', completion);

      // Verify via fresh service instance
      const newService = new ExecutionLifecycleService(manager);
      const retrieved = await newService.getResolvedCompletion(state.id, '1||1|');
      expect(retrieved).toEqual(completion);
    });
  });

  describe('getResolvedCompletion', () => {
    it('returns null for missing key', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const retrieved = await service.getResolvedCompletion(state.id, 'nonexistent');
      expect(retrieved).toBeNull();
    });

    it('returns null for missing runbook', async () => {
      const retrieved = await service.getResolvedCompletion('nonexistent-id', 'key');
      expect(retrieved).toBeNull();
    });
  });

  describe('consumeResolvedCompletion', () => {
    it('returns and removes completion', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      const key = '1||1|';
      await service.upsertResolvedCompletion(state.id, key, completion);

      const consumed = await service.consumeResolvedCompletion(state.id, key);
      expect(consumed).toEqual(completion);

      // Verify it's been removed
      const retrieved = await service.getResolvedCompletion(state.id, key);
      expect(retrieved).toBeNull();
    });

    it('returns null for missing key', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const consumed = await service.consumeResolvedCompletion(state.id, 'nonexistent');
      expect(consumed).toBeNull();
    });

    it('returns null for missing runbook', async () => {
      const consumed = await service.consumeResolvedCompletion('nonexistent-id', 'key');
      expect(consumed).toBeNull();
    });

    it('persists removal to disk', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      const key = '1||1|';
      await service.upsertResolvedCompletion(state.id, key, completion);
      await service.consumeResolvedCompletion(state.id, key);

      // Verify via fresh service instance
      const newService = new ExecutionLifecycleService(manager);
      const retrieved = await newService.getResolvedCompletion(state.id, key);
      expect(retrieved).toBeNull();
    });
  });

  describe('listResolvedCompletions', () => {
    it('returns completions matching frameKey and entry', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const frameKey = buildFrameKey('1');
      const entry = 1;

      const completion1 = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: frameKey,
        targetEntry: entry,
        completedAt: new Date().toISOString(),
      };

      const completion2 = {
        agentId: 'agent-2',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: frameKey,
        targetEntry: entry,
        completedAt: new Date().toISOString(),
      };

      // Keys use format: frameKey|entry|substep
      const key1 = `${frameKey}|${String(entry)}|sub1`;
      const key2 = `${frameKey}|${String(entry)}|sub2`;
      await service.upsertResolvedCompletion(state.id, key1, completion1);
      await service.upsertResolvedCompletion(state.id, key2, completion2);

      const listed = await service.listResolvedCompletions(state.id, frameKey, entry);
      expect(listed).toHaveLength(2);
      expect(listed.map((l) => l.completion.agentId).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('filters out non-matching entries', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const completion1 = {
        agentId: 'agent-1',
        result: 'pass' as const,
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        completedAt: new Date().toISOString(),
      };

      const completion2 = {
        agentId: 'agent-2',
        result: 'pass' as const,
        targetStep: '2',
        targetFrameKey: buildFrameKey('2'),
        targetEntry: 2,
        completedAt: new Date().toISOString(),
      };

      await service.upsertResolvedCompletion(state.id, '1||1|sub1', completion1);
      await service.upsertResolvedCompletion(state.id, '2||2|sub1', completion2);

      const listed = await service.listResolvedCompletions(state.id, buildFrameKey('1'), 1);
      expect(listed).toHaveLength(1);
      expect(listed[0].completion.agentId).toBe('agent-1');
    });

    it('returns empty array when no matches', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const listed = await service.listResolvedCompletions(
        state.id,
        buildFrameKey('nonexistent'),
        1,
      );
      expect(listed).toEqual([]);
    });

    it('returns empty array for missing runbook', async () => {
      const listed = await service.listResolvedCompletions('nonexistent-id', buildFrameKey('1'), 1);
      expect(listed).toEqual([]);
    });
  });

  describe('buildActiveCompletionKey', () => {
    it('builds key without substep', () => {
      // Use the created state directly (it has step='1')
      const key = service.buildActiveCompletionKey({
        step: '1',
        activeEntry: 1,
      } as Parameters<typeof service.buildActiveCompletionKey>[0]);

      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('includes substep in key when provided', () => {
      const state = {
        step: '1',
        activeEntry: 1,
      } as Parameters<typeof service.buildActiveCompletionKey>[0];

      const key1 = service.buildActiveCompletionKey(state);
      const key2 = service.buildActiveCompletionKey(state, 'sub1');

      expect(key1).not.toBe(key2);
      expect(key2).toContain('sub1');
    });

    it('builds different keys for different steps', () => {
      const state1 = {
        step: '1',
        activeEntry: 1,
      } as Parameters<typeof service.buildActiveCompletionKey>[0];
      const state2 = {
        step: '2',
        activeEntry: 1,
      } as Parameters<typeof service.buildActiveCompletionKey>[0];

      const key1 = service.buildActiveCompletionKey(state1);
      const key2 = service.buildActiveCompletionKey(state2);

      expect(key1).not.toBe(key2);
    });
  });

  describe('buildTargetFrameKey', () => {
    it('builds key without iteration', () => {
      const key = service.buildTargetFrameKey('1');
      expect(key).toBe('1|');
    });

    it('builds different keys for different steps', () => {
      const key1 = service.buildTargetFrameKey('1');
      const key2 = service.buildTargetFrameKey('2');
      expect(key1).not.toBe(key2);
    });

    it('includes iteration when provided', () => {
      const key = service.buildTargetFrameKey('1', 3);
      expect(key).toBe('1|3');
    });

    it('builds different keys for different iterations', () => {
      const key1 = service.buildTargetFrameKey('1', 1);
      const key2 = service.buildTargetFrameKey('1', 2);
      expect(key1).not.toBe(key2);
    });
  });

  describe('parseCompletionKey', () => {
    it('parses valid key with substep', () => {
      const parsed = service.parseCompletionKey('1|2|3|sub1');
      expect(parsed).not.toBeNull();
      expect(parsed!.frameKey).toBe('1|2');
      expect(parsed!.entry).toBe(3);
      expect(parsed!.substep).toBe('sub1');
    });

    it('parses valid key without substep', () => {
      const parsed = service.parseCompletionKey('1||1|');
      expect(parsed).not.toBeNull();
      expect(parsed!.frameKey).toBe('1|');
      expect(parsed!.entry).toBe(1);
      expect(parsed!.substep).toBeUndefined();
    });

    it('returns null for invalid format', () => {
      expect(service.parseCompletionKey('invalid')).toBeNull();
    });

    it('returns null for too few segments', () => {
      expect(service.parseCompletionKey('1|2')).toBeNull();
    });

    it('returns null for non-numeric entry', () => {
      expect(service.parseCompletionKey('1||abc|')).toBeNull();
    });
  });
});
