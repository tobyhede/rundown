import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import { type Step, type Runbook } from '../../src/runbook/types.js';

function mockActor(snapshot: { value: string; context: Record<string, unknown> }) {
  return { getPersistedSnapshot: () => snapshot } as any;
}

describe('RunbookActorService', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
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
    testDir = await mkdtemp(join(tmpdir(), 'actor-svc-test-'));
    manager = new RunbookStateManager(testDir);
    actorService = new RunbookActorService(manager);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createActor', () => {
    it('returns null for nonexistent runbook', async () => {
      const actor = await actorService.createActor('nonexistent', mockSteps);
      expect(actor).toBeNull();
    });

    it('creates and starts actor from persisted state', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
    });
  });

  describe('updateFromActor', () => {
    it('extracts substep ID from flattened machine state (step::N::M)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::1::2',
        context: { variables: {}, retryCount: 0, substep: '2' },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.step).toBe('1');
      expect(updated.substep).toBe('2');
    });

    it('extracts step number from simple machine state (step::N)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::3',
        context: { variables: {}, retryCount: 0 },
      });

      const steps: Step[] = [
        ...mockSteps,
        { name: '2', description: 'S2' },
        { name: '3', description: 'S3' },
      ];

      const { state: updated } = await actorService.updateFromActor(state.id, actor, steps);
      expect(updated.step).toBe('3');
      expect(updated.substep).toBeUndefined();
    });
  });

  describe('initializeState', () => {
    it('returns null for nonexistent runbook', async () => {
      const result = await actorService.initializeState('nonexistent', mockSteps);
      expect(result).toBeNull();
    });

    it('creates actor and syncs state without sending event', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const result = await actorService.initializeState(state.id, mockSteps);
      expect(result).not.toBeNull();
      expect(result!.step).toBe('1');
    });
  });

  describe('sendAndSync', () => {
    it('returns null for nonexistent runbook', async () => {
      const result = await actorService.sendAndSync('nonexistent', mockSteps, { type: 'PASS' });
      expect(result).toBeNull();
    });

    it('sends event, syncs state, and returns state + snapshot', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' });

      expect(result).not.toBeNull();
      expect(result!.state).toBeDefined();
      expect(result!.state.id).toBe(state.id);
      expect(result!.snapshot).toBeDefined();

      // Snapshot should have expected XState shape
      const snap = result!.snapshot as { status: string; value: unknown };
      expect(typeof snap.status).toBe('string');
      expect(snap).toHaveProperty('value');
    });
  });

  describe('FOR loop context via actor', () => {
    it('syncs FOR context fields from actor snapshot', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: { test: 'value' },
          retryCount: 0,
          forStack: [
            {
              stepId: '1',
              iteration: 1,
              start: 1,
              end: 3,
              variable: 'item',
              source: { kind: 'range' as const },
            },
          ],
          iterationResults: ['pass'],
          lastAction: { type: 'START' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      expect(updated.forStack).toEqual([
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 3,
          variable: 'item',
          source: { kind: 'range' as const },
        },
      ]);
      expect(updated.iterationResults).toEqual(['pass']);
      expect(updated.lastAction).toEqual({ type: 'START' });
    });

    it('clears FOR fields when runbook completes', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      // First, set forStack
      await manager.update(state.id, {
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

      // Now simulate completion via updateFromActor
      const completeActor = mockActor({
        value: 'COMPLETE',
        context: {
          variables: { completed: true },
          retryCount: 0,
        },
      });

      const { state: completed } = await actorService.updateFromActor(
        state.id,
        completeActor,
        mockSteps,
      );

      // FOR fields should be cleared
      expect(completed.forStack).toBeUndefined();
      expect(completed.iterationResults).toBeUndefined();
    });

    it('migrates old snapshot context on createActor', async () => {
      // Test the createActor migration path directly
      // Start with a normal actor that has been running
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor1 = await actorService.createActor(state.id, mockSteps);
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
          forStack: undefined,
        },
      };

      // Save this old snapshot
      await manager.update(state.id, { snapshot: oldSnapshot });

      // Create a new actor - should trigger migration
      const actor2 = await actorService.createActor(state.id, mockSteps);
      expect(actor2).not.toBeNull();

      // Get the migrated snapshot
      const snapshot2 = actor2!.getPersistedSnapshot() as any;
      const context = snapshot2.context;

      // Should have forStack, not flat fields
      expect(context.forStack).toEqual([
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'item',
          implicit: false,
          source: { kind: 'range' },
        },
      ]);
      expect(context.forIteration).toBeUndefined();
      expect(context.forStart).toBeUndefined();
      expect(context.forEnd).toBeUndefined();
      expect(context.forVariable).toBeUndefined();
    });
  });

  describe('implicit ForContext filtering', () => {
    it('implicit ForContext entries are not persisted', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::1::1',
        context: {
          forStack: [
            {
              stepId: '1',
              iteration: 1,
              start: 1,
              end: 1,
              implicit: true,
              source: { kind: 'range' as const },
            },
          ],
          iterationResults: [],
          retryCount: 0,
          variables: {},
          lastAction: { type: 'START' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.forStack).toBeUndefined();
    });

    it('iterationResults not persisted for implicit loops', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::1::1',
        context: {
          forStack: [
            {
              stepId: '1',
              iteration: 1,
              start: 1,
              end: 1,
              implicit: true,
              source: { kind: 'range' as const },
            },
          ],
          iterationResults: ['pass'],
          retryCount: 0,
          variables: {},
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.iterationResults).toBeUndefined();
    });

    it('explicit ForContext entries are persisted normally', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::1::1',
        context: {
          forStack: [
            {
              stepId: '1',
              iteration: 2,
              start: 1,
              end: 3,
              variable: 'batch',
              source: { kind: 'range' as const },
            },
          ],
          iterationResults: ['pass'],
          retryCount: 0,
          variables: {},
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.forStack).toHaveLength(1);
      expect(updated.iterationResults).toEqual(['pass']);
    });

    it('iterationResults preserved after explicit FOR loop exits (empty forStack)', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });
      const actor = mockActor({
        value: 'step::2',
        context: {
          forStack: [],
          iterationResults: ['pass', 'fail', 'pass'],
          retryCount: 0,
          variables: {},
          lastAction: { type: 'CONTINUE' },
        },
      });

      const steps: Step[] = [...mockSteps, { name: '2', description: 'After loop' }];

      const { state: updated } = await actorService.updateFromActor(state.id, actor, steps);
      expect(updated.forStack).toBeUndefined(); // empty stack not persisted
      expect(updated.iterationResults).toEqual(['pass', 'fail', 'pass']); // preserved
    });
  });

  describe('sources persistence via actor', () => {
    it('persists forStack with array source through actor update and reload', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          forStack: [
            {
              stepId: '1',
              iteration: 2,
              start: 1,
              end: 3,
              variable: 'item',
              source: { kind: 'array' as const, items: ['x', 'y', 'z'] },
              currentValue: 'y',
            },
          ],
          iterationResults: ['pass'],
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      // Verify forStack with array source is set
      expect(updated.forStack).toHaveLength(1);
      expect(updated.forStack![0].source).toEqual({
        kind: 'array',
        items: ['x', 'y', 'z'],
      });
      expect(updated.forStack![0].currentValue).toBe('y');

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toHaveLength(1);
      expect(loaded?.forStack?.[0].source).toEqual({
        kind: 'array',
        items: ['x', 'y', 'z'],
      });
      expect(loaded?.forStack?.[0].currentValue).toBe('y');
    });

    it('persists forStack with file source through actor update and reload', async () => {
      const state = await manager.create('test.md', mockRunbook, { runbookPath: 'test.md' });

      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          forStack: [
            {
              stepId: '1',
              iteration: 1,
              start: 1,
              end: 2,
              variable: 'line',
              source: {
                kind: 'file' as const,
                path: '/tmp/data.txt',
                format: 'text' as const,
                snapshot: null,
              },
              currentValue: 'line1',
            },
          ],
          iterationResults: ['pass'],
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      // Verify forStack with file source is set
      expect(updated.forStack).toHaveLength(1);
      expect(updated.forStack![0].source.kind).toBe('file');
      expect(updated.forStack![0].source).toEqual({
        kind: 'file',
        path: '/tmp/data.txt',
        format: 'text',
        snapshot: null,
      });

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toHaveLength(1);
      expect(loaded?.forStack![0].source.kind).toBe('file');
      expect(loaded?.forStack![0].source).toEqual({
        kind: 'file',
        path: '/tmp/data.txt',
        format: 'text',
        snapshot: null,
      });
    });

    it('sources survive across multiple updates', async () => {
      const sources = {
        items: {
          kind: 'array' as const,
          items: ['a', 'b', 'c'],
        },
      };

      // Create with sources
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        sources,
      });

      expect(state.sources).toEqual(sources);

      // Update step
      const updated1 = await manager.update(state.id, { step: '1' });
      expect(updated1.sources).toEqual(sources);

      // updateFromActor
      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated2 } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated2.sources).toEqual(sources);

      // Load from disk and verify sources still present
      const loaded = await manager.load(state.id);
      expect(loaded?.sources).toEqual(sources);
    });
  });
});
