import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getErrorMessage, isError } from '../../src/errors.js';
import {
  applyRunbookStateUpdate,
  CURRENT_SCHEMA_VERSION,
  generateRunId,
  InvalidRunbookStateError,
  isConcurrentStateModificationError,
  LegacySnapshotError,
  RunbookStateManager,
} from '../../src/runbook/state.js';
import type { InvalidRunStateDefect } from '../../src/errors.js';
import { merge, replace } from '../../src/runbook/state-update-ops.js';
import { partitionVariables } from '../../src/runbook/variable-preparation.js';
import { getRunbookStore } from '../../src/runbook/storage/store-registry.js';
import { makeAggregationLastAction } from '../../src/runbook/last-action.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import {
  generateOwnerToken,
  hashRunSecret,
  type SecretHash,
} from '../../src/runbook/run-secrets.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { MAX_FOR_BOUND } from '@rundown-org/parser';
import type { Step, Runbook, RunId } from '../../src/runbook/types.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';
import { makeBaseStep, makeSubstep } from '../helpers/step-factories.js';

describe('RunbookStateManager', () => {
  /** Overwrite a run's persisted state_json with a raw object (legacy fixtures). */
  async function writeRawStateJson(runId: string, raw: unknown): Promise<void> {
    const store = await getRunbookStore(testDir);
    await store.transaction((txn) => {
      txn.tx
        .prepare('UPDATE runs SET state_json = :json WHERE id = :id')
        .run({ json: JSON.stringify(raw), id: runId });
    });
  }

  /**
   * Bump a run's persisted `state_version` out from under an in-flight cycle.
   *
   * Bumping the version is the point — the `runs_bump_state_version` trigger
   * fires on the `state_json` write — but the write is not a no-op: it also
   * overwrites `stepName` with the literal `'churn'`. Callers that re-derive
   * against the churned state observe that value, and the retry test asserts on
   * it, so it is part of this helper's contract rather than an implementation
   * detail.
   *
   * @param runId - Run to churn.
   */
  async function churn(runId: string): Promise<void> {
    const store = await getRunbookStore(testDir);
    await store.transaction((txn) => {
      txn.tx
        .prepare(
          "UPDATE runs SET state_json = json_set(state_json, '$.stepName', 'churn') WHERE id = :id",
        )
        .run({ id: runId });
    });
  }

  /**
   * Read a run's persisted `state_version`.
   *
   * The `runs_bump_state_version` trigger fires on any `state_json` write, so an
   * unmoved version is direct evidence that nothing was persisted — which
   * comparing a field's value cannot show, since a real write of an identical
   * value looks the same from the outside.
   *
   * @param runId - Run to read.
   * @returns The current state version.
   * @throws {Error} When the run has no row — a missing row must fail loudly
   *   rather than resolve to a sentinel two comparisons would agree on.
   */
  async function stateVersionOf(runId: string): Promise<number> {
    const store = await getRunbookStore(testDir);
    return await store.transaction((txn) => {
      const row = txn.tx
        .prepare('SELECT state_version FROM runs WHERE id = :id')
        .get<{ readonly state_version: number }>({ id: runId });
      if (row === undefined) {
        throw new Error(`No run row for ${runId}`);
      }
      return row.state_version;
    });
  }

  /**
   * Assert a lost conditional write surfaced as the typed refusal.
   *
   * One writer per run (ADR 0005): the write is refused once and never retried
   * on the caller's behalf, and the refusal has to be typed — a bare `Error`
   * forces message matching, and reaches the CLI wrapper as RD-999 "Unknown
   * error" instead of RD-308.
   *
   * @param error - The value the losing call rejected with.
   * @param runId - Run the refusal must name.
   * @throws {Error} When the value is not the typed refusal — narrowing through
   *   the guard rather than casting past it, so the field assertions below
   *   cannot read a shape the value never had.
   */
  function expectRefusedConcurrent(error: unknown, runId: string): void {
    if (!isConcurrentStateModificationError(error)) {
      throw new Error(`Expected ConcurrentStateModificationError, received: ${String(error)}`);
    }
    expect(error.runId).toBe(runId);
    // `retryable` is the discriminant, not the class name: it is what separates
    // this from the refusals sharing the same throwing seam.
    expect(error.retryable).toBe(true);
    // The name is not the discriminant, but it is what a stack trace and any
    // structured log label the failure with, so it is pinned like its sibling
    // InvalidRunIdError rather than left free to drift.
    expect(error.name).toBe('ConcurrentStateModificationError');
  }

  /** A fresh owner token hash for a run whose token the test never needs. */
  function freshHash(): SecretHash {
    return hashRunSecret(generateOwnerToken());
  }

  let testDir: string;
  let manager: RunbookStateManager;
  const mockSteps: Step[] = [makeBaseStep({ name: '1', description: 'Initial step' })];
  const mockRunbook: Runbook = {
    title: 'Test Runbook',
    description: 'A test',
    steps: mockSteps,
  };

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ws-test-'));
    manager = new RunbookStateManager(testDir);
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
    );

    await expect(
      manager.update(state.id, {
        finalVars: { PlanPath: artifact, Reviews: [artifact] },
      }),
    ).rejects.toThrow(/Artifact record value for "PlanPath" is not trusted/);
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
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
      { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'parent.runbook.md' },
      );
      const frameKey = buildFrameKey('1');

      await manager.update(state.id, {
        substepStates: [{ id: '1', frameKey, status: 'done', result: 'pass' }],
      });

      const reloaded = await manager.load(state.id);
      expect(reloaded).not.toBeNull();
      await manager.initializeSubsteps(reloaded!.id, substeps, frameKey);

      const initialized = await manager.load(state.id);
      expect(initialized?.substepStates).toEqual([
        { id: '1', frameKey, status: 'done', result: 'pass' },
        { id: '2', frameKey, status: 'pending' },
      ]);
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
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

  describe('create with prompted flag', () => {
    it('generates canonical rd-prefixed run ids', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      expect(state.id).toMatch(/^rd_[a-f0-9]{32}$/);
    });

    it('defaults to auto mode, written as a definite false', async () => {
      // Written, not left absent. `load` refuses a persisted row without
      // `prompted`, so a run created without one would be unreadable the moment
      // it is saved — and this default is what makes that refusal unreachable
      // from the one production creation path.
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      expect(state.prompted).toBe(false);
      expect((await manager.load(state.id))?.prompted).toBe(false);
    });

    it('accepts prompted option', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'one.md',
      });
      await manager.create({ source: 'project', path: 'two.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'two.md',
      });
      await manager.create({ source: 'project', path: 'three.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
    it('load returns null for nonexistent runbook', async () => {
      const result = await manager.load('nonexistent-id');
      expect(result).toBeNull();
    });

    it('update persists lastResult', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      await manager.update(state.id, { lastResult: 'pass' });

      const updated = await manager.load(state.id);
      expect(updated?.lastResult).toBe('pass');
    });

    it('update throws for missing runbook', async () => {
      await expect(manager.update('nonexistent', { step: '2' })).rejects.toThrow('not found');
    });

    // One writer per run (ADR 0005). Two of the owner's own commands racing on
    // one run is a usage error made visible, not a race the manager serialises:
    // both cycles read the same version, exactly one conditional save lands,
    // and the other is refused as the typed RD-308 without being retried.
    it('refuses the losing cycle when two updates race on one run, and retries nothing', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      const outcomes = await Promise.allSettled([
        manager.update(state.id, { variables: merge({ A: '1' }) }),
        manager.update(state.id, { variables: merge({ B: '2' }) }),
      ]);

      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expectRefusedConcurrent(rejected[0].reason, state.id);

      // Exactly one write landed, and the refused patch is nowhere in it.
      const updated = await manager.load(state.id);
      expect(Object.keys(updated?.variables ?? {})).toHaveLength(1);
      expect(await stateVersionOf(state.id)).toBe(1);
    });

    it('lands every field when updates are issued one after another', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      const keys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

      for (const key of keys) {
        await manager.update(state.id, { variables: merge({ [key]: key }) });
      }

      const reloaded = await manager.load(state.id);
      expect(reloaded?.variables).toEqual(Object.fromEntries(keys.map((key) => [key, key])));
      expect(await stateVersionOf(state.id)).toBe(keys.length);
    });
  });

  describe('update variables/templateVars semantics', () => {
    it('replaces templateVars wholesale when updates.templateVars is defined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
        templateVars: { env: 'staging', port: 3000 },
      });

      const updated = await manager.update(state.id, {
        templateVars: replace({ env: 'prod' }),
      });

      expect(updated.templateVars).toEqual({ env: 'prod' });
      expect(updated.templateVars).not.toHaveProperty('port');
    });

    it('always persists templateVars, even when create() is given none', async () => {
      // Persisted state has no compatibility contract: `load` refuses a row
      // without templateVars, so `create` must always persist it — `{}` when
      // the caller supplies none.
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      expect(state.templateVars).toEqual({});

      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars).toEqual({});
    });

    it('preserves existing templateVars when updates.templateVars is undefined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
        templateVars: { env: 'staging', port: 3000 },
      });

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.templateVars).toEqual({ env: 'staging', port: 3000 });
    });

    it('shallow-merges variables when updates.variables is defined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { variables: merge({ A: '1', B: '2' }) });

      const updated = await manager.update(state.id, { variables: merge({ B: 'two', C: '3' }) });

      expect(updated.variables).toEqual({ A: '1', B: 'two', C: '3' });
    });

    it('preserves existing variables when updates.variables is undefined', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      await manager.update(state.id, { variables: merge({ A: '1' }) });

      const updated = await manager.update(state.id, { stepName: 'next' });

      expect(updated.variables).toEqual({ A: '1' });
    });
  });

  describe('runbookSrc storage', () => {
    it('should store runbookSrc when provided to create()', async () => {
      const runbookSrc = '# Test Runbook\n\n## 1. Step 1\n\nRendered content';

      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        {
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
          runbookPath: 'test.runbook.md',
        },
      );

      expect(state.runbookSrc).toBeUndefined();
    });
  });

  describe('file permissions', () => {
    const filePermissionsSupported = process.platform !== 'win32';

    (filePermissionsSupported ? it : it.skip)(
      'should set restrictive file permissions on the state database',
      async () => {
        await manager.create({ source: 'project', path: 'test.runbook.md' }, mockRunbook, {
          ownerTokenHash: freshHash(),
          launchDir: '.',
          runbookPath: 'test.runbook.md',
        });

        // State lives in the project database now; it carries run state and
        // hashed owner tokens, so it keeps the owner-only mode.
        const stats = await stat(join(testDir, '.rundown', 'rundown.db'));

        // Check mode is 0o600 (owner read/write only)
        // Note: mode includes file type bits, so mask with 0o777
        expect(stats.mode & 0o777).toBe(0o600);
      },
    );
  });

  describe('FOR loop context persistence', () => {
    it('persists FOR fields through round-trip', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
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
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      // Plant the legacy shape directly in the persisted state_json.
      await writeRawStateJson(state.id, { ...state, lastAction: { type: 'GOTO_NEXT' } });

      // Attempt to load should throw the dedicated class — consumers classify
      // by type, so the wording must never be load-bearing.
      await expect(manager.load(state.id)).rejects.toThrow(LegacySnapshotError);
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('rejects state with instance field', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      // Plant the legacy shape directly in the persisted state_json.
      await writeRawStateJson(state.id, { ...state, instance: 2 });

      // Attempt to load should throw the dedicated class for this shape too.
      await expect(manager.load(state.id)).rejects.toThrow(LegacySnapshotError);
      await expect(manager.load(state.id)).rejects.toThrow('dynamic-step snapshots');
    });

    it('provides helpful error message for legacy snapshots', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });

      // Plant the legacy shape directly in the persisted state_json.
      await writeRawStateJson(state.id, { ...state, lastAction: { type: 'GOTO_NEXT' } });

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

    // The two readers of persisted state must refuse a legacy run identically.
    // They did not: `RunbookStore.readRun` mirrored only the schema-version gate,
    // so an in-transaction reader (`txn.readState`, never `load`) got a raw
    // `ZodError` schema dump — no restart instruction, and a class outside the
    // CLI's recovery taxonomy. Measured before the shared gate landed:
    //   GOTO_NEXT  load => LegacySnapshotError | instance   load => LegacySnapshotError
    //   GOTO_NEXT  store => ZodError "No matching discriminator"
    //   instance   store => ZodError unrecognized_keys ["instance"]
    it.each([
      ['a GOTO_NEXT last action', { lastAction: { type: 'GOTO_NEXT' } }],
      ['an instance field', { instance: 2 }],
    ])('refuses %s identically through the loader and the store', async (_label, legacyShape) => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      await writeRawStateJson(state.id, { ...state, ...legacyShape });
      const store = await getRunbookStore(testDir);
      const runId = assertRunId(state.id);

      const seams = await Promise.all([
        manager.load(state.id).catch((e: unknown) => e),
        store.loadRun(runId).catch((e: unknown) => e),
        store.read((txn) => txn.readState(runId)).catch((e: unknown) => e),
      ]);

      // Same class and same wording from every seam — asserted as one object so
      // a failure names which seam diverged rather than just "not equal".
      const [viaLoad] = seams;
      expect(isError(viaLoad)).toBe(true);
      const shapes = seams.map((e) => ({
        name: isError(e) ? e.name : `NOT AN ERROR: ${JSON.stringify(e)}`,
        message: isError(e) ? e.message : '',
        legacy: e instanceof LegacySnapshotError,
      }));
      expect(shapes).toEqual([
        { name: 'LegacySnapshotError', message: (viaLoad as Error).message, legacy: true },
        { name: 'LegacySnapshotError', message: (viaLoad as Error).message, legacy: true },
        { name: 'LegacySnapshotError', message: (viaLoad as Error).message, legacy: true },
      ]);
    });
  });

  describe('templateVars persistence (unified model)', () => {
    it('persists templateVars with arrays through create/load round-trip', async () => {
      const templateVars = {
        items: ['a', 'b'] as const,
        env: 'prod',
      };

      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
        templateVars: templateVars,
      });

      // Verify templateVars are present in created state
      expect(state.templateVars.items).toEqual(['a', 'b']);
      expect(state.templateVars.env).toBe('prod');

      // Load from disk and verify persistence
      const loaded = await manager.load(state.id);
      expect(loaded?.templateVars.items).toEqual(['a', 'b']);
    });
  });

  describe('RunbookStateManager.delete — output capture cleanup', () => {
    it('removes the per-run outputs directory alongside the state JSON', async () => {
      const state = await manager.create(
        { source: 'project', path: 'demo.runbook.md' },
        mockRunbook,
        {
          ownerTokenHash: freshHash(),
          launchDir: '.',
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
          ownerTokenHash: freshHash(),
          launchDir: '.',
          runbookPath: '/abs/demo.runbook.md',
        },
      );
      // No outputs dir created — delete must still succeed
      await expect(manager.delete(state.id)).resolves.toBeUndefined();
    });
  });

  describe('mutate', () => {
    it('applies the patch derived from the current state', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );

      const updated = await manager.mutate(state.id, (current) => ({
        stepName: `derived from ${current.step}`,
      }));

      expect(updated.stepName).toBe('derived from 1');
      const loaded = await manager.load(state.id);
      expect(loaded?.stepName).toBe('derived from 1');
    });

    it('leaves state unchanged, writing nothing, when the builder returns null', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      const versionBefore = await stateVersionOf(state.id);

      const result = await manager.mutate(state.id, () => null);

      expect(result.id).toBe(state.id);
      expect(result.stepName).toBe(state.stepName);
      // Field equality alone would also hold for a real write of an identical
      // value; the unmoved version is what proves no write happened at all.
      expect(await stateVersionOf(state.id)).toBe(versionBefore);
    });

    it('throws without invoking the builder when the runbook does not exist', async () => {
      const build = jest.fn(() => ({ stepName: 'unreachable' }));

      await expect(manager.mutate('rd_missing', build)).rejects.toThrow(
        'Runbook rd_missing not found',
      );
      expect(build).not.toHaveBeenCalled();
    });

    it('runs the builder exactly once and refuses a lost write instead of re-deriving', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      const observed: string[] = [];

      const error = await manager
        .mutate(state.id, async (current) => {
          observed.push(current.stepName);
          // Move the version out from under this cycle. Under the old CAS loop
          // the builder re-ran against the churned state and the second
          // derivation committed; now the cycle is refused and nothing is
          // written.
          await churn(state.id);
          return { stepName: `derived:${current.stepName}` };
        })
        .then(
          (value) => value,
          (reason: unknown) => reason,
        );

      expect(observed).toEqual(['Initial step']);
      expectRefusedConcurrent(error, state.id);
      // Pinned as the exact value the concurrent writer left rather than as
      // `not 'derived…'`, which a corrupted or empty row would also satisfy.
      expect((await manager.load(state.id))?.stepName).toBe('churn');
    });
  });

  describe('loadWithVersion and save', () => {
    it('reads the version a run is at and saves against it', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );

      const read = await manager.loadWithVersion(state.id);
      expect(read?.stateVersion).toBe(0);

      const saved = await manager.save({ ...read!.state, stepName: 'saved' }, read!.stateVersion);
      expect(saved.kind).toBe('committed');
      if (saved.kind !== 'committed') throw new Error('expected committed');
      // `save` stamps the version and a fresh timestamp; everything else is the
      // caller's state verbatim.
      expect(saved.state.stepName).toBe('saved');
      expect(saved.state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect((await manager.loadWithVersion(state.id))?.stateVersion).toBe(1);
    });

    it('returns the typed refusal rather than throwing when the version moved', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      const read = await manager.loadWithVersion(state.id);
      await churn(state.id);

      const saved = await manager.save({ ...read!.state, stepName: 'late' }, read!.stateVersion);

      expect(saved).toEqual({ kind: 'concurrent_modification' });
      expect((await manager.load(state.id))?.stepName).toBe('churn');
    });

    it('reports missing for a run that does not exist and null for an id that cannot name one', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      const read = await manager.loadWithVersion(state.id);
      await manager.delete(state.id);

      expect(await manager.save(read!.state, read!.stateVersion)).toEqual({ kind: 'missing' });
      expect(await manager.loadWithVersion('rd_missing')).toBeNull();
    });
  });

  describe('findByOwnerTokenHash', () => {
    it('resolves the hash a run was created with, and nothing else', async () => {
      const token = generateOwnerToken();
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: hashRunSecret(token), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      await manager.create({ source: 'project', path: 'other.runbook.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'other.runbook.md',
      });

      const found = await manager.findByOwnerTokenHash(hashRunSecret(token));
      expect(found?.state.id).toBe(state.id);
      expect(found?.stateVersion).toBe(0);
      expect(await manager.findByOwnerTokenHash(freshHash())).toBeNull();
    });

    it('still resolves a finished run, so a late command can be told it finished', async () => {
      const token = generateOwnerToken();
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: hashRunSecret(token), launchDir: '.', runbookPath: 'test.runbook.md' },
      );
      await manager.update(state.id, { lifecycle: 'completed' });

      const found = await manager.findByOwnerTokenHash(hashRunSecret(token));
      expect(found?.state.lifecycle).toBe('completed');
    });

    it('refuses to create a second run under a hash another run already carries', async () => {
      const hash = freshHash();
      await manager.create({ source: 'project', path: 'a.runbook.md' }, mockRunbook, {
        ownerTokenHash: hash,
        launchDir: '.',
        runbookPath: 'a.runbook.md',
      });
      await expect(
        manager.create({ source: 'project', path: 'b.runbook.md' }, mockRunbook, {
          ownerTokenHash: hash,
          launchDir: '.',
          runbookPath: 'b.runbook.md',
        }),
      ).rejects.toThrow(/already carries the owner token hash/);
    });
  });

  describe('frame entry ordinal persistence', () => {
    // The entry ordinal is a run-global monotonic counter, not a FOR bound. A
    // long-lived run — a bounded self-GOTO loop being the shortest path there —
    // necessarily walks past whatever number a FOR clause may declare, and the
    // run must stay readable and mutable when it does. See the ceiling rationale
    // on `RunbookStateObjectSchema.activeEntry`.
    const FRAME = buildFrameKey('1');
    const BEYOND_FOR_BOUND = MAX_FOR_BOUND + 1;

    it('round-trips an entry ordinal past the FOR ceiling through save, load, and update', async () => {
      const state = await manager.create(
        { source: 'project', path: 'test.runbook.md' },
        mockRunbook,
        { ownerTokenHash: freshHash(), launchDir: '.', runbookPath: 'test.runbook.md' },
      );

      const updated = await manager.update(state.id, {
        activeFrameKey: FRAME,
        activeEntry: BEYOND_FOR_BOUND,
        frameEntryCounts: replace({ [FRAME]: BEYOND_FOR_BOUND }),
      });
      expect(updated.activeEntry).toBe(BEYOND_FOR_BOUND);

      // `update` does not validate its write, so a rejected ordinal only
      // surfaces on the next read — the run commits state it can never read.
      const loaded = await manager.load(state.id);
      expect(loaded?.activeEntry).toBe(BEYOND_FOR_BOUND);
      expect(loaded?.frameEntryCounts).toEqual({ [FRAME]: BEYOND_FOR_BOUND });

      // ...and on the next mutation, which must still be able to drive the run
      // to a terminal state rather than leaving prune as the only recovery.
      const stopped = await manager.update(state.id, { lifecycle: 'stopped' });
      expect(stopped.lifecycle).toBe('stopped');
      expect(stopped.activeEntry).toBe(BEYOND_FOR_BOUND);
    });
  });

  // RD-309 is the only 3xx STATE error scoped to a single run, and its JSON
  // envelope used to carry `"context": {}` — a consumer wanting to know WHICH
  // run had to parse English out of `error`. The refusal message names the run
  // only inside prose and does not carry the found schema version at all, so
  // every throw site now lifts the facts into a typed `defect` instead.
  describe('structured defect on refused persisted state', () => {
    /** Overwrite a run's persisted `state_json` with raw, possibly invalid, text. */
    async function writeRawStateText(runId: string, text: string): Promise<void> {
      const store = await getRunbookStore(testDir);
      await store.transaction((txn) => {
        txn.tx
          .prepare('UPDATE runs SET state_json = :json WHERE id = :id')
          .run({ json: text, id: runId });
      });
    }

    /** Load a run expected to be refused, returning the refusal's structured defect. */
    async function refusedDefect(runId: string): Promise<InvalidRunStateDefect | undefined> {
      try {
        await manager.load(runId);
      } catch (error) {
        if (error instanceof InvalidRunbookStateError || error instanceof LegacySnapshotError) {
          return error.defect;
        }
        throw error;
      }
      throw new Error('load resolved; expected a refusal');
    }

    /** Seed a valid run, then plant a raw persisted shape over it. */
    async function seedThenPlant(
      raw: (state: Record<string, unknown>) => unknown,
    ): Promise<string> {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      await writeRawStateJson(state.id, raw(state as unknown as Record<string, unknown>));
      return state.id;
    }

    // Neither name is the discriminant — consumers classify by class — but both
    // are what a stack trace and any structured log label the failure with, so
    // they are pinned like `ConcurrentStateModificationError.name` above rather
    // than left free to drift.
    // Constructed inside the test body, not in the table: an `it.each` row is
    // evaluated during collection, so an error built there is built before the
    // test runs and its constructor never executes under the assertion.
    it.each([
      { label: 'InvalidRunbookStateError', build: () => new InvalidRunbookStateError('x') },
      { label: 'LegacySnapshotError', build: () => new LegacySnapshotError('x') },
    ])('labels $label with its own name', ({ label, build }) => {
      expect(build().name).toBe(label);
    });

    it('names the run when the persisted JSON does not parse', async () => {
      const id = await seedThenPlant((state) => state);
      await writeRawStateText(id, '{ not valid json');

      expect(await refusedDefect(id)).toEqual({ runId: id, reason: 'unparseable_json' });
    });

    it.each([
      { label: 'GOTO_NEXT lastAction', plant: { lastAction: { type: 'GOTO_NEXT' } } },
      { label: 'instance field', plant: { instance: 2 } },
    ])('names the run on the legacy dynamic-step shape ($label)', async ({ plant }) => {
      const id = await seedThenPlant((state) => ({ ...state, ...plant }));

      expect(await refusedDefect(id)).toEqual({
        runId: id,
        reason: 'legacy_dynamic_step_snapshot',
      });
    });

    // The found version is reported exactly as persisted and is NOT narrowed to
    // `number`: a row claiming `"v2"` is precisely the case worth reporting, and
    // it appears nowhere in the message prose.
    it.each([
      // Derived, not a literal. A hard-coded "future" version that
      // CURRENT_SCHEMA_VERSION later catches up to plants VALID state, and this
      // row then loads cleanly with nothing failing to say the case went away.
      { label: 'a future numeric version', found: CURRENT_SCHEMA_VERSION + 1 },
      { label: 'a non-numeric version', found: 'v2' },
    ])('names the run and $label it claims', async ({ found }) => {
      const id = await seedThenPlant((state) => ({ ...state, schemaVersion: found }));

      expect(await refusedDefect(id)).toEqual({
        runId: id,
        reason: 'invalid_schema_version',
        schemaVersion: found,
      });
    });

    it('names the run when templateVars is missing', async () => {
      const id = await seedThenPlant((state) => {
        const { templateVars: _omit, ...rest } = state;
        return rest;
      });

      expect(await refusedDefect(id)).toEqual({ runId: id, reason: 'missing_template_vars' });
    });

    // Refused, not defaulted. `prompted` decides whether a run announces its
    // commands or executes them, and it is the value a composing parent
    // inherits DOWN into a fresh inline child — so a `?? false` at the read site
    // would silently adapt an incompatible row into an executing run. `create`
    // always writes the field for the same reason `templateVars` is always
    // written: a row that reached this refusal originates outside the one
    // production creation path, which the no-migration rule treats as invalid
    // regardless of which value it would have defaulted to.
    it('names the run when prompted is missing', async () => {
      const id = await seedThenPlant((state) => {
        const { prompted: _omit, ...rest } = state;
        return rest;
      });

      expect(await refusedDefect(id)).toEqual({ runId: id, reason: 'missing_prompted' });
      // The prose too, and in this suite rather than only in the guards suite:
      // `reason` tells a consumer which refusal fired, and the message is the
      // only place that names the field and what to do about it. Both halves,
      // because they are separate string literals — the diagnosis and the
      // recovery — and either can be emptied without the other noticing.
      const refusal = await manager.load(id).then(
        () => {
          throw new Error('load resolved; expected a refusal');
        },
        (error: unknown) => error,
      );
      expect(getErrorMessage(refusal)).toMatch(/missing prompted/);
      expect(getErrorMessage(refusal)).toMatch(/Prune this run and re-run the runbook\./);
    });

    // Both spellings, because the field is a boolean and the guard must not
    // reduce it to truthiness: a run created WITHOUT `--prompted` persists
    // `false`, and a guard written as `if (!raw.prompted)` would refuse every
    // one of them.
    it.each([{ prompted: true }, { prompted: false }])(
      'loads a run persisting prompted: $prompted',
      async ({ prompted }) => {
        const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
          ownerTokenHash: freshHash(),
          launchDir: '.',
          runbookPath: 'test.md',
          prompted,
        });

        expect((await manager.load(state.id))?.prompted).toBe(prompted);
      },
    );

    it('names the run when the schema parse fails', async () => {
      // `artifactVars` is a removed field the schema refuses explicitly, so this
      // reaches the schema-parse arm rather than one of the named checks above.
      const id = await seedThenPlant((state) => ({ ...state, artifactVars: {} }));

      expect(await refusedDefect(id)).toEqual({ runId: id, reason: 'schema_validation_failed' });
    });

    it('names the run and its stale version when a derivation is refused', async () => {
      const state = await manager.create({ source: 'project', path: 'test.md' }, mockRunbook, {
        ownerTokenHash: freshHash(),
        launchDir: '.',
        runbookPath: 'test.md',
      });
      const stale = { ...state, schemaVersion: 99 };

      let defect: InvalidRunStateDefect | undefined;
      try {
        applyRunbookStateUpdate(stale, { stepName: 'x' }, '2026-04-19T00:00:01Z');
      } catch (error) {
        if (!(error instanceof InvalidRunbookStateError)) throw error;
        defect = error.defect;
      }

      expect(defect).toEqual({
        runId: state.id,
        reason: 'invalid_schema_version',
        schemaVersion: 99,
      });
    });
  });
});
