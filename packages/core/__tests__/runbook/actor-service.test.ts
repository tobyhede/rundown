import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { RunbookActorService } from '../../src/runbook/actor-service.js';
import type { AnyActorRef } from '../../src/runbook/actor-service.js';
import type { Step, Runbook, ResolvedStep } from '../../src/runbook/types.js';
import { createRunbook } from './fixtures.js';

function mockActor(snapshot: { value: string; context: Record<string, unknown> }) {
  return { getPersistedSnapshot: () => snapshot } as any;
}

interface LifecycleHarness {
  actor: AnyActorRef;
  service: RunbookActorService;
  runbookId: string;
  steps: ResolvedStep[];
  testDir: string;
}

async function createLifecycleHarness(markdown: string): Promise<LifecycleHarness> {
  const steps = createRunbook(markdown);
  const testDir = await mkdtemp(join(tmpdir(), 'lifecycle-harness-'));
  const manager = new RunbookStateManager(testDir);
  const service = new RunbookActorService(manager);

  const mockRunbookDef = {
    title: 'Lifecycle Test',
    description: 'Lifecycle test runbook',
    steps: steps as unknown as Step[],
  };
  const state = await manager.create('lifecycle-test.md', mockRunbookDef, {
    runbookPath: 'lifecycle-test.md',
    frontmatterOutputs: [],
  });

  const actor = await service.createActor(state.id, steps);
  if (!actor) throw new Error('createLifecycleHarness: actor creation failed');

  return { actor, service, runbookId: state.id, steps, testDir };
}

describe('RunbookActorService', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  const mockSteps: Step[] = [
    {
      kind: 'base',
      name: '1',
      description: 'Initial step',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
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
        { kind: 'base', name: '2', description: 'S2', transitions: mockSteps[0].transitions },
        { kind: 'base', name: '3', description: 'S3', transitions: mockSteps[0].transitions },
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
      expect(result?.step).toBe('1');
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
      expect(result?.state).toBeDefined();
      expect(result?.state.id).toBe(state.id);
      expect(result?.snapshot).toBeDefined();

      // Snapshot should have expected XState shape
      const snap = result?.snapshot as { status: string; value: unknown };
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

      const steps: Step[] = [
        ...mockSteps,
        {
          kind: 'base',
          name: '2',
          description: 'After loop',
          transitions: mockSteps[0].transitions,
        },
      ];

      const { state: updated } = await actorService.updateFromActor(state.id, actor, steps);
      expect(updated.forStack).toBeUndefined(); // empty stack not persisted
      expect(updated.iterationResults).toEqual(['pass', 'fail', 'pass']); // preserved
    });
  });

  describe('forStack persistence via actor', () => {
    it('persists forStack with variable source through actor update and reload', async () => {
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
              source: { kind: 'variable' as const, name: 'item' },
              currentValue: 'y',
            },
          ],
          iterationResults: ['pass'],
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      // Verify forStack with variable source is set
      expect(updated.forStack).toHaveLength(1);
      expect(updated.forStack?.[0].source).toEqual({
        kind: 'variable',
        name: 'item',
      });
      expect(updated.forStack?.[0].currentValue).toBe('y');

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toHaveLength(1);
      expect(loaded?.forStack?.[0].source).toEqual({
        kind: 'variable',
        name: 'item',
      });
      expect(loaded?.forStack?.[0].currentValue).toBe('y');
    });

    it('persists forStack with variable source and snapshot through actor update and reload', async () => {
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
              source: { kind: 'variable' as const, name: 'lines' },
              currentValue: 'line1',
              snapshot: {
                line: 1,
                size: 100,
                mtimeMs: 1700000000,
              },
            },
          ],
          iterationResults: ['pass'],
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      // Verify forStack with variable source is set
      expect(updated.forStack).toHaveLength(1);
      expect(updated.forStack?.[0].source).toEqual({
        kind: 'variable',
        name: 'lines',
      });
      expect(updated.forStack?.[0].currentValue).toBe('line1');
      expect(updated.forStack?.[0].snapshot).toEqual({
        line: 1,
        size: 100,
        mtimeMs: 1700000000,
      });

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.forStack).toHaveLength(1);
      expect(loaded?.forStack?.[0].source).toEqual({
        kind: 'variable',
        name: 'lines',
      });
      expect(loaded?.forStack?.[0].currentValue).toBe('line1');
      expect(loaded?.forStack?.[0].snapshot).toEqual({
        line: 1,
        size: 100,
        mtimeMs: 1700000000,
      });
    });

    it('templateVars with arrays survive across multiple updates (unified model)', async () => {
      const templateVars = {
        items: ['a', 'b', 'c'],
        env: 'staging',
      };

      // Create with templateVars containing arrays
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        templateVars: templateVars as Record<string, any>,
      });

      expect(state.templateVars?.items).toEqual(['a', 'b', 'c']);

      // Update step
      const updated1 = await manager.update(state.id, { step: '1' });
      expect(updated1.templateVars?.items).toEqual(['a', 'b', 'c']);

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
      expect(updated2.templateVars?.items).toEqual(['a', 'b', 'c']);

      // Load from disk and verify templateVars still present
      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars?.items).toEqual(['a', 'b', 'c']);
    });
  });

  describe('RunbookActorService — frontmatterOutputs / templateVars seeding', () => {
    // Replaces _scratch_bisect.test.ts and _scratch_production_mirror.test.ts.
    // Verifies the production code path that previously called
    // compileRunbookToMachine(steps) without options — Cause #1 in the handoff.

    it('seeds compiler context.frontmatterOutputs from RunbookState.frontmatterOutputs', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [{ name: 'SomeVar' }],
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
      const snapshot = actor!.getPersistedSnapshot() as {
        context: { frontmatterOutputs: unknown };
      };
      expect(snapshot.context.frontmatterOutputs).toEqual([{ name: 'SomeVar' }]);
      actor!.stop();
    });

    it('defaults context.frontmatterOutputs to [] when no outputs declared at run time', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      const snapshot = actor!.getPersistedSnapshot() as {
        context: { frontmatterOutputs: unknown };
      };
      expect(snapshot.context.frontmatterOutputs).toEqual([]);
      actor!.stop();
    });

    it('throws for stale run state missing frontmatterOutputs field', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      // Simulate a pre-OUTPUTS-feature state file by stripping frontmatterOutputs from disk.
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      delete raw.frontmatterOutputs;
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.createActor(state.id, mockSteps)).rejects.toThrow(
        /Stale runbook state.*missing frontmatter outputs/,
      );
    });

    it('seeds compiler context.templateVars from RunbookState.templateVars (flattened)', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        templateVars: { SomeVar: 'hello', Items: ['a', 'b'] },
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      const snapshot = actor!.getPersistedSnapshot() as {
        context: { templateVars: Record<string, unknown> };
      };
      expect(snapshot.context.templateVars).toMatchObject({
        SomeVar: 'hello',
        Items: ['a', 'b'], // flattenTemplateVars: array passes through as array
      });
      actor!.stop();
    });
  });

  describe('lifecycle surfacing from actor snapshot', () => {
    it('persists lifecycle = "completed" when machine reaches COMPLETE', async () => {
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      harness.actor.send({ type: 'PASS' });
      const { state } = await harness.service.updateFromActor(
        harness.runbookId,
        harness.actor,
        harness.steps,
      );
      expect(state.lifecycle).toBe('completed');
      harness.actor.stop();
      await rm(harness.testDir, { recursive: true, force: true });
    });

    it('persists lifecycle = "stopped" when machine reaches STOPPED', async () => {
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      harness.actor.send({ type: 'FAIL' });
      const { state } = await harness.service.updateFromActor(
        harness.runbookId,
        harness.actor,
        harness.steps,
      );
      expect(state.lifecycle).toBe('stopped');
      harness.actor.stop();
      await rm(harness.testDir, { recursive: true, force: true });
    });

    it('persists lifecycle = "running" for non-terminal snapshots', async () => {
      const harness = await createLifecycleHarness(
        '## 1. First\n- PASS CONTINUE\n- FAIL STOP\n\n## 2. Last\n- PASS COMPLETE\n- FAIL STOP\n',
      );
      harness.actor.send({ type: 'PASS' });
      const { state } = await harness.service.updateFromActor(
        harness.runbookId,
        harness.actor,
        harness.steps,
      );
      expect(state.lifecycle).toBe('running');
      harness.actor.stop();
      await rm(harness.testDir, { recursive: true, force: true });
    });
  });

  describe('RunbookActorService — finalVars persistence', () => {
    // Verifies that updateFromActor reads snapshot.context.finalVars and writes
    // it to RunbookState.finalVars on terminal sync. The earlier implementation
    // wrote `variables` but never propagated `finalVars` out of the machine.

    it('persists context.finalVars to RunbookState.finalVars on STOPPED snapshot', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [{ name: 'Result' }],
        templateVars: { Result: 'failed-value' },
      });

      // Drive the actor to STOPPED via FAIL on the first step (mockSteps' default
      // transitions are PASS COMPLETE / FAIL STOP — confirm in test setup).
      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'FAIL' });
      expect(result).not.toBeNull();
      expect((result!.snapshot as { value: string }).value).toBe('STOPPED');
      expect(result!.state.finalVars).toEqual({ Result: 'failed-value' });
    });

    it('persists context.finalVars to RunbookState.finalVars on COMPLETE snapshot', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [{ name: 'Result' }],
        templateVars: { Result: 'passed-value' },
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' });
      expect((result!.snapshot as { value: string }).value).toBe('COMPLETE');
      expect(result!.state.finalVars).toEqual({ Result: 'passed-value' });
    });

    it('leaves RunbookState.finalVars undefined when no frontmatter outputs are declared', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
        // No frontmatterOutputs declared → context.finalVars stays {}
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'FAIL' });
      expect(result!.state.finalVars).toBeUndefined();
    });

    it('leaves RunbookState.finalVars undefined when context.finalVars is empty on COMPLETE', async () => {
      const state = await manager.create('test.md', mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [], // No frontmatterOutputs declared → context.finalVars stays {}
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' });
      expect(result!.state.finalVars).toBeUndefined();
    });
  });
});
