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
      schemaVersion: 3,
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
    });

    const result = await service.drainResolvedCompletions({
      runbookId,
      steps,
      currentState: current,
    });

    expect(result.status).toBe('continue');
    expect(sendAndSync).toHaveBeenCalledWith(
      runbookId,
      steps,
      expect.objectContaining({
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completion: expect.objectContaining({ targetEntry: 1, __currentCursorValidated: true }),
      }),
    );
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
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
});
