import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isError } from '../../src/errors.js';
import {
  generateRunId,
  LegacySnapshotError,
  RunbookStateManager,
} from '../../src/runbook/state.js';
import { RunStateLock } from '../../src/runbook/run-state-lock.js';
import type { RunStateLockFactory, RunStateLockLike } from '../../src/runbook/run-state-lock.js';
import { merge, replace } from '../../src/runbook/state-update-ops.js';
import { partitionVariables } from '../../src/runbook/variable-preparation.js';
import { runsDir, runStateLockPath, statePath as _statePath } from '../../src/paths.js';
import { SessionService } from '../../src/runbook/session-service.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import { makeAggregationLastAction } from '../../src/runbook/last-action.js';
import { buildContextSnapshot } from '../../src/runbook/delegation-context.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { Step, Runbook, RunId } from '../../src/runbook/types.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';
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

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ws-test-'));
    manager = new RunbookStateManager(testDir);
    lifecycleService = new ExecutionLifecycleService(manager);
    sessionService = new SessionService(manager);
  });

  describe('cwd canonicalization invariant', () => {
    const symlinkSupported = process.platform !== 'win32';

    (symlinkSupported ? it : it.skip)(
      'resolves cwd through symlinks so manager.cwd returns the real path',
      async () => {
        const realDir = await mkdtemp(join(tmpdir(), 'rd-canon-real-'));
        const linkParent = await mkdtemp(join(tmpdir(), 'rd-canon-link-'));
        const linkPath = join(linkParent, 'link');

        try {
          await symlink(realDir, linkPath, 'dir');

          const linkedManager = new RunbookStateManager(linkPath);

          await expect(realpath(linkPath)).resolves.toBe(linkedManager.cwd);
          await expect(realpath(realDir)).resolves.toBe(linkedManager.cwd);
        } finally {
          await rm(linkParent, { recursive: true, force: true });
          await rm(realDir, { recursive: true, force: true });
        }
      },
    );

    it('falls back to raw cwd on ENOENT without throwing', () => {
      const nonexistent = join(tmpdir(), `rd-canon-missing-${String(Date.now())}`);

      const missingManager = new RunbookStateManager(nonexistent);

      expect(missingManager.cwd).toBe(nonexistent);
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('run id identity', () => {
    it('generates canonical branded Rundown run ids', () => {
      const runId = generateRunId();
      const branded: RunId = runId;

      expect(branded).toMatch(/^rd_[a-f0-9]{32}$/);
    });

    it('brands RunbookState.id on create/load round trip', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
      );

      const loaded = await manager.load(state.id);
      const branded: RunId = loaded!.id;

      expect(branded).toBe(state.id);
      expect(branded).toMatch(/^rd_[a-f0-9]{32}$/);
    });
  });

  it('persists trusted artifact values in variables alongside string OUTPUTS', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    const updated = await manager.update(state.id, {
      variables: merge({
        PlanPath: brandTrustedArtifactRecordForTest(artifact),
        Reviews: brandTrustedArtifactArrayForTest([artifact]),
        Note: 'string-output',
      }),
    });

    expect(() =>
      partitionVariables({
        'context.parent.vars.PlanPath': updated.variables.PlanPath,
        'context.parent.vars.Reviews': updated.variables.Reviews,
      }),
    ).not.toThrow();

    const loaded = await manager.load(state.id);
    expect(loaded?.variables).toEqual({
      PlanPath: artifact,
      Reviews: [artifact],
      Note: 'string-output',
    });
  });

  it('rejects untrusted artifact-shaped variables before persistence', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await expect(
      manager.update(state.id, {
        variables: merge({ PlanPath: artifact, Reviews: [artifact] }),
      }),
    ).rejects.toThrow(/Artifact record value for "PlanPath" is not trusted/);
  });

  it('preserves trusted finalVars returned by update for inherited context partitioning', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    const updated = await manager.update(state.id, {
      finalVars: {
        PlanPath: brandTrustedArtifactRecordForTest(artifact),
        Reviews: brandTrustedArtifactArrayForTest([artifact]),
      },
    });
    const updatedFinalVars = updated.finalVars;
    if (!updatedFinalVars) {
      throw new Error('Expected update to return finalVars');
    }

    expect(() =>
      partitionVariables({
        'context.parent.vars.PlanPath': updatedFinalVars.PlanPath,
        'context.parent.vars.Reviews': updatedFinalVars.Reviews,
      }),
    ).not.toThrow();

    const loaded = await manager.load(state.id);
    const loadedFinalVars = loaded?.finalVars;
    if (!loadedFinalVars) {
      throw new Error('Expected loaded state to include finalVars');
    }
    expect(() =>
      partitionVariables({
        'context.parent.vars.PlanPath': loadedFinalVars.PlanPath,
        'context.parent.vars.Reviews': loadedFinalVars.Reviews,
      }),
    ).not.toThrow();
  });

  it('rejects untrusted artifact-shaped finalVars before persistence', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await expect(
      manager.update(state.id, {
        finalVars: { PlanPath: artifact, Reviews: [artifact] },
      }),
    ).rejects.toThrow(/Artifact record value for "PlanPath" is not trusted/);
  });

  it('rejects untrusted artifact-shaped resolved completion finalVars before persistence', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await expect(
      manager.update(state.id, {
        resolvedCompletions: merge({
          [buildFrameKey('1')]: {
            agentId: 'agent',
            result: 'pass',
            targetStep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            finalVars: { PlanPath: artifact },
            completedAt: '2026-05-07T00:00:00.000Z',
          },
        }),
      }),
    ).rejects.toThrow(/Resolved completion "1\|" carries invalid finalVars/);
  });

  it('creates run state with initial runtime variables separate from templateVars', async () => {
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'review.runbook.md' },
      mockRunbook,
      {
        runbookPath: 'review.runbook.md',
        runbookSrc: '# Review\n\n## 1. Step',
        templateVars: { Plain: 'value' },
        initialVariables: { Plan: brandTrustedArtifactRecordForTest(artifact) },
      },
    );

    expect(state.templateVars).toMatchObject({ Plain: 'value' });
    expect(state.templateVars).not.toHaveProperty('Plan');
    expect(state.variables.Plan).toMatchObject({ kind: 'artifact-record', key: 'plan.json' });
  });

  it('replaces an artifact-shaped variable when a string OUTPUTS lands on the same key', async () => {
    // Locks in last-write-wins for the artifact -> string direction. Plan §
    // "Sequencing Risks": an OUTPUTS step that emits a name matching a
    // previously-resolved ARTIFACT silently replaces the prior value.
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'plan.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await manager.update(state.id, {
      variables: merge({ PlanPath: brandTrustedArtifactRecordForTest(artifact) }),
    });
    await manager.update(state.id, { variables: merge({ PlanPath: 'string-output' }) });

    const loaded = await manager.load(state.id);
    expect(loaded?.variables.PlanPath).toBe('string-output');
  });

  it('replaces a string OUTPUTS with a trusted artifact value when keys collide', async () => {
    // Reverse direction of the prior test. Plan § "Sequencing Risks": an
    // ARTIFACT resolution that lands on a name previously used by a string
    // OUTPUTS silently replaces the prior value.
    const artifact = {
      kind: 'artifact-record' as const,
      uri: 'rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/foo.json',
      runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contextId: 'ctx1',
      runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
      key: 'foo.json',
      timestamp: '2026-05-07T00:00:00.000Z',
    } satisfies ArtifactRecord;

    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await manager.update(state.id, { variables: merge({ Foo: 'string-output' }) });
    await manager.update(state.id, {
      variables: merge({ Foo: brandTrustedArtifactRecordForTest(artifact) }),
    });

    const loaded = await manager.load(state.id);
    expect(loaded?.variables.Foo).toEqual(artifact);
  });

  it('round-trips an aggregation-origin lastAction through manager.save then manager.load', async () => {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );
    await manager.update(state.id, {
      lastAction: makeAggregationLastAction({ type: 'STOP' }),
    });
    const loaded = await manager.load(state.id);
    expect(loaded?.lastAction).toEqual({ type: 'STOP', origin: 'aggregation' });
  });

  it('preserves aggregation-origin lastAction across unrelated updates after loading from disk', async () => {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );

    await manager.update(state.id, {
      lastAction: makeAggregationLastAction({ type: 'COMPLETE' }),
    });
    await manager.update(state.id, { stepName: 'Renamed step' });

    const loaded = await manager.load(state.id);
    expect(loaded?.stepName).toBe('Renamed step');
    expect(loaded?.lastAction).toEqual({ type: 'COMPLETE', origin: 'aggregation' });
  });

  it('round-trips 100+ artifact-shaped variables entries through persistence', async () => {
    const state = await manager.create(
      { source: 'project', path: 'test.runbook.md' },
      mockRunbook,
      { runbookPath: 'test.runbook.md' },
    );
    const entries: Record<string, ArtifactRecord> = {};
    for (let i = 0; i < 120; i++) {
      const key = `plan-${String(i)}.json`;
      entries[`Var${String(i)}`] = brandTrustedArtifactRecordForTest({
        kind: 'artifact-record' as const,
        uri: `rd://artifacts/ctx1/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${key}`,
        runId: 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contextId: 'ctx1',
        runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
        key,
        timestamp: '2026-05-07T00:00:00.000Z',
      } satisfies ArtifactRecord);
    }
    await manager.update(state.id, { variables: merge(entries) });
    const loaded = await manager.load(state.id);
    expect(Object.keys(loaded?.variables ?? {})).toHaveLength(120);
    expect(loaded?.variables.Var0).toMatchObject({ key: 'plan-0.json' });
    expect(loaded?.variables.Var119).toMatchObject({ key: 'plan-119.json' });
  });

  describe('getChildRunbookResult', () => {
    it('should return pass when child has lifecycle completed', async () => {
      const child = await manager.create(
        { source: 'project', path: 'child.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'child.runbook.md',
        },
      );
      await manager.update(child.id, { lifecycle: 'completed' });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('pass');
    });

    it('should return fail when child has lifecycle stopped', async () => {
      const child = await manager.create(
        { source: 'project', path: 'child.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'child.runbook.md',
        },
      );
      await manager.update(child.id, { lifecycle: 'stopped' });

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBe('fail');
    });

    it('should return null when child is still active', async () => {
      const child = await manager.create(
        { source: 'project', path: 'child.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'child.runbook.md',
        },
      );
      await sessionService.pushRunbook(child.id);

      const result = await lifecycleService.getChildRunbookResult(child.id);
      expect(result).toBeNull();
    });

    it('should return pass when child state deleted', async () => {
      const result = await lifecycleService.getChildRunbookResult('nonexistent-id');
      expect(result).toBe('pass');
    });

    it('should return null when child is stashed', async () => {
      const child = await manager.create(
        { source: 'project', path: 'child.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'child.runbook.md',
        },
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
      );

      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));
      // Re-initialize same frame — should replace, not duplicate
      await manager.initializeSubsteps(state.id, substeps, buildFrameKey('1', 1));

      const updated = await manager.load(state.id);
      expect(updated?.substepStates).toHaveLength(1);
    });

    it('preserves existing same-frame substep state when initializing an existing frame', async () => {
      const substeps = [
        makeSubstep({ id: '1', description: 'First' }),
        makeSubstep({ id: '2', description: 'Second' }),
      ];
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
        },
      );
      const frameKey = buildFrameKey('1');
      const inline = {
        childRunbookPath: 'runbooks/child.runbook.md',
        childRunbookRef: { source: 'project' as const, path: 'runbooks/child.runbook.md' },
        contextSnapshot: buildContextSnapshot(state, '1'),
        childRunId: assertRunId('rd_11111111111111111111111111111111'),
        createdAt: '2026-05-30T00:00:00.000Z',
        startedAt: null,
      };
      const delegation = {
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
        childRunbookPath: 'runbooks/delegated.runbook.md',
        childRunbookRef: { source: 'project' as const, path: 'runbooks/delegated.runbook.md' },
        contextSnapshot: buildContextSnapshot(state, '1'),
        childRunId: null,
        createdAt: '2026-05-30T00:00:00.000Z',
        cancelledAt: null,
      };

      await manager.update(state.id, {
        substepStates: [{ id: '1', frameKey, status: 'done', result: 'pass', delegation, inline }],
      });

      const reloaded = await manager.load(state.id);
      expect(reloaded).not.toBeNull();
      await manager.initializeSubsteps(reloaded!.id, substeps, frameKey);

      const initialized = await manager.load(state.id);
      const entry = initialized?.substepStates?.find(
        (substep) => substep.id === '1' && substep.frameKey === frameKey,
      );
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('done');
      expect(entry?.result).toBe('pass');
      expect(entry?.delegation).toEqual(delegation);
      expect(entry?.inline).toEqual(expect.objectContaining({ childRunId: inline.childRunId }));
    });

    it('adds missing substeps without resetting existing same-frame entries', async () => {
      const substeps = [
        makeSubstep({ id: '1', description: 'Existing' }),
        makeSubstep({ id: '2', description: 'New' }),
      ];
      const state = await manager.create(
        { source: 'project', path: 'parent.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'parent.runbook.md',
        },
      );
      const frameKey = buildFrameKey('1');
      const existing = { id: '1', frameKey, status: 'done' as const, result: 'pass' as const };

      await manager.update(state.id, { substepStates: [existing] });
      await manager.initializeSubsteps(state.id, substeps, frameKey);

      const initialized = await manager.load(state.id);
      expect(initialized?.substepStates).toEqual([
        existing,
        { id: '2', frameKey, status: 'pending' },
      ]);
    });
  });

  describe('RunbookStateManager substep lifecycle', () => {
    it('completes substep with result', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
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
    it('generates canonical rd-prefixed run ids', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      expect(state.id).toMatch(/^rd_[a-f0-9]{32}$/);
    });

    it('defaults to auto mode (prompted undefined)', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      expect(state.prompted).toBeUndefined();
    });

    it('accepts prompted option', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        prompted: true,
      });
      expect(state.prompted).toBe(true);
    });
  });

  describe('create with runbook identity', () => {
    it('persists canonical runbook identity through create/load round-trip', async () => {
      const runbookRef = { source: 'plugin' as const, path: 'planning/write-plan.runbook.md' };
      const state = await manager.create(runbookRef, mockRunbook, {
        runbookPath: '../../plugin/runbooks/planning/write-plan.runbook.md',
      });

      expect(state.runbook).toEqual(runbookRef);
      expect(Object.hasOwn(state, 'runbookRef')).toBe(false);

      const loaded = await manager.load(state.id);
      expect(loaded?.runbook).toEqual(runbookRef);
      expect(Object.hasOwn(loaded ?? {}, 'runbookRef')).toBe(false);
    });
  });

  describe('List and delete operations', () => {
    it('list returns all runbook states', async () => {
      await manager.create({ source: 'project', path: 'one.md' }, mockRunbook, {
        runbookPath: 'one.md',
      });
      await manager.create({ source: 'project', path: 'two.md' }, mockRunbook, {
        runbookPath: 'two.md',
      });
      await manager.create({ source: 'project', path: 'three.md' }, mockRunbook, {
        runbookPath: 'three.md',
      });

      const states = await manager.list();

      expect(states).toHaveLength(3);
    });

    it('list returns empty array when no states exist', async () => {
      const states = await manager.list();
      expect(states).toEqual([]);
    });

    it('delete removes runbook state', async () => {
      const state = await manager.create({ source: 'project', path: 'delete.md' }, mockRunbook, {
        runbookPath: 'delete.md',
      });

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
    it('rejects legacy per-agent stacks session shape', async () => {
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      await writeFile(
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
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      await writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: ['parent'],
          ownedRunbooks: {},
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(/Legacy session ownership format/);
    });

    it('rejects legacy stashedRunbookOwnership session shape', async () => {
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      await writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: ['parent'],
          stashedRunbookOwnership: { agent: 'foo', session: 'bar' },
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(/Legacy session ownership format/);
    });

    it('rejects a session whose claim records predate lastSeenAt (#519)', async () => {
      // A pre-#519 claim record: structurally a valid claim in every other respect,
      // but with no `lastSeenAt`. CLAUDE.md forbids migrating persisted state —
      // the guard REJECTS it with the finish/prune/restart recovery path, exactly as
      // the legacy-ownership guard does. It is never hydrated, defaulted, or shimmed.
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      const claimKey = `rdclk_${'a'.repeat(32)}`;
      const runId = `rd_${'0'.repeat(32)}`;
      await writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: [runId],
          claims: {
            [claimKey]: {
              claimKey,
              secretHash: `sha256:${'b'.repeat(64)}`,
              controlledRunId: runId,
              grants: [{ action: 'mutate-run', runId }],
              issuedAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
            },
          },
        }),
      );

      await expect(manager.loadSession()).rejects.toThrow(
        'Legacy claim record format detected. Finish or prune active runbooks and restart.',
      );
    });

    it('accepts a session whose claim records carry lastSeenAt (#519)', async () => {
      // The guard's NEGATIVE case, and it is not symmetry for its own sake: without
      // it, `.some(...)` -> `.every(...)`, dropping the `!Array.isArray(rawClaims)`
      // check, and dropping the `claim !== null` check are all mutants that the
      // rejection case above CANNOT kill — a guard that throws unconditionally
      // passes it. This is the case that proves the guard discriminates rather than
      // merely fires.
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      const claimKey = `rdclk_${'a'.repeat(32)}`;
      const runId = `rd_${'0'.repeat(32)}`;
      await writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({
          defaultStack: [runId],
          claims: {
            [claimKey]: {
              claimKey,
              secretHash: `sha256:${'b'.repeat(64)}`,
              controlledRunId: runId,
              grants: [{ action: 'mutate-run', runId }],
              issuedAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-01T00:00:00.000Z',
              lastSeenAt: '2026-07-01T00:00:00.000Z',
            },
          },
        }),
      );

      const session = await manager.loadSession();
      expect(session.claims[claimKey].lastSeenAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('loads a session with no claims at all without tripping the claim guard (#519)', async () => {
      // `claims: {}` must load cleanly: `.some()` over an empty object is false. This
      // kills the `.some` -> `.every` mutant specifically — `.every` over an empty
      // object is TRUE, so the mutant would throw on every claimless session, which
      // is the overwhelmingly common case.
      await mkdir(join(testDir, '.rundown'), { recursive: true });
      await writeFile(
        join(testDir, '.rundown', 'session.json'),
        JSON.stringify({ defaultStack: [], claims: {} }),
      );

      const session = await manager.loadSession();
      expect(session.claims).toEqual({});
    });

    it('load returns null for nonexistent runbook', async () => {
      const result = await manager.load('nonexistent-id');
      expect(result).toBeNull();
    });

    it('setLastResult updates last result', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      await lifecycleService.setLastResult(state.id, 'pass');

      const updated = await manager.load(state.id);
      expect(updated?.lastResult).toBe('pass');
    });

    it('update throws for missing runbook', async () => {
      await expect(manager.update('nonexistent', { step: '2' })).rejects.toThrow('not found');
    });

    it('is not blocked by an obstruction at the old fixed-suffix .tmp path', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      const stateFilePath = _statePath(testDir, state.id);

      // A directory at the OLD fixed temp name blocked the previous fixed-suffix
      // implementation (EISDIR on the temp write). With a randomized per-write
      // suffix it must no longer interfere.
      await mkdir(`${stateFilePath}.tmp`);

      await expect(manager.save({ ...state, step: 'changed' })).resolves.toBeUndefined();

      const reloaded = await manager.load(state.id);
      expect(reloaded?.step).toBe('changed');
    });

    it('leaves no temp files behind after a successful write', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      await manager.update(state.id, { variables: merge({ A: '1' }) });

      const entries = await readdir(runsDir(testDir));
      expect(entries.some((name) => name.includes('.tmp'))).toBe(false);
    });

    // The atomic-write failure path is forced by making the runs directory
    // read-only (so the temp write fails with EACCES). This is skipped on
    // Windows and when running as root, where directory mode is not enforced.
    const writeFailureEnforced = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

    (writeFailureEnforced ? it : it.skip)(
      'preserves existing run state when the atomic write fails',
      async () => {
        const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
          runbookPath: 'test.md',
        });
        const stateFilePath = _statePath(testDir, state.id);
        const originalContent = await readFile(stateFilePath, 'utf8');

        const dir = runsDir(testDir);
        await chmod(dir, 0o500);
        try {
          await expect(manager.save({ ...state, step: 'changed' })).rejects.toThrow();
        } finally {
          await chmod(dir, 0o700);
        }

        await expect(readFile(stateFilePath, 'utf8')).resolves.toBe(originalContent);
        const entries = await readdir(dir);
        expect(entries.some((name) => name.includes('.tmp'))).toBe(false);
      },
    );

    // NOTE: Cross-process serialization of run-state writes is intentionally
    // pinned at the IN-PROCESS layer (the two tests below) rather than by a
    // multi-process spawn test. An automated test that spawns concurrent CLI
    // processes was investigated and deliberately NOT added: process startup
    // dwarfs the load→save critical section, so the spawned processes never
    // reliably overlap inside the lock window and the test cannot dependably
    // trigger the lost-update race it would claim to cover. A test that cannot
    // fail when the lock is removed is worse than no test. The lock's
    // correctness is therefore pinned here: the real-lock contention test
    // proves the lock serializes overlapping read-modify-write cycles, and the
    // injected-factory test proves every manager write actually routes through
    // the lock. Do NOT add a flaky cross-process spawn test in their place.
    it('serializes concurrent update read-modify-write cycles without losing merged fields', async () => {
      // Exercises the REAL run-state lock: two concurrent same-process updates
      // both kick off their async load before either write lands, so without
      // serialization the second would clobber the first (lost update). The
      // file lock forces them to run one at a time. No wall-clock dependency.
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      await Promise.all([
        manager.update(state.id, { variables: merge({ A: '1' }) }),
        manager.update(state.id, { variables: merge({ B: '2' }) }),
      ]);

      const updated = await manager.load(state.id);
      expect(updated?.variables).toEqual({ A: '1', B: '2' });
      // Lock file is released and removed once both updates complete.
      await expect(readFile(runStateLockPath(testDir, state.id), 'utf8')).rejects.toThrow();
    });

    it('serializes manager writes through the injected lock factory deterministically', async () => {
      const events: string[] = [];
      // Single shared mutex across every lock instance the factory hands out, so
      // the test asserts true serialization without any wall-clock timing.
      let chain: Promise<void> = Promise.resolve();
      const releasers: Array<() => void> = [];
      const factory: RunStateLockFactory = (): RunStateLockLike => ({
        acquire: async (runId) => {
          let release!: () => void;
          const next = new Promise<void>((resolve) => {
            release = resolve;
          });
          const prior = chain;
          chain = chain.then(() => next);
          releasers.push(release);
          await prior;
          events.push(`acquire:${runId}`);
        },
        release: async (runId) => {
          events.push(`release:${runId}`);
          releasers.shift()?.();
        },
      });

      const lockedManager = new RunbookStateManager(testDir, { lockFactory: factory });
      const state = await lockedManager.create(
        { source: 'project', path: 'test.md' },
        mockRunbook,
        { runbookPath: 'test.md' },
      );
      events.length = 0;

      await Promise.all([
        lockedManager.update(state.id, { variables: merge({ A: '1' }) }),
        lockedManager.update(state.id, { variables: merge({ B: '2' }) }),
      ]);

      // The injected factory must actually be used: two updates → two
      // acquire/release pairs. (A vacuously-empty log would mean the factory
      // was ignored and the real lock ran instead.)
      expect(events).toHaveLength(4);

      // Every acquire is immediately followed by its matching release before the
      // next acquire: writes were serialized, not interleaved.
      for (let i = 0; i < events.length; i += 2) {
        expect(events[i]).toMatch(/^acquire:/);
        expect(events[i + 1]).toMatch(/^release:/);
      }

      const reloaded = await lockedManager.load(state.id);
      expect(reloaded?.variables).toEqual({ A: '1', B: '2' });
    });

    (writeFailureEnforced ? it : it.skip)(
      'preserves existing session data when the atomic write fails',
      async () => {
        const rundownDir = join(testDir, '.rundown');
        const sessionPath = join(rundownDir, 'session.json');
        await manager.saveSession({ defaultStack: [], claims: {} });
        const originalContent = await readFile(sessionPath, 'utf8');

        await chmod(rundownDir, 0o500);
        try {
          await expect(
            manager.saveSession({
              defaultStack: [assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
              claims: {},
            }),
          ).rejects.toThrow();
        } finally {
          await chmod(rundownDir, 0o700);
        }

        await expect(readFile(sessionPath, 'utf8')).resolves.toBe(originalContent);
      },
    );

    it('rejects legacy targetPath fields instead of stripping them on save', async () => {
      const state = await manager.create({ source: 'project', path: 'legacy.md' }, mockRunbook, {
        runbookPath: 'legacy.md',
      });
      const resolvedKey = '1||1|';

      await manager.update(state.id, {
        resolvedCompletions: merge({
          [resolvedKey]: {
            agentId: 'agent-1',
            result: 'pass',
            targetStep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: new Date().toISOString(),
          },
        }),
      });

      const stateFilePath = _statePath(testDir, state.id);
      const raw = JSON.parse(await readFile(stateFilePath, 'utf8')) as Record<string, unknown>;

      const resolved = (raw.resolvedCompletions as Record<string, Record<string, unknown>>)[
        resolvedKey
      ];
      resolved.targetPath = '1';
      await writeFile(stateFilePath, JSON.stringify(raw), { mode: 0o600 });

      await expect(manager.load(state.id)).rejects.toThrow(/schema validation failed/);
    });
  });

  describe('update variables/templateVars semantics', () => {
    it('replaces templateVars wholesale when updates.templateVars is defined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: { env: 'staging', port: 3000 },
      });

      const updated = await manager.update(state.id, {
        templateVars: replace({ env: 'prod' }),
      });

      expect(updated.templateVars).toEqual({ env: 'prod' });
      expect(updated.templateVars).not.toHaveProperty('port');
    });

    it('preserves existing templateVars when updates.templateVars is undefined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: { env: 'staging', port: 3000 },
      });

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.templateVars).toEqual({ env: 'staging', port: 3000 });
    });

    it('shallow-merges variables when updates.variables is defined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { variables: merge({ A: '1', B: '2' }) });

      const updated = await manager.update(state.id, { variables: merge({ B: 'two', C: '3' }) });

      expect(updated.variables).toEqual({ A: '1', B: 'two', C: '3' });
    });

    it('preserves existing variables when updates.variables is undefined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { variables: merge({ A: '1' }) });

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.variables).toEqual({ A: '1' });
    });
  });

  describe('isPrompted', () => {
    it('returns true when parent has prompted flag', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
        prompted: true,
      });

      const result = await lifecycleService.isPrompted(parent.id);
      expect(result).toBe(true);
    });

    it('returns false when parent has no prompted flag', async () => {
      const parent = await manager.create({ source: 'project', path: 'parent.md' }, mockRunbook, {
        runbookPath: 'parent.md',
      });

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

      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
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
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          runbookPath: 'test.runbook.md',
        },
      );

      expect(state.runbookSrc).toBeUndefined();
    });
  });

  describe('file permissions', () => {
    const filePermissionsSupported = process.platform !== 'win32';

    (filePermissionsSupported ? it : it.skip)(
      'should set restrictive file permissions on state files',
      async () => {
        const state = await manager.create(
          { source: 'project', path: 'test.runbook.md' },
          mockRunbook,
          {
            runbookPath: 'test.runbook.md',
          },
        );

        const statePath = _statePath(testDir, state.id);
        const stats = await stat(statePath);

        // Check mode is 0o600 (owner read/write only)
        // Note: mode includes file type bits, so mask with 0o777
        expect(stats.mode & 0o777).toBe(0o600);
      },
    );
  });

  describe('FOR loop context persistence', () => {
    it('persists FOR fields through round-trip', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      // Manually save legacy state with GOTO_NEXT
      const fs = await import('node:fs/promises');
      const stateFilePath = _statePath(testDir, state.id);
      const legacyState = {
        ...state,
        lastAction: { type: 'GOTO_NEXT' },
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw the dedicated class — consumers classify
      // by type, so the wording must never be load-bearing.
      await expect(manager.load(state.id)).rejects.toThrow(LegacySnapshotError);
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('rejects state with instance field', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

      // Manually save legacy state with instance field
      const fs = await import('node:fs/promises');
      const stateFilePath = _statePath(testDir, state.id);
      const legacyState = {
        ...state,
        instance: 2,
      };
      await fs.writeFile(stateFilePath, JSON.stringify(legacyState));

      // Attempt to load should throw the dedicated class for this shape too.
      await expect(manager.load(state.id)).rejects.toThrow(LegacySnapshotError);
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('provides helpful error message for legacy snapshots', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
      });

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

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        runbookPath: 'test.md',
        templateVars: templateVars,
      });

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
        { source: 'project', path: 'demo.runbook.md' },
        mockRunbook,
        {
          runbookPath: '/abs/demo.runbook.md',
        },
      );
      // Simulate captured output files written during a run
      const outDir = join(testDir, '.rundown', 'runs', state.id, 'outputs', '1');
      await (await import('node:fs/promises')).mkdir(outDir, { recursive: true });
      await (await import('node:fs/promises')).writeFile(join(outDir, 'Version'), 'v1.2.3');

      await manager.delete(state.id);

      // Both the state file and the outputs dir should be gone
      const { stat: fsStat } = await import('node:fs/promises');
      await expect(
        fsStat(join(testDir, '.rundown', 'runs', `${state.id}.json`)),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fsStat(join(testDir, '.rundown', 'runs', state.id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('is a no-op when the outputs directory does not exist', async () => {
      const state = await manager.create(
        { source: 'project', path: 'demo.runbook.md' },
        mockRunbook,
        {
          runbookPath: '/abs/demo.runbook.md',
        },
      );
      // No outputs dir created — delete must still succeed
      await expect(manager.delete(state.id)).resolves.toBeUndefined();
    });

    it('waits for the run-state lock before removing state', async () => {
      const state = await manager.create(
        { source: 'project', path: 'demo.runbook.md' },
        mockRunbook,
        { runbookPath: '/abs/demo.runbook.md' },
      );
      const statePath = join(testDir, '.rundown', 'runs', `${state.id}.json`);

      // Hold the per-run lock from a separate lock instance (live process), so
      // delete cannot reclaim it as stale and must wait for release.
      const lock = new RunStateLock(testDir);
      await lock.acquire(state.id);

      let settled = false;
      const deletion = manager.delete(state.id).then(() => {
        settled = true;
      });

      // While the lock is held, delete blocks and the state file survives.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      await expect(readFile(statePath, 'utf8')).resolves.toBeDefined();

      await lock.release(state.id);
      await deletion;

      expect(settled).toBe(true);
      await expect(readFile(statePath, 'utf8')).rejects.toThrow();
    });
  });

  describe('updateWithState', () => {
    it('applies the patch derived from the locked current state', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const updated = await manager.updateWithState(state.id, (current) => ({
        stepName: `derived from ${current.step}`,
      }));

      expect(updated.stepName).toBe('derived from 1');
      const loaded = await manager.load(state.id);
      expect(loaded?.stepName).toBe('derived from 1');
    });

    it('leaves state unchanged and returns current state when callback returns null', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const result = await manager.updateWithState(state.id, () => null);

      expect(result.id).toBe(state.id);
      expect(result.stepName).toBe(state.stepName);
    });

    it('throws when the runbook does not exist', async () => {
      const buildUpdates = jest.fn(() => ({ stepName: 'unreachable' }));

      await expect(manager.updateWithState('rd_missing', buildUpdates)).rejects.toThrow(
        'Runbook rd_missing not found',
      );
      // Callback must never run for a missing runbook.
      expect(buildUpdates).not.toHaveBeenCalled();
    });
  });

  describe('updateWithStateIfExists', () => {
    it('applies the patch derived from the locked current state', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const updated = await manager.updateWithStateIfExists(state.id, (current) => ({
        stepName: `derived from ${current.step}`,
      }));

      expect(updated?.stepName).toBe('derived from 1');
      const loaded = await manager.load(state.id);
      expect(loaded?.stepName).toBe('derived from 1');
    });

    it('returns current state unchanged when callback returns null', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const result = await manager.updateWithStateIfExists(state.id, () => null);

      expect(result?.id).toBe(state.id);
      expect(result?.stepName).toBe(state.stepName);
    });

    it('returns null without invoking the callback when the runbook does not exist', async () => {
      const buildUpdates = jest.fn(() => ({ stepName: 'unreachable' }));

      const result = await manager.updateWithStateIfExists('rd_missing', buildUpdates);

      expect(result).toBeNull();
      expect(buildUpdates).not.toHaveBeenCalled();
    });
  });

  describe('updateWithStateReturning', () => {
    it('flows a typed value out alongside the patch', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const result = await manager.updateWithStateReturning(state.id, (current) => ({
        updates: { stepName: `derived from ${current.step}` },
        value: `seen:${current.step}`,
      }));

      expect(result.value).toBe(`seen:${state.step}`);
      expect(result.state?.stepName).toBe('derived from 1');

      const reloaded = await manager.load(state.id);
      expect(reloaded?.stepName).toBe('derived from 1');
    });

    it('returns the current state and value unchanged when callback updates are null', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { runbookPath: 'test.runbook.md' },
      );

      const result = await manager.updateWithStateReturning(state.id, () => ({
        updates: null,
        value: 'reported',
      }));

      expect(result.state?.id).toBe(state.id);
      expect(result.value).toBe('reported');
    });

    it('returns null state and value without invoking the callback when the runbook is missing', async () => {
      const buildResult = jest.fn(() => ({
        updates: { stepName: 'unreachable' },
        value: 'unused',
      }));

      const result = await manager.updateWithStateReturning('rd_missing', buildResult);

      expect(result.state).toBeNull();
      expect(result.value).toBeNull();
      expect(buildResult).not.toHaveBeenCalled();
    });
  });
});
