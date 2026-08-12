import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDelegationTokenHash,
  lifecycleToDelegationOutcome,
  projectDelegationTerminalOutcome,
  RunbookActorService,
  RunbookCompletionService,
  RunbookStateManager,
  type RunbookState,
  type ResolvedStep,
  type RecordCompletionResult,
  type AppliedResolvedCompletion,
  type ApplyNextResolvedCompletionArgs,
  type ApplyNextResolvedCompletionResult,
} from '../../src/runbook/index.js';
import { CompletionLock } from '../../src/runbook/completion-lock.js';
import { merge } from '../../src/runbook/state-update-ops.js';
import { DelegationLock } from '../../src/runbook/delegation-lock.js';
import { ExecutionLifecycleService } from '../../src/runbook/execution-lifecycle-service.js';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  deriveActiveFrame,
  exactFrame,
  inactiveFrame,
  type Frame,
} from '../../src/runbook/targeting.js';
import {
  brandEffectiveVarsForTest,
  brandInitialTemplateVarsForTest,
  brandRunIdForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';
import {
  makeDelegationCredentialDescriptor,
  makeDelegationCredentialIssuer,
} from '../../src/testing/delegation-fixtures.js';

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
      templateVars: brandInitialTemplateVarsForTest({}),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  /**
   * Drain the active frame by looping the one-apply primitive.
   *
   * The core no longer owns a drain loop: `applyNextResolvedCompletion` applies
   * exactly one completion and the CLI loops it, observing each transition in
   * between. This mirrors that loop so drain-level behaviour stays testable at
   * the layer that now produces it.
   *
   * @param overrides - Extra apply arguments (frame override, credential issuer).
   * @returns The applied entries in order, and the result that ended the loop.
   */
  async function drainAll(
    overrides: Partial<Omit<ApplyNextResolvedCompletionArgs, 'runbookId'>> = {},
  ): Promise<{
    readonly applied: AppliedResolvedCompletion[];
    readonly last: ApplyNextResolvedCompletionResult;
  }> {
    const applied: AppliedResolvedCompletion[] = [];
    for (;;) {
      const result = await service.applyNextResolvedCompletion({
        runbookId,
        steps,
        ...overrides,
      });
      if (result.kind !== 'applied') return { applied, last: result };
      applied.push(result.entry);
      if (result.terminal) return { applied, last: result };
    }
  }

  /**
   * Name the drain-level arm a looped sequence of applies ended on.
   *
   * The prepared twin still reports a whole pass (`continue`/`done`/`stopped`/
   * `failed`/`not_active`) while the persisted path reports one apply at a time.
   * The equivalence tests exist to prove the two agree, so they need this
   * translation; nothing in production does.
   *
   * @param last - Result that ended the loop.
   * @returns The drain status the same pass would have reported.
   */
  function persistedArm(last: ApplyNextResolvedCompletionResult): string {
    switch (last.kind) {
      case 'applied':
        return last.terminal ?? 'continue';
      case 'mismatch':
        return 'failed';
      case 'missing':
        return 'continue';
      default:
        return last.kind === 'not_active' ? 'not_active' : 'continue';
    }
  }

  /**
   * Read the unresolved count off any arm that carries one.
   *
   * @param last - Result that ended the loop.
   * @returns The unresolved substep count, or 0 for a run that is gone.
   */
  function unresolvedOf(last: ApplyNextResolvedCompletionResult): number {
    return last.kind === 'missing' ? 0 : last.unresolved;
  }

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'completion-service-'));
    manager = new RunbookStateManager(tmp);
    lifecycleService = new ExecutionLifecycleService(manager);
    actorService = new RunbookActorService(manager);
    service = new RunbookCompletionService(manager, actorService);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each([
    ['completed', 'pass'],
    ['stopped', 'fail'],
    ['running', undefined],
  ] as const)('maps lifecycle %s to delegation outcome %s', (lifecycle, expectedOutcome) => {
    expect(lifecycleToDelegationOutcome(lifecycle)).toBe(expectedOutcome);
  });

  describe('projectDelegationTerminalOutcome', () => {
    it('projects completed children as delegated pass', () => {
      expect(projectDelegationTerminalOutcome(state({ lifecycle: 'completed' }))).toEqual({
        kind: 'outcome',
        result: 'pass',
      });
    });

    it('projects ordinary stopped children as delegated fail', () => {
      expect(
        projectDelegationTerminalOutcome(
          state({
            lifecycle: 'stopped',
            lastAction: { type: 'STOP', origin: 'direct' },
          }),
        ),
      ).toEqual({ kind: 'outcome', result: 'fail' });
    });

    it('does not project POLICY_DENIED as delegated fail', () => {
      expect(
        projectDelegationTerminalOutcome(
          state({
            lifecycle: 'stopped',
            lastAction: {
              type: 'POLICY_DENIED',
              origin: 'direct',
              message: 'blocked by policy',
            },
          }),
        ),
      ).toEqual({
        kind: 'command_infrastructure',
        reason: 'policy_denied',
        message: 'blocked by policy',
      });
    });

    it('does not project COMMAND_EXECUTION_FAILED as delegated fail', () => {
      expect(
        projectDelegationTerminalOutcome(
          state({
            lifecycle: 'stopped',
            lastAction: {
              type: 'COMMAND_EXECUTION_FAILED',
              origin: 'direct',
              message: 'Timeout of 30000 ms exceeded',
            },
          }),
        ),
      ).toEqual({
        kind: 'command_infrastructure',
        reason: 'command_execution_failed',
        message: 'Timeout of 30000 ms exceeded',
      });
    });

    it('lets explicit operator results override infrastructure projection', () => {
      expect(
        projectDelegationTerminalOutcome(
          state({
            lifecycle: 'stopped',
            lastAction: {
              type: 'POLICY_DENIED',
              origin: 'direct',
              message: 'blocked by policy',
            },
          }),
          'fail',
        ),
      ).toEqual({ kind: 'outcome', result: 'fail' });
    });
  });

  it('prepares non-active manual completions with sentinel entry and exact/sentinel duplicate detection', () => {
    const first = service.prepareManualCompletion({
      runbookId,
      currentState: state(),
      targetStep: '1',
      targetSubstep: '2',
      targetFrame: inactiveFrame(buildFrameKey('1', 2)),
      targetIteration: 2,
      result: 'pass',
      agentId: 'manual',
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    const second = service.prepareManualCompletion({
      runbookId,
      currentState: first.nextState,
      targetStep: '1',
      targetSubstep: '2',
      targetFrame: inactiveFrame(buildFrameKey('1', 2)),
      targetIteration: 2,
      result: 'fail',
      agentId: 'manual',
      completedAt: '2026-01-01T00:00:01.000Z',
    });

    const key = buildCompletionKey(inactiveFrame(buildFrameKey('1', 2)), '2');
    expect(first).toEqual(expect.objectContaining({ status: 'recorded', key }));
    expect(second).toEqual(expect.objectContaining({ status: 'duplicate', key }));
    expect(second.nextState.resolvedCompletions?.[key]).toEqual(
      expect.objectContaining({ result: 'pass', targetEntry: 0 }),
    );
  });

  it('returns target_mismatch without dispatching or consuming when completion is not for current substep', async () => {
    const current = state();
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const prepare = jest.spyOn(actorService, 'prepareActorMutation');

    const result = await drainAll();

    expect(result.last.kind).toBe('mismatch');
    expect(prepare).not.toHaveBeenCalled();
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
  });

  it('normalizes sentinel completions before dispatching the validated event', async () => {
    const current = state();
    const key = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: inactiveFrame(buildFrameKey('1')),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const prepare = jest.spyOn(actorService, 'prepareActorMutation');

    await drainAll();

    // The brand is a module-private `unique symbol` so we can no longer assert
    // on `__currentCursorValidated`; verifying `targetEntry: 1` (sentinel
    // normalized to active entry) and the event type proves the validator ran.
    expect(prepare).toHaveBeenCalledWith(
      runbookId,
      expect.objectContaining({ id: runbookId }),
      steps,
      expect.objectContaining({
        type: 'APPLY_CURRENT_RESOLVED_COMPLETION',
        completionKey: key,
        completion: expect.objectContaining({ targetEntry: 1, targetSubstep: '1' }),
      }),
      // No verified issuer supplied, so none is forwarded to the machine.
      undefined,
    );
  });

  it('forwards verified claim authority through the completion transition runtime', async () => {
    const current = state();
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const prepare = jest.spyOn(actorService, 'prepareActorMutation');
    const issueDelegationCredential = makeDelegationCredentialIssuer();

    await drainAll({ issueDelegationCredential });

    expect(prepare).toHaveBeenCalledWith(
      runbookId,
      expect.objectContaining({ id: runbookId }),
      steps,
      expect.objectContaining({ type: 'APPLY_CURRENT_RESOLVED_COMPLETION' }),
      { issueDelegationCredential },
    );
  });

  it('applies every queued completion when one drain call is left unbounded', async () => {
    // `maxApplied` is deliberately omitted: an unbounded drain keeps applying
    // until the active frame has no applicable row left, and each apply must
    // advance the cursor so the next iteration selects a different row.
    const current = state();
    const firstKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const secondKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [firstKey]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [secondKey]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    // No actor mock: the real transition consumes the applied row and advances
    // the cursor, which is what lets the second call select the second row. A
    // mock that skipped the consume would re-select the first row forever.
    const prepare = jest.spyOn(actorService, 'prepareActorMutation');

    const { applied } = await drainAll();

    expect(applied.map((entry) => entry.key)).toEqual([firstKey, secondKey]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls.map((call) => call[3])).toEqual([
      expect.objectContaining({ completionKey: firstKey }),
      expect.objectContaining({ completionKey: secondKey }),
    ]);
  });

  it('reports missing without touching the machine when the run is gone', async () => {
    const current = state();
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const completion = buildResolvedCompletion({
      agentId: 'manual',
      result: 'pass',
      targetStep: '1',
      targetSubstep: '1',
      targetFrame: activeFrame(buildFrameKey('1'), 1),
      completedAt: '2026-01-01T00:00:00.000Z',
    });
    await manager.save({
      ...current,
      resolvedCompletions: { [key]: completion },
    });
    // `prepareActorMutation` has no "not found" return: a run that is gone is
    // detected by the store cycle, whose callback never runs.
    const prepare = jest.spyOn(actorService, 'prepareActorMutation');
    await manager.delete(runbookId);

    const result = await drainAll();

    expect(result.last.kind).toBe('missing');
    expect(result.applied).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('consumes a resolved completion only after actor sync persists the applied transition', async () => {
    const current = state();
    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    await manager.save({
      ...current,
      resolvedCompletions: {
        [key]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(buildFrameKey('1'), 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });

    const result = await drainAll();

    expect(result.last.kind).toBe('none');
    if (result.last.kind !== 'none') throw new Error(`Unexpected arm ${result.last.kind}`);
    expect(result.applied).toHaveLength(1);
    await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    await expect(manager.load(runbookId)).resolves.toEqual(
      expect.objectContaining({ substep: '2' }),
    );
  });

  it('recomputes unresolved against the state each apply reached', async () => {
    const current = state();
    const activeFrameKey = buildFrameKey('1');
    const nextFrameKey = buildFrameKey('1', 2);
    await manager.save({
      ...current,
      resolvedCompletions: {
        [buildCompletionKey(activeFrame(activeFrameKey, 1), '1')]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '1',
          targetFrame: activeFrame(activeFrameKey, 1),
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
        [buildCompletionKey(activeFrame(activeFrameKey, 1), '2')]: buildResolvedCompletion({
          agentId: 'manual',
          result: 'pass',
          targetStep: '1',
          targetSubstep: '2',
          targetFrame: activeFrame(activeFrameKey, 1),
          completedAt: '2026-01-01T00:00:01.000Z',
        }),
      },
    });
    // The apply moves the cursor onto a NEW frame, where neither row applies.
    // The next selection must therefore count both substeps unresolved — it is
    // derived from the state the apply reached, not the one it started from.
    jest.spyOn(actorService, 'prepareActorMutation').mockResolvedValue({
      previousState: current,
      nextState: state({
        substep: '1',
        activeFrameKey: nextFrameKey,
        activeEntry: 1,
        frameEntryCounts: { [activeFrameKey]: 1, [nextFrameKey]: 1 },
      }),
      snapshot: {},
      effects: [],
    });

    const result = await drainAll();

    expect(result.last.kind).toBe('none');
    if (result.last.kind !== 'none') throw new Error(`Unexpected arm ${result.last.kind}`);
    expect(result.last.unresolved).toBe(2);
    expect(result.last.state.activeFrameKey).toBe(nextFrameKey);
  });

  it('records child completion with finalVars on the parent completion', async () => {
    const parent = state({
      substepStates: [
        {
          id: '1',
          frameKey: buildFrameKey('1'),
          status: 'running',
          delegation: {
            credential: makeDelegationCredentialDescriptor(),
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

    const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
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

  it('reports a delegated outcome by recording a row without advancing the delegating run', async () => {
    const childRunId = brandRunIdForTest('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const parent = state({
      substepStates: [
        {
          id: '1',
          frameKey: buildFrameKey('1'),
          status: 'running',
          delegation: {
            credential: makeDelegationCredentialDescriptor(),
            tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
            childRunbookPath: 'child.md',
            childRunbookRef: { source: 'project', path: 'child.md' },
            contextSnapshot: { vars: brandEffectiveVarsForTest({}), ancestors: [], at: '1.1' },
            childRunId,
            createdAt: '2026-01-01T00:00:00.000Z',
            cancelledAt: null,
          },
        },
      ],
    });
    await manager.save(parent);
    const child = state({
      id: childRunId,
      lifecycle: 'completed',
      parentLinkage: {
        kind: 'delegation',
        parentRunId: runbookId,
        parentStepId: '1',
        parentStep: '1',
        parentFrameKey: buildFrameKey('1'),
        parentEntry: 1,
        tokenHash: assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`),
      },
    });

    const recorded = await service.recordChildCompletion({ childState: child, result: 'pass' });

    expect(recorded).toBe('recorded');
    const fresh = await manager.load(runbookId);
    // Report wrote exactly one delegation outcome row...
    const delegationRows = Object.values(fresh?.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(delegationRows).toHaveLength(1);
    expect(delegationRows[0]?.result).toBe('pass');
    // ...and did NOT advance the delegating run (record is not apply): the
    // delegating run stays on its DELEGATE step and remains running because the
    // second substep is still unresolved.
    expect(fresh?.step).toBe('1');
    expect(fresh?.lifecycle).toBe('running');
  });

  describe('drain target mismatch variants', () => {
    it('returns target_mismatch for wrong targetStep', async () => {
      const current = state();
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            // Wrong step
            targetStep: '99',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const prepare = jest.spyOn(actorService, 'prepareActorMutation');

      const result = await drainAll();

      expect(result.last.kind).toBe('mismatch');
      if (result.last.kind === 'mismatch') {
        expect(result.last.mismatch.reason).toBe('target_mismatch');
      }
      expect(prepare).not.toHaveBeenCalled();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('returns target_mismatch for wrong targetFrameKey', async () => {
      const current = state();
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            // Wrong frame key (different iteration)
            targetFrame: exactFrame(buildFrameKey('1', 2), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const prepare = jest.spyOn(actorService, 'prepareActorMutation');

      const result = await drainAll();

      expect(result.last.kind).toBe('mismatch');
      if (result.last.kind === 'mismatch') {
        expect(result.last.mismatch.reason).toBe('target_mismatch');
      }
      expect(prepare).not.toHaveBeenCalled();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('returns target_mismatch for wrong targetEntry (non-sentinel)', async () => {
      const current = state();
      // Key matches current substep but targetEntry is different (and not SENTINEL_ENTRY)
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: exactFrame(buildFrameKey('1'), 99),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const prepare = jest.spyOn(actorService, 'prepareActorMutation');

      const result = await drainAll();

      expect(result.last.kind).toBe('mismatch');
      if (result.last.kind === 'mismatch') {
        expect(result.last.mismatch.reason).toBe('target_mismatch');
      }
      expect(prepare).not.toHaveBeenCalled();
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
      const acquireSpy = jest.spyOn(CompletionLock.prototype, 'acquire');
      const releaseSpy = jest.spyOn(CompletionLock.prototype, 'release');
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
      const key1 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const key2 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key1]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
          [key2]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ steps: threeSubstepSteps });

      // Both completions applied in substep order
      expect(result.last.kind).toBe('none');
      if (result.last.kind === 'none') {
        expect(result.applied.length).toBe(2);
        expect(result.applied[0].completion.targetSubstep).toBe('1');
        expect(result.applied[1].completion.targetSubstep).toBe('2');
      }
      // Both rows consumed
      await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.toBeNull();
      await expect(lifecycleService.getResolvedCompletion(runbookId, key2)).resolves.toBeNull();
      // No lock is taken for any of it: each apply's compare-and-swap is the
      // whole of the mutual exclusion.
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
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
      const key1 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const key3 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '3');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key1]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
          [key3]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '3',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ steps: threeSubstepSteps });

      expect(result.last.kind).toBe('none');
      if (result.last.kind === 'none') {
        expect(result.applied.length).toBe(1);
        expect(result.applied[0].completion.targetSubstep).toBe('1');
        expect(result.last.unresolved).toBeGreaterThanOrEqual(1);
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
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ steps: stepsDone });

      expect(result.last.kind).toBe('applied');
      expect(result.last.kind === 'applied' && result.last.terminal).toBe('done');
      if (result.last.kind === 'applied') {
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
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ steps: stepsStopped });

      expect(result.last.kind).toBe('applied');
      expect(result.last.kind === 'applied' && result.last.terminal).toBe('stopped');
      if (result.last.kind === 'applied') {
        expect(result.applied.length).toBe(1);
      }
    });

    it('frameOverride that differs from active frame returns not_active without dispatching', async () => {
      const current = state();
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      const prepare = jest.spyOn(actorService, 'prepareActorMutation');

      const overrideKey = buildFrameKey('1', 5);
      const result = await drainAll({ frameOverride: inactiveFrame(overrideKey) });

      expect(result.last.kind).toBe('not_active');
      if (result.last.kind === 'not_active') {
        expect(result.last.frameKey).toBe(overrideKey);
        expect(result.last.activeFrameKey).toBe(buildFrameKey('1'));
        expect(result.applied).toEqual([]);
      }
      expect(prepare).not.toHaveBeenCalled();
      // Persisted completion untouched
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.not.toBeNull();
    });

    it('not_active unresolved count excludes substeps that already have completions in the override frame', async () => {
      const current = state();
      const overrideKey = buildFrameKey('1', 5);
      const completedKey = buildCompletionKey(inactiveFrame(overrideKey), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [completedKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: inactiveFrame(overrideKey),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ frameOverride: inactiveFrame(overrideKey) });

      expect(result.last.kind).toBe('not_active');
      if (result.last.kind === 'not_active') {
        expect(result.last.unresolved).toBe(1);
      }
    });

    it('not_active unresolved counts exact existing rows as completed during observation', async () => {
      const requestedFrameKey = buildFrameKey('1');
      const current = state({
        activeFrameKey: buildFrameKey('1', 2),
        activeEntry: 1,
        forStack: [
          {
            stepId: '1',
            iteration: 2,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await manager.save({
        ...current,
        resolvedCompletions: {
          [buildCompletionKey(exactFrame(requestedFrameKey, 4), '1')]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: exactFrame(requestedFrameKey, 4),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const result = await drainAll({ frameOverride: inactiveFrame(requestedFrameKey) });

      expect(result.last.kind).toBe('not_active');
      if (result.last.kind === 'not_active') {
        expect(result.last.unresolved).toBe(1);
      }
    });
  });

  describe('manual preparation', () => {
    it('prepares the resolved row and mirrored substep state', () => {
      const current = state({
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(prepared.status).toBe('recorded');
      expect(prepared.key).toBe(key);
      expect(prepared.nextState.resolvedCompletions?.[key]).toEqual(
        expect.objectContaining({ result: 'pass', targetEntry: 1 }),
      );
      expect(prepared.nextState.substepStates).toEqual([
        expect.objectContaining({ id: '1', status: 'done', result: 'pass' }),
      ]);
    });

    it('carries the resolved row and its substep state in one prepared state, writing nothing', async () => {
      const current = state({
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      await manager.save(current);

      // Preparation is pure: the resolved completion row and the mirrored substep
      // state arrive together on ONE prepared state, and no store write happens
      // here at all. The owning fenced commit persists them in a single
      // transaction, so a concurrent reader can never observe a resolved row
      // without its 'done' substep state or vice versa.
      const updateSpy = jest.spyOn(manager, 'update');
      const updateWithStateSpy = jest.spyOn(manager, 'updateWithState');
      const updateWithStateReturningSpy = jest.spyOn(manager, 'updateWithStateReturning');

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(updateWithStateReturningSpy).not.toHaveBeenCalled();
      expect(updateWithStateSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();

      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(prepared.nextState.resolvedCompletions?.[key]).toEqual(
        expect.objectContaining({ result: 'pass', targetEntry: 1 }),
      );
      expect(prepared.nextState.substepStates).toEqual([
        expect.objectContaining({ id: '1', status: 'done', result: 'pass' }),
      ]);
      // The persisted state is untouched: preparation committed nothing.
      await expect(manager.load(runbookId)).resolves.toEqual(
        expect.objectContaining({
          resolvedCompletions: {},
          substepStates: [expect.objectContaining({ id: '1', status: 'running' })],
        }),
      );

      updateSpy.mockRestore();
      updateWithStateSpy.mockRestore();
      updateWithStateReturningSpy.mockRestore();
    });

    it('duplicate manual completion returns the captured state unchanged', () => {
      const firstKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const current = state({
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' }],
        resolvedCompletions: {
          [firstKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(prepared.status).toBe('duplicate');
      expect(prepared.key).toBe(firstKey);
      expect(prepared.nextState).toBe(current);
    });

    it('treats a done substep the cursor has moved past as a duplicate (no resolved row left)', () => {
      // Cursor has advanced to substep '2'; substep '1' is already done with no
      // resolved-completion row remaining (the actor consumed it on sync). A
      // caller re-resolving the passed-over substep '1' is a genuine duplicate.
      const current = state({
        substep: '2',
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
          { id: '2', frameKey: buildFrameKey('1'), status: 'pending' },
        ],
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(prepared.status).toBe('duplicate');
      expect(prepared.key).toBe(key);
    });

    it('prepares a re-completion when a retry re-opens the active cursor onto a done substep', () => {
      // A RETRY re-opened substep '1' (cursor is back on it) but left its prior
      // `done` status from the failed attempt in place. Resolving the now-active
      // cursor is a legitimate re-completion, not a duplicate.
      const current = state({
        substep: '1',
        retryCount: 1,
        substepStates: [
          { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
          { id: '2', frameKey: buildFrameKey('1'), status: 'done', result: 'fail' },
        ],
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(prepared.status).toBe('recorded');
      expect(prepared.key).toBe(key);
    });

    it('inactive manual completion detects an existing exact row for the same frame and substep', () => {
      const exactKey = buildCompletionKey(exactFrame(buildFrameKey('1'), 4), '1');
      const current = state({
        activeFrameKey: buildFrameKey('1', 2),
        resolvedCompletions: {
          [exactKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: exactFrame(buildFrameKey('1'), 4),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: current,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: inactiveFrame(buildFrameKey('1')),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(prepared.status).toBe('duplicate');
      expect(prepared.key).toBe(exactKey);
    });

    it('returns duplicate when the captured state already carries the active completion', () => {
      const first = service.prepareManualCompletion({
        runbookId,
        currentState: state(),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual-a',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      // Chaining the prepared state is what the fenced caller's loop does, and it
      // is the in-memory equivalent of the second writer re-reading the committed
      // row: the duplicate must be seen without any store round trip.
      const second = service.prepareManualCompletion({
        runbookId,
        currentState: first.nextState,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'fail',
        agentId: 'manual-b',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const exactKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(first).toEqual(expect.objectContaining({ status: 'recorded', key: exactKey }));
      expect(second).toEqual(expect.objectContaining({ status: 'duplicate', key: exactKey }));
      expect(second.nextState.resolvedCompletions?.[exactKey]).toEqual(
        expect.objectContaining({ result: 'pass', agentId: 'manual-a' }),
      );
    });

    it('uses the exact key when the target frame matches the active frame', () => {
      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: state(),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      // Active frame → exact key (entry=1), NOT sentinel
      const exactKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const sentinelKey = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
      expect(prepared.status).toBe('recorded');
      expect(prepared.key).toBe(exactKey);
      expect(prepared.nextState.resolvedCompletions?.[exactKey]).toEqual(
        expect.objectContaining({ result: 'pass', targetEntry: 1 }),
      );
      expect(prepared.nextState.resolvedCompletions?.[sentinelKey]).toBeUndefined();
    });

    it('exact existing blocks sentinel write (exact first, then sentinel attempt → duplicate at exact)', () => {
      // First: exact key (target is the active frame)
      const first = service.prepareManualCompletion({
        runbookId,
        currentState: state(),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const exactKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      expect(first).toEqual(expect.objectContaining({ status: 'recorded', key: exactKey }));

      // Second: same substep, but a captured state whose active frame differs, so
      // sentinel would normally be chosen.
      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
        resolvedCompletions: first.nextState.resolvedCompletions ?? {},
      });
      const second = service.prepareManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        // Target frame is not the active frame ('2|'), so sentinel would be chosen.
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(second).toEqual(expect.objectContaining({ status: 'duplicate', key: exactKey }));
      // Payload preserved: pass, not fail
      expect(second.nextState.resolvedCompletions?.[exactKey]).toEqual(
        expect.objectContaining({ result: 'pass' }),
      );
    });

    it('exact existing blocks sentinel-target write when caller supplies sentinel entry', () => {
      const exactKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
        activeEntry: 1,
        resolvedCompletions: {
          [exactKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: inactiveFrame(buildFrameKey('1')),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      const sentinelKey = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
      expect(prepared).toEqual(expect.objectContaining({ status: 'duplicate', key: exactKey }));
      expect(prepared.nextState.resolvedCompletions?.[exactKey]).toEqual(
        expect.objectContaining({
          result: 'pass',
          targetEntry: 1,
          completedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      expect(prepared.nextState.resolvedCompletions?.[sentinelKey]).toBeUndefined();
    });

    it('sentinel existing blocks exact write (sentinel first, then exact attempt → duplicate at sentinel)', () => {
      // First: write sentinel by targeting a non-active frame
      const otherCurrent = state({
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
      });
      const first = service.prepareManualCompletion({
        runbookId,
        currentState: otherCurrent,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: inactiveFrame(buildFrameKey('1')),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const sentinelKey = buildCompletionKey(inactiveFrame(buildFrameKey('1')), '1');
      expect(first).toEqual(expect.objectContaining({ status: 'recorded', key: sentinelKey }));

      // Second: target frame = active frame, so the exact key would normally be
      // chosen — but the sentinel already covers this target.
      const second = service.prepareManualCompletion({
        runbookId,
        currentState: state({ resolvedCompletions: first.nextState.resolvedCompletions ?? {} }),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(second).toEqual(expect.objectContaining({ status: 'duplicate', key: sentinelKey }));
      // Payload preserved
      expect(second.nextState.resolvedCompletions?.[sentinelKey]).toEqual(
        expect.objectContaining({ result: 'pass' }),
      );
    });

    it('duplicate result preserves the original completion payload', () => {
      const first = service.prepareManualCompletion({
        runbookId,
        currentState: state(),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      const second = service.prepareManualCompletion({
        runbookId,
        currentState: first.nextState,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'fail',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:01.000Z',
      });

      expect(first.status).toBe('recorded');
      expect(second.status).toBe('duplicate');
      // The prepared row remains `pass`, original timestamp
      expect(second.nextState.resolvedCompletions?.[first.key]).toEqual(
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
              credential: makeDelegationCredentialDescriptor(),
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

    it('records the whole report in one guarded cycle, taking no domain lock', async () => {
      // The DelegationLock's job here was making the read-derive-write span
      // atomic; the store's compare-and-swap does that now. The CompletionLock
      // assertion is the other half: this path no longer records through
      // recordManualCompletion, so the DelegationLock -> CompletionLock ordering
      // edge has no remaining site to occur at.
      const delegationAcquire = jest.spyOn(DelegationLock.prototype, 'acquire');
      const completionAcquire = jest.spyOn(CompletionLock.prototype, 'acquire');
      // Prototype spies survive earlier tests in this file, so a fresh spyOn
      // inherits their call history. Only this test's calls may count.
      delegationAcquire.mockClear();
      completionAcquire.mockClear();
      const updateWithStateReturningSpy = jest.spyOn(manager, 'updateWithStateReturning');
      await manager.save(makeParentWithDelegation());
      const child = makeChildWithDelegationLinkage();

      await expect(
        service.recordChildCompletion({ childState: child, result: 'pass' }),
      ).resolves.toBe('recorded');

      expect(delegationAcquire).not.toHaveBeenCalled();
      expect(completionAcquire).not.toHaveBeenCalled();
      expect(updateWithStateReturningSpy).toHaveBeenCalledTimes(1);
    });

    it('is not-applicable when the parent run does not exist', async () => {
      // Parent deliberately not saved. Unlike the manual recorder, a child
      // reporting to a run that is gone is a no-op, not a failure — the child
      // cannot know its parent was pruned.
      await expect(
        service.recordChildCompletion({
          childState: makeChildWithDelegationLinkage(),
          result: 'pass',
        }),
      ).resolves.toBe('not-applicable');
    });

    it('reports exactly once when concurrent child reports race the same parent', async () => {
      await manager.save(makeParentWithDelegation());
      const child = makeChildWithDelegationLinkage();

      // The DelegationLock's exclusion guarantee, restated as a CAS guarantee.
      // The token fence, cancellation check, duplicate check and write all read
      // one captured parent version, so a loser re-derives against the committed
      // outcome and reports duplicate rather than writing a second row.
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          service.recordChildCompletion({ childState: child, result: 'pass' }),
        ),
      );

      expect(results.filter((result) => result === 'recorded')).toHaveLength(1);
      expect(results.filter((result) => result === 'duplicate')).toHaveLength(7);
      const persisted = await manager.load(runbookId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toHaveLength(1);
      // Committed before observation: the caller that saw 'recorded' cannot have
      // seen it before BOTH halves of the patch were durable.
      expect(persisted?.substepStates).toEqual([
        expect.objectContaining({ id: '1', status: 'done', result: 'pass' }),
      ]);
    });

    it('delegated child fail propagates as result: fail on the recorded completion', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({ childState: child, result: 'fail' });

      expect(result).toBe('recorded');
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'fail', agentId: 'delegation' }),
      );
      await expect(manager.load(runbookId)).resolves.toEqual(
        expect.objectContaining({
          substepStates: [expect.objectContaining({ id: '1', status: 'done', result: 'fail' })],
        }),
      );
    });

    it('does not record delegated fail for an inferred policy-denied terminal child', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({
        childState: {
          ...child,
          lifecycle: 'stopped',
          lastAction: {
            type: 'POLICY_DENIED',
            origin: 'direct',
            message: 'blocked by policy',
          },
        },
      });

      expect(result).toBe('blocked');
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    });

    it('does not record delegated fail for an inferred command execution failure child', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({
        childState: {
          ...child,
          lifecycle: 'stopped',
          lastAction: {
            type: 'COMMAND_EXECUTION_FAILED',
            origin: 'direct',
            message: 'Timeout of 30000 ms exceeded',
          },
        },
      });

      expect(result).toBe('blocked');
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    });

    it('still records explicit fail for policy-denied children when a caller forces fail', async () => {
      const parent = makeParentWithDelegation();
      await manager.save(parent);
      const child = makeChildWithDelegationLinkage();

      const result = await service.recordChildCompletion({
        childState: {
          ...child,
          lifecycle: 'stopped',
          lastAction: {
            type: 'POLICY_DENIED',
            origin: 'direct',
            message: 'blocked by policy',
          },
        },
        result: 'fail',
      });

      expect(result).toBe('recorded');
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toEqual(
        expect.objectContaining({ result: 'fail', agentId: 'delegation' }),
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
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
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
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await expect(lifecycleService.getResolvedCompletion(runbookId, key)).resolves.toBeNull();
    });

    it('does not consume a resolved completion when the actor transition throws', async () => {
      const current = state();
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockRejectedValue(new Error('persist failed'));

      // The derivation throws inside the build callback, so the cycle commits
      // nothing at all — the row cannot be consumed by a transition that never
      // reached a write.
      await expect(drainAll()).rejects.toThrow('persist failed');
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
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
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

    it('classifies a consumed child completion with a matching done substep as duplicate', async () => {
      const parent = makeParentWithDelegation();
      const consumed = {
        ...parent,
        step: '2',
        substep: undefined,
        activeFrameKey: buildFrameKey('2'),
        substepStates: parent.substepStates?.map((entry) => ({
          ...entry,
          status: 'done' as const,
          result: 'pass' as const,
        })),
      };
      await manager.save(consumed);
      const before = await manager.load(runbookId);
      const child = makeChildWithDelegationLinkage();

      expect(
        service.prepareChildCompletion({ childState: child, result: 'pass' }, consumed),
      ).toEqual({ kind: 'duplicate' });
      await expect(
        service.recordChildCompletion({ childState: child, result: 'pass' }),
      ).resolves.toBe('duplicate');
      await expect(manager.load(runbookId)).resolves.toEqual(before);
    });

    it('treats a consumed child report from an earlier entry of the active frame as duplicate', async () => {
      const parent = makeParentWithDelegation();
      const reentered = {
        ...parent,
        activeEntry: 2,
        frameEntryCounts: { [buildFrameKey('1')]: 2 },
        substepStates: parent.substepStates?.map((entry) => ({
          ...entry,
          status: 'done' as const,
          result: 'pass' as const,
        })),
      };
      await manager.save(reentered);
      const before = await manager.load(runbookId);
      const child = makeChildWithDelegationLinkage();

      expect(
        service.prepareChildCompletion({ childState: child, result: 'pass' }, reentered),
      ).toEqual({ kind: 'duplicate' });
      await expect(
        service.recordChildCompletion({ childState: child, result: 'pass' }),
      ).resolves.toBe('duplicate');
      await expect(manager.load(runbookId)).resolves.toEqual(before);
    });

    describe('prepareChildCompletion no-write outcomes', () => {
      // The pure twin an aggregate terminal workflow calls against a captured
      // parent state, BEFORE any lease is crossed. Each no-write outcome is a
      // distinct instruction to the caller — drop the target, refuse the whole
      // aggregate, or report cancellation — so they must stay distinguishable.
      it('is not-applicable for a child with no parent linkage', () => {
        const child = state({ id: childRunId });

        expect(
          service.prepareChildCompletion({ childState: child, result: 'pass' }, state()),
        ).toEqual({ kind: 'not-applicable' });
      });

      it('is not-applicable when the captured parent is a different run', () => {
        // The aggregate captures several runs; preparing a child against the
        // wrong member must write nothing rather than record onto a stranger.
        const child = makeChildWithDelegationLinkage();
        const stranger = { ...makeParentWithDelegation(), id: childRunId };

        expect(
          service.prepareChildCompletion({ childState: child, result: 'pass' }, stranger),
        ).toEqual({ kind: 'not-applicable' });
      });

      it('is not-applicable while the child has not reached a terminal outcome', () => {
        const child = { ...makeChildWithDelegationLinkage(), lifecycle: 'running' as const };

        expect(
          service.prepareChildCompletion({ childState: child }, makeParentWithDelegation()),
        ).toEqual({ kind: 'not-applicable' });
      });

      it('is blocked when the child stopped on infrastructure rather than a runbook result', () => {
        // A policy denial is not a delegated `fail`: reporting it as one would
        // record an operator-meaningful outcome for a command that never ran.
        const child = {
          ...makeChildWithDelegationLinkage(),
          lifecycle: 'stopped' as const,
          lastAction: {
            type: 'POLICY_DENIED' as const,
            origin: 'direct' as const,
            message: 'blocked by policy',
          },
        };

        expect(
          service.prepareChildCompletion({ childState: child }, makeParentWithDelegation()),
        ).toEqual({ kind: 'blocked' });
      });

      it('is not-applicable when the parent substep holds a different delegation token', () => {
        // Token divergence means this report belongs to a superseded issuance —
        // the parent has since re-delegated, and the stale child must not resolve
        // the new one's substep.
        const parent = makeParentWithDelegation();
        const reissued = {
          ...parent,
          substepStates: parent.substepStates?.map((entry) => ({
            ...entry,
            delegation: entry.delegation && {
              ...entry.delegation,
              tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
            },
          })),
        } as RunbookState;

        expect(
          service.prepareChildCompletion(
            { childState: makeChildWithDelegationLinkage(), result: 'pass' },
            reissued,
          ),
        ).toEqual({ kind: 'not-applicable' });
      });

      it('reports a cancelled delegation, and records it anyway when cancellation is ignored', () => {
        // `--force`-style teardown passes ignoreCancellation so an aborted
        // delegation can still be closed out; the default must not.
        const cancelled = makeParentWithDelegation('2026-01-01T00:00:01.000Z');
        const child = makeChildWithDelegationLinkage();

        expect(
          service.prepareChildCompletion({ childState: child, result: 'pass' }, cancelled),
        ).toEqual({ kind: 'cancelled' });
        expect(
          service.prepareChildCompletion(
            { childState: child, result: 'pass', ignoreCancellation: true },
            cancelled,
          ).kind,
        ).toBe('recorded');
      });

      function makeInlineChild(): RunbookState {
        return state({
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
      }

      // The token fence and the cancellation check are both gated on
      // `linkage.kind === 'delegation'`. An inline child carries no credential —
      // `InlineLinkage` structurally has no token slot — so neither gate may fire
      // for it, however the parent substep's own delegation record looks. Without
      // these two, the gates read as unconditional.
      it('ignores a divergent parent token when the child linkage is inline', () => {
        const reissued = makeParentWithDelegation();

        expect(
          service.prepareChildCompletion(
            { childState: makeInlineChild(), result: 'pass' },
            {
              ...reissued,
              substepStates: reissued.substepStates?.map((entry) => ({
                ...entry,
                delegation: entry.delegation && {
                  ...entry.delegation,
                  tokenHash: assertDelegationTokenHash(`sha256:${'d'.repeat(64)}`),
                },
              })),
            },
          ).kind,
        ).toBe('recorded');
      });

      it('ignores a cancelled parent delegation when the child linkage is inline', () => {
        expect(
          service.prepareChildCompletion(
            { childState: makeInlineChild(), result: 'pass' },
            makeParentWithDelegation('2026-01-01T00:00:01.000Z'),
          ).kind,
        ).toBe('recorded');
      });

      // Both gates reach through two optional links. A parent substep with no
      // delegation record at all, and a parent with no matching substep state,
      // are the two shapes that make each `?.` load-bearing rather than
      // decorative — dropping either one turns a normal report into a TypeError.
      it('records against a parent substep that carries no delegation record', () => {
        const parent = state({
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        });

        expect(
          service.prepareChildCompletion(
            { childState: makeChildWithDelegationLinkage(), result: 'pass' },
            parent,
          ).kind,
        ).toBe('recorded');
      });

      it('records against a parent that has no substep states at all', () => {
        const parent = state({ substepStates: undefined });

        const prepared = service.prepareChildCompletion(
          { childState: makeChildWithDelegationLinkage(), result: 'pass' },
          parent,
        );

        expect(prepared.kind).toBe('recorded');
        if (prepared.kind !== 'recorded') throw new Error('expected recorded');
        // The absent list defaults to empty rather than propagating undefined
        // into the patch, so the mirrored substep state is still written.
        expect(prepared.nextParentState.substepStates).toEqual([
          expect.objectContaining({ id: '1', status: 'done', result: 'pass' }),
        ]);
      });

      it('carries the key and the completion time onto the prepared state', () => {
        const prepared = service.prepareChildCompletion(
          {
            childState: makeChildWithDelegationLinkage(),
            result: 'pass',
            completedAt: '2026-02-02T03:04:05.000Z',
          },
          makeParentWithDelegation(),
        );

        expect(prepared).toEqual(
          expect.objectContaining({
            kind: 'recorded',
            key: buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1'),
          }),
        );
        if (prepared.kind !== 'recorded') throw new Error('expected recorded');
        // Stamped from the report, not wall clock: an aggregate commits this
        // state later, and "now" there would date it to the commit.
        expect(prepared.nextParentState.updatedAt).toBe('2026-02-02T03:04:05.000Z');
        expect(prepared.nextParentState.resolvedCompletions?.[prepared.key]).toEqual(
          expect.objectContaining({ result: 'pass', agentId: 'delegation' }),
        );
      });

      it('falls back to wall clock when the report carries no completion time', () => {
        const before = new Date().toISOString();
        const prepared = service.prepareChildCompletion(
          { childState: makeChildWithDelegationLinkage(), result: 'pass' },
          makeParentWithDelegation(),
        );
        const after = new Date().toISOString();

        if (prepared.kind !== 'recorded') throw new Error('expected recorded');
        expect(prepared.nextParentState.updatedAt >= before).toBe(true);
        expect(prepared.nextParentState.updatedAt <= after).toBe(true);
      });

      // Frame selection decides whether the report targets the LIVE cursor or a
      // historical entry, and only the active form is exempt from the
      // already-done duplicate rule. A RETRY re-opens a substep without clearing
      // its `done` status, so the cursor sitting on a done substep is the case
      // that separates the two.
      it('targets the active frame when the linkage matches the live cursor', () => {
        // Cursor is still on substep 1 of the active frame, so this is a
        // legitimate re-completion rather than a duplicate.
        expect(
          service.prepareChildCompletion(
            { childState: makeChildWithDelegationLinkage(), result: 'pass' },
            makeReopenedParent(),
          ).kind,
        ).toBe('recorded');
      });

      it('targets an exact frame when the linkage names a different entry', () => {
        const parent = makeParentWithDelegation();
        const advanced = { ...parent, activeEntry: 2, frameEntryCounts: {} } as RunbookState;

        const prepared = service.prepareChildCompletion(
          { childState: makeChildWithDelegationLinkage(), result: 'pass' },
          advanced,
        );

        if (prepared.kind !== 'recorded') throw new Error('expected recorded');
        // Entry 1 from the linkage, not the live entry 2: the report belongs to
        // the iteration it was issued under.
        expect(prepared.key).toBe(buildCompletionKey(exactFrame(buildFrameKey('1'), 1), '1'));
      });

      /**
       * A parent whose target substep is already `done` while the cursor still
       * sits on it — what a RETRY leaves behind, since the machine does not
       * reset the status. Only an ACTIVE target frame is exempt from the
       * already-done duplicate rule, so this fixture is what makes the
       * active-vs-exact choice observable: `recorded` proves the active frame
       * was chosen, `duplicate` proves it was not. The completion key cannot
       * tell them apart — both carry the same entry, so both build the same key.
       */
      function makeReopenedParent(overrides: Partial<RunbookState> = {}): RunbookState {
        const parent = makeParentWithDelegation();
        return {
          ...parent,
          substepStates: parent.substepStates?.map((entry) => ({
            ...entry,
            status: 'done' as const,
            result: 'pass' as const,
          })),
          ...overrides,
        };
      }

      it('reads the active frame key from the state, not from the cursor derivation', () => {
        // `activeFrameKey` is authoritative when present. This state's persisted
        // key disagrees with what its cursor would derive, and the linkage
        // matches the persisted one — so recomputing instead of reading would
        // classify the report against a different frame.
        const parent = makeReopenedParent({ step: '2', activeFrameKey: buildFrameKey('1') });
        expect(deriveActiveFrame(parent).frameKey).not.toBe(buildFrameKey('1'));

        expect(
          service.prepareChildCompletion(
            { childState: makeChildWithDelegationLinkage(), result: 'pass' },
            parent,
          ).kind,
        ).toBe('recorded');
      });

      it('defaults the active entry to 1 when the state carries none', () => {
        // Entry 1 is the default, so a linkage issued at entry 1 still matches
        // the live cursor. Losing the default drops the match and the report
        // lands on a historical frame instead.
        const parent = makeReopenedParent({ activeEntry: undefined });

        expect(
          service.prepareChildCompletion(
            { childState: makeChildWithDelegationLinkage(), result: 'pass' },
            parent,
          ).kind,
        ).toBe('recorded');
      });

      it('prepares the parent state without touching the store', async () => {
        const parent = makeParentWithDelegation();
        await manager.save(parent);
        const before = await manager.load(runbookId);

        const prepared = service.prepareChildCompletion(
          { childState: makeChildWithDelegationLinkage(), result: 'pass' },
          parent,
        );

        expect(prepared.kind).toBe('recorded');
        // Purity is the contract: an aggregate commits this state itself, inside
        // its own transaction. A write here would be a second, unfenced one.
        await expect(manager.load(runbookId)).resolves.toEqual(before);
      });
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

      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
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

  describe('the apply derives from the version it commits onto', () => {
    /**
     * Seed a cursor on substep '1' carrying rows for '1' and '2'.
     *
     * @returns The persisted state.
     */
    async function seedTwoRows(): Promise<RunbookState> {
      const current = state({
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        resolvedCompletions: Object.fromEntries(
          ['1', '2'].map((substep) => [
            buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substep),
            buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: substep,
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          ]),
        ),
      });
      await manager.save(current);
      return current;
    }

    it('never applies a row for a cursor that moved after the caller read it', async () => {
      // The defect the fold removes. While selection ran against a
      // caller-supplied state and the write re-loaded its own, a cursor that
      // moved in between left the apply consuming the row for the substep the
      // caller captured while landing its PASS on the substep the machine had
      // advanced to. There is no `currentState` parameter to reproduce it
      // through any more, so the equivalent is a cursor that moves DURING the
      // cycle: the losing attempt must re-derive rather than apply its stale pick.
      await seedTwoRows();
      const substepOneKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');

      let moved = false;
      const prepare = jest.spyOn(actorService, 'prepareActorMutation');
      prepare.mockImplementation(async (id, previousState, steps_, event, runtime) => {
        if (!moved) {
          moved = true;
          // A concurrent writer advances the cursor to '2' and bumps the version,
          // so THIS attempt's compare-and-swap will lose.
          await manager.update(runbookId, {
            substep: '2',
            substepStates: [
              { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
            ],
          });
        }
        prepare.mockRestore();
        return await actorService.prepareActorMutation(id, previousState, steps_, event, runtime);
      });

      const applied = await service.applyNextResolvedCompletion({ runbookId, steps });

      // The re-derivation happened against the committed cursor ('2'), so the
      // row that was applied is '2'. Substep '1' keeps the `done` status the
      // concurrent writer committed, and its row is left for nobody — what must
      // NEVER happen is substep '1' being consumed while its PASS lands on '2'.
      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') return;
      expect(applied.entry.completion.targetSubstep).toBe('2');
      expect(applied.entry.stateBefore.substep).toBe('2');
      const persisted = await manager.load(runbookId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([substepOneKey]);
    });

    it('re-runs the derivation per attempt without applying twice', async () => {
      // The build callback runs once per compare-and-swap attempt. A losing
      // attempt must leave nothing behind: exactly one row is consumed, and the
      // committed state is the one the WINNING derivation produced.
      await seedTwoRows();
      const derive = actorService.prepareActorMutation.bind(actorService);
      let bumped = false;
      const prepare = jest
        .spyOn(actorService, 'prepareActorMutation')
        .mockImplementation(async (id, previousState, steps_, event, runtime) => {
          const result = await derive(id, previousState, steps_, event, runtime);
          if (!bumped) {
            bumped = true;
            // Bump the version AFTER this attempt derived but BEFORE it commits,
            // so its compare-and-swap loses and the callback runs again.
            await manager.update(runbookId, { retryCount: 99 });
          }
          return result;
        });

      const applied = await service.applyNextResolvedCompletion({ runbookId, steps });

      expect(applied.kind).toBe('applied');
      // Two derivations, one commit.
      expect(prepare).toHaveBeenCalledTimes(2);
      // The SECOND derivation was handed the state the concurrent writer
      // committed — that is what "derived from the version it commits onto"
      // means, and asserting it on the input is exact. Asserting it on the
      // committed output would not be: the machine owns `retryCount` and a PASS
      // resets it.
      expect(prepare.mock.calls[0]?.[1].retryCount).toBe(0);
      expect(prepare.mock.calls[1]?.[1].retryCount).toBe(99);
      const persisted = await manager.load(runbookId);
      // One row consumed, not two: the losing attempt committed nothing.
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toHaveLength(1);
    });

    it('reports the pre-apply unresolved count on a non-terminal apply, and zero on a terminal one', async () => {
      // Two distinct rules meet on the `applied` arm. A non-terminal apply
      // reports what the selection counted — the substeps still without a row,
      // measured before this apply ran. A terminal one reports 0 regardless,
      // because a finished run has nothing outstanding. Reporting the selection
      // count on a terminal apply would tell a caller to keep waiting for
      // substeps the run will never reach.
      const threeSubstepSteps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Parent',
          aggregation: { strategy: 'ALL' },
          substeps: ['1', '2', '3'].map((id) => ({
            id,
            description: `Substep ${id}`,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
          })),
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ];
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const nonTerminal = await service.applyNextResolvedCompletion({
        runbookId,
        steps: threeSubstepSteps,
      });

      expect(nonTerminal.kind).toBe('applied');
      if (nonTerminal.kind !== 'applied') return;
      expect(nonTerminal.terminal).toBeUndefined();
      // Substeps '2' and '3' had no row when this apply was selected.
      expect(nonTerminal.unresolved).toBe(2);

      // Now a terminal apply, on the single-substep COMPLETE step.
      const terminalSteps: ResolvedStep[] = [
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
      await manager.delete(runbookId);
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const terminal = await service.applyNextResolvedCompletion({
        runbookId,
        steps: terminalSteps,
      });

      expect(terminal.kind).toBe('applied');
      if (terminal.kind !== 'applied') return;
      expect(terminal.terminal).toBe('done');
      expect(terminal.unresolved).toBe(0);
    });

    it('excludes rows that name no substep from the unresolved count', async () => {
      // A row with no `targetSubstep` resolves nothing: it cannot mark a substep
      // complete, so counting it would under-report what is still outstanding and
      // tell a caller the frame is closer to done than it is.
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const applied = await service.applyNextResolvedCompletion({ runbookId, steps });

      // Both substeps are still unresolved: the substep-less row counts for
      // neither, and it does not match the cursor either.
      expect(applied.kind).toBe('none');
      if (applied.kind !== 'none') return;
      expect(applied.unresolved).toBe(2);
    });

    it('selects nothing when the cursor is not on a step with substeps', async () => {
      // The selection's first guard. Resolved completions only ever target a
      // substep, so a cursor parked on a base step has nothing selectable — and
      // reaching past the guard would index `currentStep.substeps` on a step that
      // has none.
      const baseSteps: ResolvedStep[] = [
        {
          kind: 'base',
          name: '1',
          description: 'Plain',
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'COMPLETE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ];
      await manager.save(
        state({
          substep: undefined,
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const applied = await service.applyNextResolvedCompletion({
        runbookId,
        steps: baseSteps,
      });

      expect(applied.kind).toBe('none');
      if (applied.kind !== 'none') return;
      expect(applied.unresolved).toBe(0);
    });

    it('proceeds normally when the frame override names the frame the cursor is on', async () => {
      // A frame override is a scope, not a refusal. Naming the ACTIVE frame must
      // select and apply exactly as an unscoped call does; only a divergent frame
      // is observation-only.
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const applied = await service.applyNextResolvedCompletion({
        runbookId,
        steps,
        frameOverride: activeFrame(buildFrameKey('1'), 1),
      });

      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') return;
      expect(applied.entry.completion.targetSubstep).toBe('1');
    });

    it("counts the override frame's UNresolved substeps, not its resolved ones", async () => {
      // `not_active` is observation-only, so its count is the whole answer the
      // caller gets. Counting the resolved substeps instead would report a frame
      // as nearly done exactly when it is barely started.
      const threeSubstepSteps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Parent',
          aggregation: { strategy: 'ALL' },
          substeps: ['1', '2', '3'].map((id) => ({
            id,
            description: `Substep ${id}`,
            transitions: {
              pass: { kind: 'pass' as const, retry: 0, action: { type: 'CONTINUE' as const } },
              fail: { kind: 'fail' as const, retry: 0, action: { type: 'STOP' as const } },
            },
          })),
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
          },
        },
      ];
      const overrideKey = buildFrameKey('1', 2);
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            // One of three substeps reported on the OVERRIDE frame.
            [buildCompletionKey(activeFrame(overrideKey, 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(overrideKey, 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const applied = await service.applyNextResolvedCompletion({
        runbookId,
        steps: threeSubstepSteps,
        frameOverride: activeFrame(overrideKey, 1),
      });

      expect(applied.kind).toBe('not_active');
      if (applied.kind !== 'not_active') return;
      expect(applied.frameKey).toBe(overrideKey);
      expect(applied.activeFrameKey).toBe(buildFrameKey('1'));
      // Substeps '2' and '3' carry no row on the override frame.
      expect(applied.unresolved).toBe(2);
    });

    it('falls back to a row that targets the cursor substep under another key', async () => {
      // The selection's last resort. A row can sit under a key whose substep
      // suffix is not the cursor's — a report written against a different key
      // shape — while its payload names the cursor substep. Dropping this
      // disjunct strands such a row: it is on the active frame, it targets the
      // live cursor, and nothing else would ever pick it up.
      const misKeyed = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
      await manager.save(
        state({
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
          resolvedCompletions: {
            [misKeyed]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              // Payload targets the CURSOR substep, not the key's suffix.
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
      );

      const applied = await service.applyNextResolvedCompletion({ runbookId, steps });

      expect(applied.kind).toBe('applied');
      if (applied.kind !== 'applied') return;
      expect(applied.entry.key).toBe(misKeyed);
      expect(applied.entry.completion.targetSubstep).toBe('1');
    });

    it('sees a row another process recorded between two applies', async () => {
      // The CLI loops this primitive and no longer threads a state between
      // calls. That is what lets the second call observe a row committed by a
      // different process after the first apply returned.
      const current = state({
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        resolvedCompletions: {
          [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });
      await manager.save(current);

      const first = await service.applyNextResolvedCompletion({ runbookId, steps });
      expect(first.kind).toBe('applied');

      // Another process reports substep '2' only now.
      const secondKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '2');
      await manager.update(runbookId, {
        resolvedCompletions: merge({
          [secondKey]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '2',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:02.000Z',
          }),
        }),
      });

      const second = await service.applyNextResolvedCompletion({ runbookId, steps });

      expect(second.kind).toBe('applied');
      if (second.kind !== 'applied') return;
      expect(second.entry.key).toBe(secondKey);
    });
  });

  describe('prepareResolvedCompletionDrain — the fenced twin', () => {
    /** Completion payload targeting one substep on the base frame's entry 1. */
    function completionFor(substep: string, result: 'pass' | 'fail' = 'pass') {
      return buildResolvedCompletion({
        agentId: 'manual',
        result,
        targetStep: '1',
        targetSubstep: substep,
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    /**
     * Persist a cursor state carrying reported completions for `substeps`.
     *
     * @param substeps - Substep ids to report, each with its result.
     * @param overrides - Extra state fields for the persisted cursor.
     * @returns The in-memory cursor state that was persisted.
     */
    async function seedReported(
      substeps: ReadonlyArray<readonly [string, 'pass' | 'fail']>,
      overrides: Partial<RunbookState> = {},
    ): Promise<RunbookState> {
      const current = state({
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        resolvedCompletions: Object.fromEntries(
          substeps.map(([substep, result]) => [
            buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substep),
            completionFor(substep, result),
          ]),
        ),
        ...overrides,
      });
      await manager.save(current);
      return current;
    }

    /** Serialize the persisted run exactly as it sits on disk. */
    async function persistedSnapshot(): Promise<string> {
      return JSON.stringify(await manager.load(runbookId));
    }

    it('writes NOTHING: the persisted run is byte-identical after a full prepared drain', async () => {
      // The whole point of the twin. Its substitutions each replace a write or a
      // re-read with a pure counterpart — the active-entry projection is gone
      // entirely (#680: the machine is the single writer), every store read
      // becomes its in-state twin, and `sendAndSync` becomes
      // `prepareActorMutation` — so a caller can commit the result against the
      // version it captured.
      const current = await seedReported([
        ['1', 'pass'],
        ['2', 'pass'],
      ]);
      const before = await persistedSnapshot();

      const prepared = await service.prepareResolvedCompletionDrain({
        runbookId,
        steps,
        capturedState: current,
      });

      // Real work happened — otherwise "wrote nothing" would be trivially true.
      expect(prepared.applied.length).toBeGreaterThan(0);
      expect(await persistedSnapshot()).toBe(before);
      // Specifically: no outcome row was consumed, so the same pass can be
      // re-derived after a refused commit.
      for (const substep of ['1', '2']) {
        const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), substep);
        await expect(
          lifecycleService.getResolvedCompletion(runbookId, key),
        ).resolves.not.toBeNull();
      }
    });

    it.each([
      ['continue', [['1', 'pass']] as ReadonlyArray<readonly [string, 'pass' | 'fail']>],
      [
        'done',
        [
          ['1', 'pass'],
          ['2', 'pass'],
        ] as ReadonlyArray<readonly [string, 'pass' | 'fail']>,
      ],
      ['stopped', [['1', 'fail']] as ReadonlyArray<readonly [string, 'pass' | 'fail']>],
    ])(
      'reaches the same %s arm as the persisted drain for the same input',
      async (expected, reported) => {
        // Equivalence is checked by running the twins back to back on ONE store:
        // the prepared pass writes nothing, so the persisted drain that follows
        // sees the identical starting state. Anything else would need a second
        // fixture and would only prove the fixtures matched.
        const current = await seedReported(reported);

        const prepared = await service.prepareResolvedCompletionDrain({
          runbookId,
          steps,
          capturedState: current,
        });
        const persisted = await drainAll();

        expect(prepared.status).toBe(expected);
        expect(persistedArm(persisted.last)).toBe(expected);
        expect(prepared.unresolved).toBe(unresolvedOf(persisted.last));
        expect(prepared.applied.map((entry) => entry.completion.targetSubstep)).toEqual(
          persisted.applied.map((entry) => entry.completion.targetSubstep),
        );
        expect(prepared.applied.map((entry) => entry.key)).toEqual(
          persisted.applied.map((entry) => entry.key),
        );
      },
    );

    it('reaches the same not_active arm as the persisted drain for an off-cursor frame', async () => {
      const current = await seedReported([['1', 'pass']]);
      const elsewhere = activeFrame(buildFrameKey('9'), 1);

      const prepared = await service.prepareResolvedCompletionDrain({
        runbookId,
        steps,
        capturedState: current,
        frameOverride: elsewhere,
      });
      const persisted = await drainAll({ frameOverride: elsewhere });

      expect(prepared.status).toBe('not_active');
      expect(persisted.last.kind).toBe('not_active');
      if (prepared.status !== 'not_active' || persisted.last.kind !== 'not_active') {
        throw new Error('expected not_active');
      }
      expect(prepared.frameKey).toBe(persisted.last.frameKey);
      expect(prepared.activeFrameKey).toBe(persisted.last.activeFrameKey);
      expect(prepared.unresolved).toBe(unresolvedOf(persisted.last));
      expect(prepared.applied).toEqual([]);
    });

    it('reaches the same failed arm as the persisted drain for an off-cursor completion', async () => {
      // A row reported for substep 1.2 while the cursor sits on 1.1: the only
      // failure the drain produces (`target_mismatch`), and the one collect maps
      // to `COLLECT_OPERATION_FAILED`.
      const current = await seedReported([]);
      const key = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({ ...current, resolvedCompletions: { [key]: completionFor('2') } });
      const captured = await manager.load(runbookId);
      if (!captured) throw new Error('fixture must persist');

      const prepared = await service.prepareResolvedCompletionDrain({
        runbookId,
        steps,
        capturedState: captured,
      });
      const persisted = await drainAll();

      expect(prepared.status).toBe('failed');
      expect(persisted.last.kind).toBe('mismatch');
      if (prepared.status !== 'failed' || persisted.last.kind !== 'mismatch') {
        throw new Error('expected failed');
      }
      expect(prepared.reason).toBe(persisted.last.mismatch.reason);
      expect(prepared.message).toBe(persisted.last.mismatch.message);
      expect(prepared.unresolved).toBe(unresolvedOf(persisted.last));
      // The failed arm still carries the state to commit — the prepared twin has
      // no reload to fall back on, so `state` is present on EVERY arm.
      expect(prepared.state.id).toBe(runbookId);
    });

    it('carries the machine-written frame coordinate forward without a store write', async () => {
      // #680 made the machine the single writer of frame entry, so the drain
      // projects nothing of its own: it reads the coordinate off the captured
      // cursor, falling back to `deriveActiveFrame` when the cursor carries none.
      // Start from a cursor with no frame identity at all. The first apply
      // therefore runs on a bare cursor, and the SECOND sees the coordinate the
      // machine stamped during the first — carried on the CHAINED state, not
      // re-read from a store this pass never writes.
      const current = await seedReported(
        [
          ['1', 'pass'],
          ['2', 'pass'],
        ],
        { activeFrameKey: undefined, activeEntry: undefined, frameEntryCounts: undefined },
      );
      expect((await manager.load(runbookId))?.activeFrameKey).toBeUndefined();
      const before = await persistedSnapshot();

      const prepared = await service.prepareResolvedCompletionDrain({
        runbookId,
        steps,
        capturedState: current,
      });

      // Both rows still applied, so the fallback derivation resolved the very
      // frame the completion rows are keyed to.
      expect(prepared.applied).toHaveLength(2);
      const [first, second] = prepared.applied;
      // The drain synthesizes nothing: the first apply runs on the bare cursor.
      expect(first.stateBefore.activeFrameKey).toBeUndefined();
      expect(first.stateBefore.activeEntry).toBeUndefined();
      expect(first.stateBefore.frameEntryCounts).toBeUndefined();
      // The machine wrote the coordinate during that first apply, and the second
      // apply reads it off the chained state rather than re-deriving it.
      expect(second.stateBefore.activeFrameKey).toBe(buildFrameKey('1'));
      expect(second.stateBefore.activeEntry).toBe(1);
      expect(second.stateBefore.frameEntryCounts).toEqual({ [buildFrameKey('1')]: 1 });
      // ...and the arm's own state carries it out to the commit.
      expect(prepared.state.activeFrameKey).toBe(buildFrameKey('1'));
      expect(prepared.state.activeEntry).toBe(1);
      expect(prepared.state.frameEntryCounts).toEqual({ [buildFrameKey('1')]: 1 });
      // The store never saw any of it.
      expect(await persistedSnapshot()).toBe(before);
      expect((await manager.load(runbookId))?.activeFrameKey).toBeUndefined();
    });

    it('consumes each derived completion on the CHAINED state, not through the store', async () => {
      // The consumed-completion patch rides `prepareActorMutation`'s `nextState`,
      // so each iteration must see the previous one's row already gone — that is
      // what stops the pass re-applying the same completion forever. The store
      // still holds both rows throughout.
      const current = await seedReported([
        ['1', 'pass'],
        ['2', 'pass'],
      ]);
      const key1 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');

      const prepared = await service.prepareResolvedCompletionDrain({
        runbookId,
        steps,
        capturedState: current,
      });

      expect(prepared.applied).toHaveLength(2);
      expect(Object.keys(prepared.applied[0].stateBefore.resolvedCompletions ?? {})).toContain(
        key1,
      );
      expect(Object.keys(prepared.applied[1].stateBefore.resolvedCompletions ?? {})).not.toContain(
        key1,
      );
      await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.not.toBeNull();
    });

    describe('progress invariant', () => {
      /** Distinguishes "the loop kept going" from "the guard refused". */
      class DrainSpinError extends Error {}

      /**
       * Replace `prepareActorMutation` with a transition that makes NO progress.
       *
       * The returned `nextState` is the input state verbatim: the selected row is
       * still in `resolvedCompletions` and the cursor has not moved — exactly the
       * shape that would let the drain re-select the same row forever. The stub
       * self-terminates after `budget` calls so an unguarded loop fails the test
       * instead of hanging the suite.
       *
       * @param budget - Calls allowed before the stub aborts the run.
       * @returns The installed spy, for call-count assertions.
       */
      function stubNonAdvancingMutation(budget: number) {
        let calls = 0;
        return jest
          .spyOn(actorService, 'prepareActorMutation')
          .mockImplementation(async (_id, previousState) => {
            calls += 1;
            if (calls > budget) {
              throw new DrainSpinError(`drain did not stop after ${String(budget)} applies`);
            }
            return await Promise.resolve({
              previousState,
              nextState: previousState,
              snapshot: { status: 'active', value: 'step::1::1' },
              effects: [],
            });
          });
      }

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('refuses a transition that neither consumes nor advances, instead of draining forever', async () => {
        // Termination of the `for (;;)` rests on each apply changing what the NEXT
        // iteration selects — and the only mechanism that delivers it in
        // production, `prepareActorMutation`'s consumed-completion patch, lives in
        // another module. Nothing in the drain asserted it, so a regression there
        // turned a clean failure into an unbounded spin with `applied` growing
        // without bound. Pin the refusal, and pin that it costs exactly one apply.
        const current = await seedReported([
          ['1', 'pass'],
          ['2', 'pass'],
        ]);
        const spy = stubNonAdvancingMutation(5);

        await expect(
          service.prepareResolvedCompletionDrain({ runbookId, steps, capturedState: current }),
        ).rejects.toMatchObject({ code: 'RD-821' });
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('names the run and the unconsumed key in the refusal reason', async () => {
        // The reason rides `RundownError.context`, which the CLI serialises into
        // its error envelope — an operator gets the exact row that stalled.
        const current = await seedReported([['1', 'pass']]);
        const key1 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
        stubNonAdvancingMutation(5);

        await expect(
          service.prepareResolvedCompletionDrain({ runbookId, steps, capturedState: current }),
        ).rejects.toMatchObject({
          code: 'RD-821',
          context: { reason: expect.stringContaining(key1) as unknown as string },
        });
        await expect(
          service.prepareResolvedCompletionDrain({ runbookId, steps, capturedState: current }),
        ).rejects.toMatchObject({
          context: { reason: expect.stringContaining(runbookId) as unknown as string },
        });
      });

      it('accepts a transition that keeps its row but moves the cursor', async () => {
        // Progress is a DISJUNCTION, not the actor's consume patch: moving the
        // cursor changes which rows are candidates at all, so the next iteration
        // cannot re-select this one. Guarding on the consume alone would refuse
        // this — and it is exactly the shape a machine-level test double produces.
        const current = await seedReported([
          ['1', 'pass'],
          ['2', 'pass'],
        ]);
        jest
          .spyOn(actorService, 'prepareActorMutation')
          .mockResolvedValueOnce({
            previousState: current,
            nextState: { ...current, substep: '2' },
            snapshot: {},
            effects: [],
          })
          .mockResolvedValueOnce({
            previousState: current,
            nextState: { ...current, substep: undefined },
            snapshot: {},
            effects: [],
          });

        const prepared = await service.prepareResolvedCompletionDrain({
          runbookId,
          steps,
          capturedState: current,
        });

        expect(prepared.status).toBe('continue');
        expect(prepared.applied.map((entry) => entry.completion.targetSubstep)).toEqual(['1', '2']);
      });

      it('refuses a transition that consumes its key but introduces another', async () => {
        // The chained pass adds a second requirement the persisted twin cannot
        // carry: an apply may only REMOVE rows. Deleting the applied key while
        // adding a fresh one leaves the candidate set the same size, so the pass
        // never runs out of work even though every apply "advanced".
        const current = await seedReported([['1', 'pass']]);
        let calls = 0;
        const spy = jest
          .spyOn(actorService, 'prepareActorMutation')
          .mockImplementation(async (_id, previousState, _steps, event) => {
            calls += 1;
            if (calls > 5) throw new DrainSpinError('drain did not stop after 5 applies');
            if (event.type !== 'APPLY_CURRENT_RESOLVED_COMPLETION') {
              throw new Error('fixture only models the apply event');
            }
            const rest = { ...(previousState.resolvedCompletions ?? {}) };
            if (!Object.hasOwn(rest, event.completionKey)) {
              throw new Error('fixture must carry the applied row');
            }
            const applied = rest[event.completionKey];
            delete rest[event.completionKey];
            return await Promise.resolve({
              previousState,
              nextState: {
                ...previousState,
                resolvedCompletions: {
                  ...rest,
                  [`${event.completionKey}::${String(calls)}`]: applied,
                },
              },
              snapshot: { status: 'active', value: 'step::1::1' },
              effects: [],
            });
          });

        await expect(
          service.prepareResolvedCompletionDrain({ runbookId, steps, capturedState: current }),
        ).rejects.toMatchObject({ code: 'RD-821' });
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('refuses the PERSISTED twin when a committed apply neither consumes nor advances', async () => {
        // The persisted path carries the shared half only: it re-reads per call,
        // so a concurrent writer may legitimately add a row between applies and
        // the no-growth half would refuse honest work. Re-offering the same key
        // from the same cursor is still a spin, and is refused BEFORE the commit.
        const current = await seedReported([['1', 'pass']]);
        let calls = 0;
        const spy = jest
          .spyOn(actorService, 'prepareActorMutation')
          .mockImplementation(async (_id, previousState) => {
            calls += 1;
            if (calls > 5) throw new DrainSpinError('drain did not stop after 5 applies');
            return await Promise.resolve({
              previousState,
              nextState: current,
              snapshot: {},
              effects: [],
            });
          });

        await expect(drainAll()).rejects.toMatchObject({ code: 'RD-821' });
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('leaves a genuinely advancing drain untouched', async () => {
        // The guard must be invisible to the real transition: same arm, same
        // applied sequence, same terminal status as the unguarded pass produced.
        const current = await seedReported([
          ['1', 'pass'],
          ['2', 'pass'],
        ]);

        const prepared = await service.prepareResolvedCompletionDrain({
          runbookId,
          steps,
          capturedState: current,
        });

        expect(prepared.status).toBe('done');
        expect(prepared.applied.map((entry) => entry.completion.targetSubstep)).toEqual(['1', '2']);
      });
    });
  });

  describe('fenced twins agree with their recorders', () => {
    beforeEach(() => {
      // Earlier tests spy on CompletionLock.prototype without restoring; clear
      // any prototype spies so the call counts below are this test's own.
      jest.restoreAllMocks();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('applyNextResolvedCompletion applies without touching the CompletionLock', async () => {
      const acquireSpy = jest.spyOn(CompletionLock.prototype, 'acquire');
      const releaseSpy = jest.spyOn(CompletionLock.prototype, 'release');
      const current = state({
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      const key1 = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await manager.save({
        ...current,
        resolvedCompletions: {
          [key1]: buildResolvedCompletion({
            agentId: 'manual',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const applied = await service.applyNextResolvedCompletion({ runbookId, steps });

      expect(applied.kind).toBe('applied');
      if (applied.kind === 'applied') {
        expect(applied.entry.completion.targetSubstep).toBe('1');
      }
      // The row was consumed and no lock was taken: the compare-and-swap the
      // apply commits under is the whole of its mutual exclusion.
      await expect(lifecycleService.getResolvedCompletion(runbookId, key1)).resolves.toBeNull();
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('prepareManualCompletion prepares without touching the CompletionLock', () => {
      const acquireSpy = jest.spyOn(CompletionLock.prototype, 'acquire');

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: state(),
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      expect(prepared.status).toBe('recorded');
      expect(acquireSpy).not.toHaveBeenCalled();
    });

    describe.each<{
      label: string;
      seed: (base: RunbookState) => RunbookState;
      expected: RecordCompletionResult['status'];
      targetFrame?: Frame;
    }>([
      {
        label: 'a fresh target',
        seed: (base: RunbookState): RunbookState => base,
        expected: 'recorded',
      },
      {
        label: 'a substep the cursor has already moved past',
        seed: (base: RunbookState): RunbookState => ({
          ...base,
          step: '2',
          substep: undefined,
          substepStates: [
            { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
          ],
        }),
        expected: 'duplicate',
      },
      {
        label: 'a completion row that already exists',
        seed: (base: RunbookState): RunbookState => ({
          ...base,
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
        expected: 'duplicate',
      },
      {
        // The completion key embeds the entry, so a row left by an EARLIER entry
        // on the same frame is not a duplicate of this one: a RETRY/GOTO that
        // re-opens a substep bumps the entry, and resolving the re-opened cursor
        // is a legitimate re-completion. A lookup that matched on
        // frameKey+substep alone would refuse it and strand the re-entered
        // substep with no way to resolve it.
        label: 'a completion row left behind by an earlier entry on the same frame',
        seed: (base: RunbookState): RunbookState => ({
          ...base,
          resolvedCompletions: {
            [buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1')]: buildResolvedCompletion({
              agentId: 'manual',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        }),
        targetFrame: activeFrame(buildFrameKey('1'), 2),
        expected: 'recorded',
      },
    ])(
      'prepareManualCompletion classifies $label',
      ({
        seed,
        expected,
        targetFrame,
      }: {
        seed: (b: RunbookState) => RunbookState;
        expected: RecordCompletionResult['status'];
        targetFrame?: Frame;
      }) => {
        // `prepareManualCompletion` is the only rendering of this decision left:
        // the fenced seam prepares purely and its owning runner commits. The
        // table pins the duplicate-vs-recorded classification, because getting it
        // wrong lets the same substep be resolved twice through different
        // commands. Which key each case selects is pinned separately by the
        // exact/sentinel cases in `manual preparation`.
        it('reaches the expected status', () => {
          const seeded = seed(state({ substep: '1' }));

          const prepared = service.prepareManualCompletion({
            runbookId,
            currentState: seeded,
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: targetFrame ?? activeFrame(buildFrameKey('1'), 1),
            result: 'pass' as const,
            agentId: 'manual',
            completedAt: '2026-01-01T00:00:00.000Z',
          });

          expect(prepared.status).toBe(expected);
        });
      },
    );

    it('prepareManualCompletion stamps the prepared state with the supplied completedAt', async () => {
      const seeded = state({ substep: '1' });
      await manager.save(seeded);

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: seeded,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      // The caller's completion time is the state's `updatedAt`, not wall clock:
      // an aggregate commit replays a prepared state some time after it derived
      // it, and stamping "now" there would date the state to the commit.
      expect(prepared.status).toBe('recorded');
      expect(prepared.nextState.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('prepareManualCompletion seeds substep states when the state carries none', async () => {
      const seeded = state({ substep: '1', substepStates: undefined });
      await manager.save(seeded);

      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: seeded,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
        completedAt: '2026-01-01T00:00:00.000Z',
      });

      // Absent defaults to empty on both reads — the duplicate scan and the
      // patch — rather than propagating undefined into the upsert.
      expect(prepared.status).toBe('recorded');
      expect(prepared.nextState.substepStates).toEqual([
        expect.objectContaining({ id: '1', status: 'done', result: 'pass' }),
      ]);
    });

    it('prepareManualCompletion falls back to wall clock when no completedAt is given', async () => {
      const seeded = state({ substep: '1' });
      await manager.save(seeded);

      const before = new Date().toISOString();
      const prepared = service.prepareManualCompletion({
        runbookId,
        currentState: seeded,
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        result: 'pass',
        agentId: 'manual',
      });
      const after = new Date().toISOString();

      expect(prepared.status).toBe('recorded');
      expect(prepared.nextState.updatedAt >= before).toBe(true);
      expect(prepared.nextState.updatedAt <= after).toBe(true);
    });
  });
});
