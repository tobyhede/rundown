import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDelegationTokenHash,
  RunbookActorService,
  RunbookCompletionService,
  RunbookStateManager,
  type RunbookState,
  type ResolvedStep,
} from '../../src/runbook/index.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import {
  SENTINEL_ENTRY,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '../../src/runbook/targeting.js';
import {
  brandEffectiveVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../helpers/effective-vars.js';

describe('RunbookCompletionService', () => {
  const runbookId = brandRunIdForTest('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  let tmp: string;
  let manager: RunbookStateManager;
  let lifecycleService: ExecutionLifecycleService;
  let actorService: RunbookActorService;
  let service: RunbookCompletionService;

  const steps: ResolvedStep[] = [
    {
      kind: 'substeps',
      name: '1',
      description: 'Parent',
      aggregation: { strategy: 'ALL' },
      substeps: [
        {
          id: '1',
          description: 'First',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
        {
          id: '2',
          description: 'Second',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ],
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
      },
    },
  ];

  function state(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runbookId,
      runbook: { source: 'project', path: 'test.md' },
      runbookPath: 'test.md',
      step: '1',
      stepName: 'Parent',
      substep: '1',
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [],
      resolvedCompletions: {},
      frameEntries: { [buildFrameKey('1')]: 1 },
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 4,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'completion-service-'));
    manager = new RunbookStateManager(tmp);
    lifecycleService = new ExecutionLifecycleService(manager);
    actorService = new RunbookActorService(manager);
    service = new RunbookCompletionService(manager, lifecycleService, actorService);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('records non-active manual completions with sentinel entry and exact/sentinel duplicate detection', async () => {
    const current = state();
    await manager.save(current);

    const first = await service.recordManualCompletion({
      runbookId,
      currentState: current,
      targetStep: '1',
      targetSubstep: '2',
      targetFrameKey: buildFrameKey('1', 2),
      targetIteration: 2,
      result: 'pass',
      agentId: 'manual',
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = await service.recordManualCompletion({
      runbookId,
      currentState: current,
      targetStep: '1',
      targetSubstep: '2',
      targetFrameKey: buildFrameKey('1', 2),
      targetIteration: 2,
      result: 'fail',
      agentId: 'manual',
      completedAt: '2026-01-01T00:00:01.000Z',
    });

    const key = buildCompletionKey(buildFrameKey('1', 2), SENTINEL_ENTRY, '2');
    const persisted = await lifecycleService.getResolvedCompletion(runbookId, key);
    expect(first).toEqual({ status: 'recorded', key });
    expect(second).toEqual({ status: 'duplicate', key });
    expect(persisted).toEqual(expect.objectContaining({ result: 'pass', targetEntry: 0 }));
  });

  it('returns target_mismatch without dispatching or consuming when completion is not for current substep', async () => {
    const current = state();
    const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const sendAndSync = jest.spyOn(actorService, 'sendAndSync');

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
    });

    expect(result.status).toBe('failed');
    expect(sendAndSync).not.toHaveBeenCalled();
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
  });

  it('normalizes sentinel completions before dispatching the validated event', async () => {
    const current = state();
    const key = buildCompletionKey(buildFrameKey('1'), SENTINEL_ENTRY, '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: SENTINEL_ENTRY,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const sendAndSync = jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: state({ substep: '2' }),
      snapshot: {},
      effects: [],
    });

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
    });

    expect(result.status).toBe('continue');
    // The brand is a module-private `unique symbol` so we can no longer assert
    // on `__currentCursorValidated`; verifying `targetEntry: 1` (sentinel
    // normalized to active entry) and the event type proves the validator ran.
    expect(sendAndSync).toHaveBeenCalledWith(
      runbookId,
      steps,
      expect.objectContaining({
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completionKey: key,
        completion: expect.objectContaining({ targetEntry: 1, targetSubstep: '1' }),
      }),
    );
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
  });

  it('does not delete a resolved completion when actor sync fails before applying it', async () => {
    const current = state();
    const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
    const completion = buildResolvedCompletion({
      agentId: 'manual',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrameKey: buildFrameKey('1'),
      targetEntry: 1,
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    await manager.save({
      ...current,
      resolvedCompletions: { [key]: completion },
    });
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue(null);

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
    });

    expect(result.status).toBe('continue');
    if (result.status !== 'continue') throw new Error(`Unexpected status ${result.status}`);
    expect(result.applied).toEqual([]);
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
      completion,
    );
  });

  it('consumes a resolved completion only after actor sync persists the applied transition', async () => {
    const current = state();
    const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
      maxApplied: 1,
    });

    expect(result.status).toBe('continue');
    if (result.status !== 'continue') throw new Error(`Unexpected status ${result.status}`);
    expect(result.applied).toHaveLength(1);
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    await expect(manager.load(runbookId)).resolves.toEqual(
      expect.objectContaining({ substep: '2' }),
    );
  });

  it('recomputes unresolved from the state reached by a maxApplied drain', async () => {
    const current = state();
    const activeFrameKey = buildFrameKey('1');
    const nextFrameKey = buildFrameKey('1', 2);
    await manager.save({
      ...current,
      resolvedCompletions: {
        [buildCompletionKey(activeFrameKey, 1, '1')]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: activeFrameKey,
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [buildCompletionKey(activeFrameKey, 1, '2')]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrameKey: activeFrameKey,
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:01.000Z',
        }),
      },
    });
    jest.spyOn(actorService, 'sendAndSync').mockResolvedValue({
      state: state({
        substep: '1',
        activeFrameKey: nextFrameKey,
        activeEntry: 1,
        frameEntries: { [activeFrameKey]: 1, [nextFrameKey]: 1 },
      }),
      snapshot: {},
      effects: [],
    });

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
      maxApplied: 1,
    });

    expect(result.status).toBe('continue');
    if (result.status !== 'continue') throw new Error(`Unexpected status ${result.status}`);
    expect(result.unresolved).toBe(2);
    expect(result.state.activeFrameKey).toBe(nextFrameKey);
  });

  it('records child completion with finalVars on the parent completion', async () => {
    const parent = state({
      substepStates: [
        {
          id: '1',
          frameKey: buildFrameKey('1'),
          status: 'running',
          delegation: {
            tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [], at: '1.1' },
            childRunId: brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
            createdAt: '2026-01-01T00:00:00.000Z',
            cancelledAt: null,
          },
        },
      ],
    });
    await manager.save(parent);
    const child = state({
      id: brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      parentLinkage: {
        kind: 'delegation',
        parentRunId: runbookId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      },
      finalVars: { ChildValue: 'ready' },
    });

    const result = await service.recordChildCompletion({ childState: child, result: 'pass' });

    const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
      expect.objectContaining({ finalVars: { ChildValue: 'ready' }, result: 'pass' }),
    );
    await expect(manager.load(runbookId)).resolves.toEqual(
      expect.objectContaining({
        substepStates: [expect.objectContaining({ id: '1', status: 'done', result: 'pass' })],
      }),
    );
    expect(result).toBe('recorded');
  });

  describe('drain target mismatch variants', () => {
    it('returns target_mismatch for wrong targetStep', async () => {
      const current = state();
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            // Wrong step
            targetStep: '99',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const sendAndSync = jest.spyOn(actorService, 'sendAndSync');

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toBe('target_mismatch');
      }
      expect(sendAndSync).not.toHaveBeenCalled();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('returns target_mismatch for wrong targetFrameKey', async () => {
      const current = state();
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            // Wrong frame key (different iteration)
            targetFrameKey: buildFrameKey('1', 2),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const sendAndSync = jest.spyOn(actorService, 'sendAndSync');

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toBe('target_mismatch');
      }
      expect(sendAndSync).not.toHaveBeenCalled();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('returns target_mismatch for wrong targetEntry (non-sentinel)', async () => {
      const current = state();
      // Key matches current substep but targetEntry is different (and not SENTINEL_ENTRY)
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            // Wrong entry (and not sentinel)
            targetEntry: 99,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const sendAndSync = jest.spyOn(actorService, 'sendAndSync');

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toBe('target_mismatch');
      }
      expect(sendAndSync).not.toHaveBeenCalled();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });
  });

  describe('drain semantics', () => {
    /** Build a 3-substep runbook for ordered drain tests. */
    const threeSubstepSteps: ResolvedStep[] = [
      {
        kind: 'substeps',
        name: '1',
        description: 'Parent',
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'First',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          },
          {
            id: '2',
            description: 'Second',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          },
          {
            id: '3',
            description: 'Third',
            transitions: {
              pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
              fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
            },
          },
        ],
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      },
    ];

    it('applies completions in substep order across a single drain', async () => {
      // Persist completions for substeps 1.1 and 1.2; drain should apply both
      // in order and stop at 1.3 (unresolved).
      const current = state({
        substep: '1',
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'running',
          },
        ],
      });
      const key1 = buildCompletionKey(buildFrameKey('1'), 1, '1');
      const key2 = buildCompletionKey(buildFrameKey('1'), 1, '2');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key1]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
          [key2]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps: threeSubstepSteps,
        currentState: current,
      });

      // Both completions applied in substep order
      expect(result.status).toBe('continue');
      if (result.status === 'continue') {
        expect(result.applied.length).toBe(2);
        expect(result.applied[0].completion.targetSubstep).toBe('1');
        expect(result.applied[1].completion.targetSubstep).toBe('2');
      }
      // Both rows consumed
      await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.toBeNull();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key2)).resolves.toBeNull();
    });

    it('stops at the first unresolved substep — substep 1.1 only when 1.3 persisted without 1.2', async () => {
      // Persist completion for 1.1 and 1.3 only. Drain should apply 1.1, then
      // stop because 1.2 has no persisted completion.
      const current = state({
        substep: '1',
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'running',
          },
        ],
      });
      const key1 = buildCompletionKey(buildFrameKey('1'), 1, '1');
      const key3 = buildCompletionKey(buildFrameKey('1'), 1, '3');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key1]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
          [key3]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '3',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps: threeSubstepSteps,
        currentState: current,
      });

      expect(result.status).toBe('continue');
      if (result.status === 'continue') {
        expect(result.applied.length).toBe(1);
        expect(result.applied[0].completion.targetSubstep).toBe('1');
        expect(result.unresolved).toBeGreaterThanOrEqual(1);
      }
      // 1.1 consumed; 1.3 remains
      await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.toBeNull();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key3)).resolves.not.toBeNull();
    });

    it('active-frame drain reaches terminal done when all substeps pass to COMPLETE', async () => {
      // Single substep with PASS COMPLETE: drain should produce status: 'done'.
      const stepsDone: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Parent',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Only',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ];
      const current = state({
        substep: '1',
      });
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps: stepsDone,
        currentState: current,
      });

      expect(result.status).toBe('done');
      if (result.status === 'done') {
        expect(result.applied.length).toBe(1);
      }
    });

    it('active-frame drain reaches terminal stopped when substep fails', async () => {
      // Single substep with FAIL STOP: drain should produce status: 'stopped'.
      const stepsStopped: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Parent',
          aggregation: { strategy: 'ALL' },
          substeps: [
            {
              id: '1',
              description: 'Only',
              transitions: {
                pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
                fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
              },
            },
          ],
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ];
      const current = state({
        substep: '1',
      });
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps: stepsStopped,
        currentState: current,
      });

      expect(result.status).toBe('stopped');
      if (result.status === 'stopped') {
        expect(result.applied.length).toBe(1);
      }
    });

    it('frameKeyOverride that differs from active frame returns not_active without dispatching', async () => {
      const current = state();
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const sendAndSync = jest.spyOn(actorService, 'sendAndSync');

      const overrideKey = buildFrameKey('1', 5);
      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
        frameKeyOverride: overrideKey,
      });

      expect(result.status).toBe('not_active');
      if (result.status === 'not_active') {
        expect(result.frameKey).toBe(overrideKey);
        expect(result.activeFrameKey).toBe(buildFrameKey('1'));
        expect(result.applied).toEqual([]);
      }
      expect(sendAndSync).not.toHaveBeenCalled();
      // Persisted completion untouched
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('not_active unresolved count excludes substeps that already have completions in the override frame', async () => {
      const current = state();
      const overrideKey = buildFrameKey('1', 5);
      const completedKey = buildCompletionKey(overrideKey, SENTINEL_ENTRY, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [completedKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: overrideKey,
            targetEntry: SENTINEL_ENTRY,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
        frameKeyOverride: overrideKey,
      });

      expect(result.status).toBe('not_active');
      if (result.status === 'not_active') {
        expect(result.unresolved).toBe(1);
      }
    });
  });

  describe('manual recording', () => {
    it('serializes duplicate detection and resolved completion writes behind the completion lock', async () => {
      const current = state();
      await manager.save(current);

      const first = service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'pass',
        agentId: 'manual-a',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const second = service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'fail',
        agentId: 'manual-b',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const results = await Promise.all([first, second]);
      expect(results.map((recorded) => recorded.status).sort()).toEqual(['duplicate', 'recorded']);

      const exactKey = buildCompletionKey(buildFrameKey('1'), 1, '1');
      const persisted = await lifecycleService.getResolvedCompletion(runbookId, exactKey);
      const recorded = results.find((result) => result.status === 'recorded');
      expect(recorded).toEqual({ status: 'recorded', key: exactKey });
      expect(persisted).not.toBeNull();
      expect(
        [
          { result: 'pass', agentId: 'manual-a', completedAt: '2026-01-01T00:00:00.000Z' },
          { result: 'fail', agentId: 'manual-b', completedAt: '2026-01-01T00:00:01.000Z' },
        ].some(
          (expected) =>
            persisted?.result === expected.result &&
            persisted.agentId === expected.agentId &&
            persisted.completedAt === expected.completedAt,
        ),
      ).toBe(true);
    });

    it('writes exact key when target frame matches the active frame', async () => {
      const current = state();
      await manager.save(current);

      const result = await service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      // Active frame → exact key (entry=1), NOT sentinel
      const exactKey = buildCompletionKey(buildFrameKey('1'), 1, '1');
      const sentinelKey = buildCompletionKey(buildFrameKey('1'), SENTINEL_ENTRY, '1');
      expect(result).toEqual({ status: 'recorded', key: exactKey });
      await expect(lifecycleService.getResolvedCompletion(runbookId, exactKey)).resolves.toEqual(
        expect.objectContaining({ result: 'pass', targetEntry: 1 }),
      );
      await expect(
        lifecycleService.getResolvedCompletion(runbookId, sentinelKey),
      ).resolves.toBeNull();
    });

    it('exact existing blocks sentinel write (exact first, then sentinel attempt → duplicate at exact)', async () => {
      // Use a different step/substep id so it's part of the active frame.
      const current = state();
      await manager.save(current);

      // First write: exact key (target is active frame)
      const first = await service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const exactKey = buildCompletionKey(buildFrameKey('1'), 1, '1');
      expect(first).toEqual({ status: 'recorded', key: exactKey });

      // Second write: same substep but pretend target frame is non-active so
      // sentinel would normally be chosen — but pass a synthetic currentState
      // whose active frame is different.
      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
      });
      const second = await service.recordManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        // Target frame is not the active frame ('2|'), so sentinel would be chosen.
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(second).toEqual({ status: 'duplicate', key: exactKey });
      // Payload preserved: pass, not fail
      await expect(lifecycleService.getResolvedCompletion(runbookId, exactKey)).resolves.toEqual(
        expect.objectContaining({ result: 'pass' }),
      );
    });

    it('exact existing blocks sentinel-target write when caller supplies sentinel entry', async () => {
      const current = state();
      await manager.save(current);

      const exactKey = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await lifecycleService.upsertResolvedCompletion(
        runbookId,
        exactKey,
        buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrameKey: buildFrameKey('1'),
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      );

      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
        activeEntry: 1,
      });
      const second = await service.recordManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: SENTINEL_ENTRY,
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const sentinelKey = buildCompletionKey(buildFrameKey('1'), SENTINEL_ENTRY, '1');
      expect(second).toEqual({ status: 'duplicate', key: exactKey });
      await expect(lifecycleService.getResolvedCompletion(runbookId, exactKey)).resolves.toEqual(
        expect.objectContaining({
          result: 'pass',
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      await expect(
        lifecycleService.getResolvedCompletion(runbookId, sentinelKey),
      ).resolves.toBeNull();
    });

    it('sentinel existing blocks exact write (sentinel first, then exact attempt → duplicate at sentinel)', async () => {
      const current = state();
      await manager.save(current);

      // First: write sentinel by targeting a non-active frame
      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
      });
      const first = await service.recordManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const sentinelKey = buildCompletionKey(buildFrameKey('1'), SENTINEL_ENTRY, '1');
      expect(first).toEqual({ status: 'recorded', key: sentinelKey });

      // Second: now write with target frame = active frame, so the exact key
      // would normally be chosen — but the sentinel already covers this target.
      const second = await service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(second).toEqual({ status: 'duplicate', key: sentinelKey });
      // Payload preserved
      await expect(lifecycleService.getResolvedCompletion(runbookId, sentinelKey)).resolves.toEqual(
        expect.objectContaining({ result: 'pass' }),
      );
    });

    it('duplicate result preserves the original completion payload', async () => {
      const current = state();
      await manager.save(current);

      // First write — pass
      const first = await service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      // Second write — attempt to overwrite with fail
      const second = await service.recordManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrameKey: buildFrameKey('1'),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(first.status).toBe('recorded');
      expect(second.status).toBe('duplicate');
      // The persisted row remains `pass`, original timestamp
      await expect(lifecycleService.getResolvedCompletion(runbookId, first.key)).resolves.toEqual(
        expect.objectContaining({
          result: 'pass',
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  describe('child recording', () => {
    const childRunId = brandRunIdForTest('rd_cccccccccccccccccccccccccccccccc');

    function makeParentWithDelegation(cancelledAt: string | null = null): RunbookState {
      return state({
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'running',
            delegation: {
              tokenHash: assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`),
              childRunbookPath: 'child.md',
              childRunbookRef: { source: 'project', path: 'child.md' },
              contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [], at: '1.1' },
              childRunId,
              createdAt: '2026-01-01T00:00:00.000Z',
              cancelledAt,
            },
          },
        ],
      });
    }

    function makeChildWithDelegationLinkage(): RunbookState {
      return state({
        id: childRunId,
        parentLinkage: {
          kind: 'delegation',
          parentRunId: runbookId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          tokenHash: assertDelegationTokenHash(`sha256:${'c'.repeat(64)}`),
        },
      });
    }

    it('delegated child fail propagates as result: fail on the recorded completion', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({ childState: child, result: 'fail' });

      expect(result).toBe('recorded');
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'fail', agentId: 'delegation' }),
      );
      await expect(manager.load(runbookId)).resolves.toEqual(
        expect.objectContaining({
          substepStates: [expect.objectContaining({ id: '1', status: 'done', result: 'fail' })],
        }),
      );
    });

    it('inline child completion records agentId as inline', async () => {
      // Parent has substep but no delegation — inline child has linkage kind: 'inline'.
      const parent = state({
        substepStates: [
          {
            id: '1',
            frameKey: buildFrameKey('1'),
            status: 'running',
          },
        ],
      });
      await manager.save(parent);
      const child = state({
        id: childRunId,
        parentLinkage: {
          kind: 'inline',
          parentRunId: runbookId,
          parentStepId: '1',
          parentStep: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
        },
      });

      const result = await service.recordChildCompletion({ childState: child, result: 'pass' });

      expect(result).toBe('recorded');
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'pass', agentId: 'inline' }),
      );
    });

    it('cancelled delegation returns cancelled and does not record', async () => {
      const parent = makeParentWithDelegation('2026-01-01T00:00:30.000Z');
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({ childState: child, result: 'pass' });

      expect(result).toBe('cancelled');
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    });

    it('does not consume a resolved completion when sendAndSync returns null', async () => {
      const current = state();
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      jest.spyOn(actorService, 'sendAndSync').mockResolvedValue(null);

      const result = await service.drainResolvedCompletions({
        runbookId,
        steps,
        currentState: current,
      });

      expect(result.status).toBe('continue');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('does not consume a resolved completion when sendAndSync throws', async () => {
      const current = state();
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrameKey: buildFrameKey('1'),
            targetEntry: 1,
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      jest.spyOn(actorService, 'sendAndSync').mockRejectedValue(new Error('persist failed'));

      await expect(
        service.drainResolvedCompletions({
          runbookId,
          steps,
          currentState: current,
        }),
      ).rejects.toThrow('persist failed');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('ignoreCancellation bypasses the cancelled short-circuit', async () => {
      const parent = makeParentWithDelegation('2026-01-01T00:00:30.000Z');
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({
        childState: child,
        result: 'fail',
        ignoreCancellation: true,
      });

      expect(result).toBe('recorded');
      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'fail', agentId: 'delegation' }),
      );
    });

    it('missing parentLinkage returns not-applicable', async () => {
      const child = state({ id: childRunId });

      const result = await service.recordChildCompletion({ childState: child, result: 'pass' });

      expect(result).toBe('not-applicable');
    });

    it('duplicate child completion returns duplicate', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const first = await service.recordChildCompletion({ childState: child, result: 'pass' });
      const second = await service.recordChildCompletion({ childState: child, result: 'pass' });

      expect(first).toBe('recorded');
      expect(second).toBe('duplicate');
    });

    it('duplicate child completion with different result does not overwrite parent substep state', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const first = await service.recordChildCompletion({ childState: child, result: 'pass' });
      const second = await service.recordChildCompletion({
        childState: child,
        result: 'fail',
        ignoreCancellation: true,
      });

      expect(first).toBe('recorded');
      expect(second).toBe('duplicate');

      const key = buildCompletionKey(buildFrameKey('1'), 1, '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'pass' }),
      );
      await expect(manager.load(runbookId)).resolves.toEqual(
        expect.objectContaining({
          substepStates: [expect.objectContaining({ id: '1', status: 'done', result: 'pass' })],
        }),
      );
    });
  });
});
