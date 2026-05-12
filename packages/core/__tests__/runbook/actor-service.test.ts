import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActor, type Snapshot } from 'xstate';
import { RunbookStateManager } from '../../src/runbook/state.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import { RunbookActorService, stateValueAsString } from '../../src/runbook/actor-service.js';
import type { AnyActorRef } from '../../src/runbook/actor-service.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import type {
  ResolvedRunbook,
  ResolvedStep,
  RunbookState,
  SubstepState,
} from '../../src/runbook/types.js';
import { makeBaseStep } from '../helpers/step-factories.js';
import { createJsonArrayStream } from '../../src/runbook/types.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookContext } from '../../src/runbook/compiler.js';
import { compileRunbookToMachine } from '../../src/runbook/compiler.js';
import { createRunbook } from './fixtures.js';

function mockActor(snapshot: { value: string; context: Record<string, unknown> }) {
  return { getPersistedSnapshot: () => snapshot } as any;
}

interface LifecycleHarness {
  actor: AnyActorRef;
  manager: RunbookStateManager;
  service: RunbookActorService;
  state: RunbookState;
  runbookId: string;
  steps: ResolvedStep[];
  testDir: string;
}

async function createLifecycleHarness(
  markdown: string,
  overrides: Parameters<RunbookStateManager['update']>[1] = {},
): Promise<LifecycleHarness> {
  const steps = createRunbook(markdown);
  const testDir = await mkdtemp(join(tmpdir(), 'lifecycle-harness-'));
  const manager = new RunbookStateManager(testDir);
  const service = new RunbookActorService(manager);

  const mockRunbookDef = {
    title: 'Lifecycle Test',
    description: 'Lifecycle test runbook',
    steps,
  };
  const created = await manager.create(
    { source: 'project', path: 'lifecycle-test.md' },
    mockRunbookDef,
    {
      runbookPath: 'lifecycle-test.md',
      frontmatterOutputs: [],
    },
  );
  if (Object.keys(overrides).length > 0) {
    await manager.update(created.id, overrides);
  }
  const state = (await manager.load(created.id))!;

  const actor = await service.createActor(state.id, steps);
  if (!actor) throw new Error('createLifecycleHarness: actor creation failed');

  return { actor, manager, service, state, runbookId: state.id, steps, testDir };
}

const ARTIFACT_RECORD = {
  kind: 'artifact-record' as const,
  uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
  runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  contextId: 'ctx1',
  runbook: { source: 'project' as const, path: 'lifecycle-test.md' },
  key: 'plan.json',
  timestamp: '2026-05-07T00:00:00.000Z',
} satisfies ArtifactRecord;

describe('RunbookActorService', () => {
  let testDir: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  const mockSteps: ResolvedStep[] = [
    makeBaseStep({
      name: '1',
      description: 'Initial step',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    }),
  ];
  const mockRunbook: ResolvedRunbook = {
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
    });
  });

  describe('updateFromActor', () => {
    it('extracts substep ID from flattened machine state (step::N::M)', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = mockActor({
        value: 'step::1::2',
        context: { variables: {}, retryCount: 0, substep: '2' },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.step).toBe('1');
      expect(updated.substep).toBe('2');
    });

    it('extracts step number from simple machine state (step::N)', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = mockActor({
        value: 'step::3',
        context: { variables: {}, retryCount: 0 },
      });

      const steps: ResolvedStep[] = [
        ...mockSteps,
        makeBaseStep({ name: '2', description: 'S2', transitions: mockSteps[0].transitions }),
        makeBaseStep({ name: '3', description: 'S3', transitions: mockSteps[0].transitions }),
      ];

      const { state: updated } = await actorService.updateFromActor(state.id, actor, steps);
      expect(updated.step).toBe('3');
      expect(updated.substep).toBeUndefined();
    });

    it('rejects legacy persisted state IDs instead of adapting them', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = mockActor({
        value: 'step_1',
        context: { variables: {}, retryCount: 0 },
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await expect(actorService.updateFromActor(state.id, actor, mockSteps)).rejects.toThrow(
          /Unsupported persisted stateValue/,
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects persisted state IDs that no longer exist in the runbook', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = mockActor({
        value: 'step::missing',
        context: { variables: {}, retryCount: 0 },
      });

      await expect(actorService.updateFromActor(state.id, actor, mockSteps)).rejects.toThrow(
        /references missing step "missing"/,
      );
    });

    it('persists and rehydrates a compound-leaf snapshot through a sendAndSync round-trip', async () => {
      // Create a runbook with OUTPUTS + RETRY transitions
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL RETRY 2 STOP
- OUTPUTS
  - Foo
\`\`\`bash
exit 1
\`\`\`
`);
      const runbook = {
        title: 'Retry round-trip test',
        description: 'Regression coverage for compound-leaf snapshot round-trip',
        steps,
      };
      const state = await manager.create({ source: 'project', path: 'test.md' }, runbook, {
        runbookPath: 'test.md',
      });
      const channelPath = join(testDir, 'Foo');
      await writeFile(channelPath, 'persisted-value\n', 'utf-8');

      // Drive the actor through a FAIL-RETRY cycle
      const result = await actorService.sendAndSync(state.id, steps, {
        type: 'COMMAND_RESULT',
        result: 'fail',
        channels: [{ name: 'Foo', path: channelPath }],
      });

      // Should not throw and should complete the FAIL-RETRY transition
      expect(result).not.toBeNull();
      expect(result?.state.step).toBe('1');
      expect(result?.state.retryCount).toBeGreaterThan(0);

      // Now test the round-trip: persist this snapshot and rehydrate it
      const persistedSnapshot = result!.state.snapshot;
      expect(persistedSnapshot).toBeDefined();

      // Create a new actor from the persisted snapshot
      const machine = compileRunbookToMachine(steps);
      const rehydratedActor = createActor(machine, {
        snapshot: persistedSnapshot as Snapshot<unknown>,
      });
      rehydratedActor.start();

      // Get the rehydrated snapshot and verify round-trip equality
      const rehydratedSnapshot = rehydratedActor.getPersistedSnapshot();
      expect(rehydratedSnapshot).toEqual(persistedSnapshot);

      // Verify the snapshot has the compound-leaf shape we expect
      const snapValue = (rehydratedSnapshot as unknown as Record<string, unknown>).value as Record<
        string,
        unknown
      >;
      expect(snapValue).toEqual({ 'step::1': 'idle' });

      // Verify step extraction works correctly on the rehydrated actor
      const { state: updated } = await actorService.updateFromActor(
        state.id,
        rehydratedActor as AnyActorRef,
        steps,
      );
      expect(updated.step).toBe('1');
      expect(updated.retryCount).toBeGreaterThan(0);
    });
  });

  describe('initializeState', () => {
    it('returns null for nonexistent runbook', async () => {
      const result = await actorService.initializeState('nonexistent', mockSteps);
      expect(result).toBeNull();
    });

    it('creates actor and syncs state without sending event', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const result = await actorService.initializeState(state.id, mockSteps);
      expect(result).not.toBeNull();
      expect(result?.step).toBe('1');
    });

    it('bootstraps first substep launch state through core initialization', async () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);
      const runbook = {
        title: 'Substep launch',
        description: 'Launch initialization belongs to core',
        steps,
      };
      const state = await manager.create({ source: 'project', path: 'substeps.md' }, runbook, {
        runbookPath: 'substeps.md',
        frontmatterOutputs: [],
      });

      const initialized = await actorService.initializeState(state.id, steps);

      expect(initialized).not.toBeNull();
      expect(initialized?.step).toBe('1');
      expect(initialized?.substep).toBe('1');
      expect(initialized?.lastAction).toEqual({ type: 'START' });
      expect(initialized?.activeFrameKey).toBe(buildFrameKey('1'));
      expect(initialized?.activeEntry).toBe(1);
      expect(initialized?.frameEntries).toEqual({ [buildFrameKey('1')]: 1 });
      expect(initialized?.substepStates).toEqual([
        { id: '1', frameKey: buildFrameKey('1'), status: 'pending' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
      ]);
    });

    it('bootstraps first FOR substep state in the active iteration frame', async () => {
      const steps = createRunbook(`## 1. Loop
- FOR i IN 1 TO 2
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);
      const runbook = {
        title: 'FOR launch',
        description: 'FOR launch frame bootstrap belongs to core',
        steps,
      };
      const state = await manager.create({ source: 'project', path: 'for.md' }, runbook, {
        runbookPath: 'for.md',
        frontmatterOutputs: [],
      });

      const initialized = await actorService.initializeState(state.id, steps);
      const frameKey = buildFrameKey('1', 1);

      expect(initialized).not.toBeNull();
      expect(initialized?.step).toBe('1');
      expect(initialized?.substep).toBe('1');
      expect(initialized?.lastAction).toEqual({ type: 'START' });
      expect(initialized?.forStack?.[0]).toEqual(
        expect.objectContaining({ stepId: '1', iteration: 1, variable: 'i', start: 1, end: 2 }),
      );
      expect(initialized?.activeFrameKey).toBe(frameKey);
      expect(initialized?.activeEntry).toBe(1);
      expect(initialized?.frameEntries).toEqual({ [frameKey]: 1 });
      expect(initialized?.substepStates).toEqual([
        { id: '1', frameKey, status: 'pending' },
        { id: '2', frameKey, status: 'pending' },
      ]);
    });

    it('does not reload state when active substeps are already initialized', async () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP
`);
      const frameKey = buildFrameKey('1');
      const state = await manager.create(
        { source: 'project', path: 'substeps-initialized.md' },
        { title: 'Substep reload', description: 'Fast path coverage', steps },
        { runbookPath: 'substeps-initialized.md', frontmatterOutputs: [] },
      );
      const initializedState = await manager.update(state.id, {
        substep: '1',
        activeFrameKey: frameKey,
        substepStates: [
          { id: '1', frameKey, status: 'pending' },
          { id: '2', frameKey, status: 'pending' },
        ],
      });
      const load = jest.spyOn(manager, 'load');

      await (
        actorService as unknown as {
          initializeActiveSubsteps: (
            id: string,
            state: RunbookState,
            steps: ResolvedStep[],
          ) => Promise<RunbookState>;
        }
      ).initializeActiveSubsteps(state.id, initializedState, steps);

      expect(load).not.toHaveBeenCalled();
    });

    it('hydrateSnapshot overlays RunbookState.substep onto actor context after first-substep bootstrap', async () => {
      const steps = createRunbook(`## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`);
      const runbook = { title: 'Hydrate substep', description: '', steps };
      const state = await manager.create({ source: 'project', path: 'test.md' }, runbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });

      // initializeState calls initializeActiveSubsteps which writes RunbookState.substep = '1'
      // via a direct manager.update — the snapshot is NOT updated at that point.
      const initialized = await actorService.initializeState(state.id, steps);
      expect(initialized?.substep).toBe('1');

      // On the next createActor call, hydrateSnapshot must overlay RunbookState.substep
      // onto context.substep so CLI and machine agree on the current substep position.
      const actor = await actorService.createActor(state.id, steps);
      expect(actor).not.toBeNull();
      const snap = actor!.getPersistedSnapshot() as unknown as { context: { substep?: string } };
      expect(snap.context.substep).toBe('1');
    });
  });

  describe('sendAndSync', () => {
    it('returns null for nonexistent runbook', async () => {
      const result = await actorService.sendAndSync('nonexistent', mockSteps, { type: 'PASS' });
      expect(result).toBeNull();
    });

    it('sends event, syncs state, and returns state + snapshot', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
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

  describe('sendAndSync pending machine effects', () => {
    it('waits for tagged machine-owned invokes before persisting', async () => {
      const steps = createRunbook(`## 1. capture
- PASS COMPLETE
- FAIL STOP
- OUTPUTS
  - Foo
\`\`\`bash
echo hi
\`\`\`
`);
      const runbook = {
        title: 'Invoke persistence',
        description: 'Regression coverage for async invoke persistence',
        steps,
      };
      const state = await manager.create({ source: 'project', path: 'test.md' }, runbook, {
        runbookPath: 'test.md',
      });
      const channelPath = join(testDir, 'Foo');
      await writeFile(channelPath, 'persisted-value\n', 'utf-8');

      const result = await actorService.sendAndSync(state.id, steps, {
        type: 'COMMAND_RESULT',
        result: 'pass',
        channels: [{ name: 'Foo', path: channelPath }],
      });

      expect(result).not.toBeNull();
      expect(result?.state.lifecycle).toBe('completed');
      expect(result?.state.variables).toEqual({ Foo: 'persisted-value' });
      const persisted = await manager.load(state.id);
      expect(persisted?.lifecycle).toBe('completed');
      expect(persisted?.variables).toEqual({ Foo: 'persisted-value' });
      expect(JSON.stringify(persisted?.snapshot)).not.toContain('__capture');
    });

    it('persists stopped lifecycle when machine-owned effects fail after an event send', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const effectsError = new Error('machine effect timed out');
      (
        actorService as unknown as {
          waitForMachineEffects: () => Promise<void>;
        }
      ).waitForMachineEffects = async () => {
        throw effectsError;
      };

      await expect(actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' })).rejects.toThrow(
        effectsError,
      );

      await expect(manager.load(state.id)).resolves.toMatchObject({ lifecycle: 'stopped' });
    });

    it('does not persist stopped lifecycle when post-effect actor sync rejects stale state', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const syncError = new Error('Persisted stateValue "step::missing" references missing step');
      const updateFromActor = jest
        .spyOn(actorService, 'updateFromActor')
        .mockRejectedValue(syncError);

      await expect(actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' })).rejects.toThrow(
        syncError,
      );

      expect(updateFromActor).toHaveBeenCalled();
      await expect(manager.load(state.id)).resolves.toMatchObject({ lifecycle: 'running' });
    });
  });

  describe('FOR loop context via actor', () => {
    it('syncs FOR context fields from actor snapshot', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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
          variables: {},
          lifecycle: 'completed',
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

    it('mirrors terminal internal-failure lastAction onto persisted runbook state', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const actor = mockActor({
        value: 'STOPPED',
        context: {
          variables: {},
          lifecycle: 'stopped',
          retryCount: 0,
          lastAction: {
            type: 'OUTPUT_CAPTURE_FAILED' as const,
            message: 'disk full',
          },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);

      expect(updated.lastAction).toEqual({
        type: 'OUTPUT_CAPTURE_FAILED',
        message: 'disk full',
      });
      await expect(manager.load(state.id)).resolves.toMatchObject({
        lastAction: {
          type: 'OUTPUT_CAPTURE_FAILED',
          message: 'disk full',
        },
      });
    });
  });

  describe('implicit ForContext filtering', () => {
    it('implicit ForContext entries are not persisted', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
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

      const steps: ResolvedStep[] = [
        ...mockSteps,
        makeBaseStep({
          name: '2',
          description: 'After loop',
          transitions: mockSteps[0].transitions,
        }),
      ];

      const { state: updated } = await actorService.updateFromActor(state.id, actor, steps);
      expect(updated.forStack).toBeUndefined(); // empty stack not persisted
      expect(updated.iterationResults).toEqual(['pass', 'fail', 'pass']); // preserved
    });
  });

  describe('forStack persistence via actor', () => {
    it('persists forStack with variable source through actor update and reload', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: templateVars,
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [{ name: 'SomeVar' }],
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
      const snapshot = actor!.getPersistedSnapshot() as unknown as {
        context: { frontmatterOutputs: unknown };
      };
      expect(snapshot.context.frontmatterOutputs).toEqual([{ name: 'SomeVar' }]);
      actor!.stop();
    });

    it('defaults context.frontmatterOutputs to [] when no outputs declared at run time', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      const snapshot = actor!.getPersistedSnapshot() as unknown as {
        context: { frontmatterOutputs: unknown };
      };
      expect(snapshot.context.frontmatterOutputs).toEqual([]);
      actor!.stop();
    });

    it('throws for stale run state missing frontmatterOutputs field', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
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

    it('validates stale run state without creating an actor', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      delete raw.frontmatterOutputs;
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.assertFreshState(state.id, mockSteps)).rejects.toThrow(
        /Stale runbook state.*missing frontmatter outputs/,
      );
    });

    it('throws for an unrecognized snapshot.value shape', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      raw.snapshot = { value: { weird: true } };
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.assertFreshState(state.id, mockSteps)).rejects.toThrow(
        /Unsupported snapshot\.value shape/,
      );
    });

    it('rejects persisted pending-effect __capture snapshots as stale state', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      raw.snapshot = { value: { 'step::1': '__capture' } };
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.assertFreshState(state.id, mockSteps)).rejects.toThrow(
        /Unsupported snapshot\.value shape/,
      );
      await expect(actorService.createActor(state.id, mockSteps)).rejects.toThrow(
        /Unsupported snapshot\.value shape/,
      );
    });

    it('throws for a malformed legacy state ID in snapshot.value', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      raw.snapshot = { value: 'some-old-format' };
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.assertFreshState(state.id, mockSteps)).rejects.toThrow(
        /Unsupported persisted stateValue/,
      );
    });

    it('throws when snapshot references a step no longer in the runbook', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
      });
      const filePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      raw.snapshot = { value: 'step::nonexistent-step' };
      await writeFile(filePath, JSON.stringify(raw));

      await expect(actorService.assertFreshState(state.id, mockSteps)).rejects.toThrow(
        /references missing step "nonexistent-step"/,
      );
    });

    it('seeds compiler context.templateVars from RunbookState.templateVars (flattened)', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: { SomeVar: 'hello', Items: ['a', 'b'] },
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      const snapshot = actor!.getPersistedSnapshot() as unknown as {
        context: { templateVars: Record<string, unknown> };
      };
      expect(snapshot.context.templateVars).toMatchObject({
        SomeVar: 'hello',
        Items: ['a', 'b'], // flattenTemplateVars: array passes through as array
      });
      actor!.stop();
    });

    it('strips JsonArrayStream from templateVars before seeding the machine context', async () => {
      // Regression guard: snapshot.context.templateVars must never carry a
      // JsonArrayStream. The `snapshot: z.unknown()` field in RunbookStateSchema
      // is not structurally validated against streams — safety depends on
      // flattenTemplateVars being called at this exact site. See the invariant
      // on RunbookActorService.createActor.
      // Path must be canonical and under testDir to satisfy
      // `makeJsonArrayStreamSchema`'s canonical-path + project-root checks at
      // state load time; the stream itself is never read.
      const canonicalTestDir = await realpath(testDir);
      const stream = createJsonArrayStream(join(canonicalTestDir, 'data.jsonl'));
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: {
          Region: 'us-east-1',
          Items: stream,
        },
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
      const snapshot = actor!.getPersistedSnapshot() as unknown as {
        context: { templateVars: Record<string, unknown> };
      };

      // Scalar seeded through; stream must have been stripped.
      expect(snapshot.context.templateVars.Region).toBe('us-east-1');
      expect('Items' in snapshot.context.templateVars).toBe(false);
      actor!.stop();
    });
  });

  describe('lifecycle surfacing from actor snapshot', () => {
    it('preserves artifact-shaped variables across actor sync', async () => {
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      try {
        await harness.manager.update(harness.state.id, {
          variables: merge({ PlanPath: ARTIFACT_RECORD, Reviews: [ARTIFACT_RECORD] }),
        });

        const actor = mockActor({
          value: 'step::1',
          context: {
            variables: { PlanPath: ARTIFACT_RECORD, Reviews: [ARTIFACT_RECORD] },
            retryCount: 0,
          },
        });

        const { state } = await harness.service.updateFromActor(
          harness.state.id,
          actor,
          harness.steps,
        );

        expect(state.variables).toEqual({
          PlanPath: ARTIFACT_RECORD,
          Reviews: [ARTIFACT_RECORD],
        });

        const reloaded = await harness.manager.load(harness.state.id);
        expect(reloaded?.variables).toEqual({
          PlanPath: ARTIFACT_RECORD,
          Reviews: [ARTIFACT_RECORD],
        });
      } finally {
        harness.actor.stop();
        await rm(harness.testDir, { recursive: true, force: true });
      }
    });

    it('overrides artifact-shaped variables on key collision via actor sync', async () => {
      // Phase 1 banks on `merge` being shallow / last-write-wins. A previously
      // persisted ArtifactRecord under key `PlanPath` must be replaced when
      // the actor snapshot emits a different ArtifactRecord under the same
      // key — both in the in-memory return value and in the reloaded state.
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      try {
        const oldArtifact = ARTIFACT_RECORD;
        const newArtifact = {
          kind: 'artifact-record' as const,
          uri: 'rd://artifacts/ctx1/rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/plan-v2.json',
          runId: 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          contextId: 'ctx1',
          runbook: { source: 'project' as const, path: 'lifecycle-test.md' },
          key: 'plan-v2.json',
          timestamp: '2026-05-08T00:00:00.000Z',
        } satisfies ArtifactRecord;

        await harness.manager.update(harness.state.id, {
          variables: merge({ PlanPath: oldArtifact }),
        });

        const actor = mockActor({
          value: 'step::1',
          context: {
            variables: { PlanPath: newArtifact },
            retryCount: 0,
          },
        });

        const { state } = await harness.service.updateFromActor(
          harness.state.id,
          actor,
          harness.steps,
        );

        expect(state.variables.PlanPath).toEqual(newArtifact);
        expect(state.variables.PlanPath).not.toEqual(oldArtifact);

        const reloaded = await harness.manager.load(harness.state.id);
        expect(reloaded?.variables.PlanPath).toEqual(newArtifact);
        expect(reloaded?.variables.PlanPath).not.toEqual(oldArtifact);
      } finally {
        harness.actor.stop();
        await rm(harness.testDir, { recursive: true, force: true });
      }
    });

    it('persists lifecycle = "completed" when machine reaches COMPLETE', async () => {
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      try {
        harness.actor.send({ type: 'PASS' });
        const { state } = await harness.service.updateFromActor(
          harness.runbookId,
          harness.actor,
          harness.steps,
        );
        expect(state.lifecycle).toBe('completed');
      } finally {
        harness.actor.stop();
        await rm(harness.testDir, { recursive: true, force: true });
      }
    });

    it('persists lifecycle = "stopped" when machine reaches STOPPED', async () => {
      const harness = await createLifecycleHarness('## 1. Only\n- PASS COMPLETE\n- FAIL STOP\n');
      try {
        harness.actor.send({ type: 'FAIL' });
        const { state } = await harness.service.updateFromActor(
          harness.runbookId,
          harness.actor,
          harness.steps,
        );
        expect(state.lifecycle).toBe('stopped');
      } finally {
        harness.actor.stop();
        await rm(harness.testDir, { recursive: true, force: true });
      }
    });

    it('persists lifecycle = "running" for non-terminal snapshots', async () => {
      const harness = await createLifecycleHarness(
        '## 1. First\n- PASS CONTINUE\n- FAIL STOP\n\n## 2. Last\n- PASS COMPLETE\n- FAIL STOP\n',
      );
      try {
        harness.actor.send({ type: 'PASS' });
        const { state } = await harness.service.updateFromActor(
          harness.runbookId,
          harness.actor,
          harness.steps,
        );
        expect(state.lifecycle).toBe('running');
      } finally {
        harness.actor.stop();
        await rm(harness.testDir, { recursive: true, force: true });
      }
    });
  });

  describe('RunbookActorService — finalVars persistence', () => {
    // Verifies that updateFromActor reads snapshot.context.finalVars and writes
    // it to RunbookState.finalVars on terminal sync. The earlier implementation
    // wrote `variables` but never propagated `finalVars` out of the machine.

    it('persists context.finalVars to RunbookState.finalVars on STOPPED snapshot', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [{ name: 'Result' }],
        templateVars: { Result: 'passed-value' },
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' });
      expect((result!.snapshot as { value: string }).value).toBe('COMPLETE');
      expect(result!.state.finalVars).toEqual({ Result: 'passed-value' });
    });

    it('leaves RunbookState.finalVars undefined when no frontmatter outputs are declared', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [],
        // No frontmatterOutputs declared → context.finalVars stays {}
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'FAIL' });
      expect(result!.state.finalVars).toBeUndefined();
    });

    it('leaves RunbookState.finalVars undefined when context.finalVars is empty on COMPLETE', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        frontmatterOutputs: [], // No frontmatterOutputs declared → context.finalVars stays {}
      });

      const result = await actorService.sendAndSync(state.id, mockSteps, { type: 'PASS' });
      expect(result!.state.finalVars).toBeUndefined();
    });
  });

  describe('getContextSnapshot', () => {
    it('returns null for nonexistent runbook', async () => {
      const result = await actorService.getContextSnapshot('nonexistent', mockSteps);
      expect(result).toBeNull();
    });

    it('does not call actor.start (read-only path)', async () => {
      // Invariant: the read path must not start the actor. Starting it re-fires
      // the initial state's entry actions on every call — an observable side
      // effect callers of this method are not signing up for. We assert the
      // invariant directly by spying on XState's Actor.prototype.start.
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const xstate = await import('xstate');
      const startSpy = jest.spyOn(
        xstate.Actor.prototype as unknown as { start: () => void },
        'start',
      );
      try {
        const first = await actorService.getContextSnapshot(state.id, mockSteps);
        const second = await actorService.getContextSnapshot(state.id, mockSteps);
        expect(first).not.toBeNull();
        expect(second).toEqual(first);
        expect(startSpy).not.toHaveBeenCalled();
      } finally {
        startSpy.mockRestore();
      }
    });
  });

  describe('substepStates / activeFrameKey mirroring (Task 4)', () => {
    it('initial RunbookContext mirrors substepStates and activeFrameKey from RunbookState', async () => {
      const frameKey = buildFrameKey('1');
      const substepStates: SubstepState[] = [{ id: '1', frameKey, status: 'done', result: 'pass' }];

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, {
        substepStates,
        activeFrameKey: frameKey,
      });

      const actor = await actorService.createActor(state.id, mockSteps);
      expect(actor).not.toBeNull();
      try {
        const snapshot = actor!.getPersistedSnapshot() as unknown as {
          context: RunbookContext;
        };
        expect(snapshot.context.substepStates).toEqual(substepStates);
        expect(snapshot.context.activeFrameKey).toBe(frameKey);
      } finally {
        actor!.stop();
      }
    });

    it('round-trips substepStates through updateFromActor back into RunbookState', async () => {
      const frameKey = buildFrameKey('1');
      const substepStates: SubstepState[] = [
        { id: '1', frameKey, status: 'done', result: 'pass' },
        { id: '2', frameKey, status: 'pending' },
      ];

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, {
        substepStates,
        activeFrameKey: frameKey,
      });

      // Seed a mock actor snapshot that mirrors the persisted substepStates
      // into context (simulating what createActor's bootstrap overlay produces,
      // or what the retry hook would write during a transition).
      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          substepStates,
          activeFrameKey: frameKey,
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.substepStates).toEqual(substepStates);

      const reloaded = await manager.load(state.id);
      expect(reloaded?.substepStates).toEqual(substepStates);
    });

    it('preserves persisted substepStates when context.substepStates is undefined', async () => {
      const frameKey = buildFrameKey('1');
      const substepStates: SubstepState[] = [{ id: '1', frameKey, status: 'pending' }];

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { substepStates });

      // Snapshot without substepStates in context (e.g. a legacy snapshot path
      // or pre-Task-4 serialized state). The sync must not wipe the persisted
      // substepStates when the context field is undefined.
      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.substepStates).toEqual(substepStates);
    });

    it('round-trips activeFrameKey through updateFromActor back into RunbookState', async () => {
      // Finding 10 regression: updateFromActor previously mirrored substepStates
      // but not activeFrameKey. After a retry or FOR-frame transition the
      // top-level persisted activeFrameKey would retain a stale value, mis-
      // targeting the next CLI interaction's substep scope.
      const staleFrameKey = buildFrameKey('1', 1);
      const newFrameKey = buildFrameKey('1', 2);

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { activeFrameKey: staleFrameKey });

      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          activeFrameKey: newFrameKey,
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.activeFrameKey).toBe(newFrameKey);

      const reloaded = await manager.load(state.id);
      expect(reloaded?.activeFrameKey).toBe(newFrameKey);
    });

    it('preserves persisted activeFrameKey when context.activeFrameKey key is absent', async () => {
      // Symmetry with the substepStates-undefined preservation test: an
      // absent `activeFrameKey` key in snapshot.context must not wipe the
      // authoritative persisted value. (An explicit `undefined` value IS
      // still mirrored — that signals the machine has left an active frame.)
      const frameKey = buildFrameKey('1');

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { activeFrameKey: frameKey });

      const actor = mockActor({
        value: 'step::1',
        context: {
          variables: {},
          retryCount: 0,
          lastAction: { type: 'CONTINUE' },
        },
      });

      const { state: updated } = await actorService.updateFromActor(state.id, actor, mockSteps);
      expect(updated.activeFrameKey).toBe(frameKey);
    });
  });
});

describe('stateValueAsString', () => {
  it('returns a plain string unchanged', () => {
    expect(stateValueAsString('COMPLETE')).toBe('COMPLETE');
    expect(stateValueAsString('step::1')).toBe('step::1');
  });

  it('returns the leaf ID for a compound-leaf idle substate', () => {
    expect(stateValueAsString({ 'step::1': 'idle' })).toBe('step::1');
  });

  it('returns null for a compound-leaf __capture substate', () => {
    expect(stateValueAsString({ 'step::1::1': '__capture' })).toBeNull();
  });

  it('returns null for an unrecognized substate name', () => {
    expect(stateValueAsString({ 'step::1': 'unknown-substate' })).toBeNull();
  });

  it('returns null for a multi-key object', () => {
    expect(stateValueAsString({ 'step::1': 'idle', 'step::2': 'idle' })).toBeNull();
  });

  it('returns null for non-string, non-object values', () => {
    expect(stateValueAsString(null)).toBeNull();
    expect(stateValueAsString(undefined)).toBeNull();
    expect(stateValueAsString(42)).toBeNull();
    expect(stateValueAsString([])).toBeNull();
  });
});
