import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedStep } from '@rundown-org/parser';
import {
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  assertRunId,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  type CallerEvidence,
  type LifecycleTerminalReleasePolicy,
  type RunbookState,
} from '../../src/runbook/index.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

// Lifecycle command seam contract coverage. Maps the Task 3 contract
// (docs/superpowers/issues/2026-06-28-lifecycle-command-seam-contract.md):
//   - delegate issuance precheck (gate-only, no persistence)
//   - pass/fail target refusals (none, actor_context_required,
//     delegation_collection_pending)
//   - top-level PASS/FAIL drive (continue + done) with observation events
//   - manual substep completion drive (record + drain)
// Resolver-owned refusals (open_delegated_children, terminal claim
// confirm/conflict, stale_claim) are forwarded verbatim by #asRefusal from
// resolveTransitionTarget and are pinned in command-target-resolver.test.ts;
// their end-to-end CLI rendering is pinned in the CLI pass/fail integration and
// scenario suites.

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  onComplete: { releaseRunbook: true },
  onStopped: { releaseRunbook: true },
};

const DIRECT_CLI: CallerEvidence = { kind: 'direct_cli' };

function tx(pass: 'CONTINUE' | 'COMPLETE' | 'STOP', fail: 'CONTINUE' | 'COMPLETE' | 'STOP') {
  return {
    pass: { kind: 'pass', retry: 0, action: { type: pass } },
    fail: { kind: 'fail', retry: 0, action: { type: fail } },
  } as const;
}

describe('RunbookLifecycleCommandService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;

  const runId = assertRunId('rd_11111111111111111111111111111111');

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-command-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    sessionService = new SessionService(manager);
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      lifecycleService,
      completionService,
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runId,
      runbook: { source: 'project', path: 'lifecycle-test.md' },
      runbookPath: 'lifecycle-test.md',
      step: '1',
      stepName: 'Step one',
      substep: undefined,
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: { [buildFrameKey('1')]: 1 },
      activeFrameKey: buildFrameKey('1'),
      activeEntry: 1,
      startedAt: '2026-06-28T00:00:00.000Z',
      updatedAt: '2026-06-28T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  async function activate(state: RunbookState): Promise<void> {
    await manager.save(state);
    await sessionService.pushRunbook(state.id);
  }

  describe('precheckDelegationIssuance', () => {
    const targetState = (): RunbookState => baseState();

    it('refuses unknown caller evidence (no trust) with actor_context_required', () => {
      expect(
        seam.precheckDelegationIssuance({
          targetState: targetState(),
          callerEvidence: { kind: 'plugin', agentId: 'a' },
        }),
      ).toEqual({ kind: 'actor_context_required', intent: 'delegation-issuance' });
    });

    it('allows a direct-CLI bare delegation issuance', () => {
      expect(
        seam.precheckDelegationIssuance({
          targetState: targetState(),
          callerEvidence: DIRECT_CLI,
        }),
      ).toEqual({
        kind: 'allowed',
        role: 'orchestrator_for_target',
        targetRunId: runId,
      });
    });

    it('refuses bare delegation issuance while collection is pending', () => {
      const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      const pending = baseState({
        resolvedCompletions: {
          [completionKey]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'pass',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(buildFrameKey('1'), 1),
            completedAt: '2026-06-28T00:00:00.000Z',
          }),
        },
      });

      const outcome = seam.precheckDelegationIssuance({
        targetState: pending,
        callerEvidence: DIRECT_CLI,
      });
      expect(outcome.kind).toBe('delegation_collection_pending');
    });

    it('does not persist a delegation (gate-only precheck)', async () => {
      const target = targetState();
      await manager.save(target);
      seam.precheckDelegationIssuance({ targetState: target, callerEvidence: DIRECT_CLI });
      const reloaded = await manager.load(runId);
      expect(reloaded?.substepStates).toBeUndefined();
    });
  });

  describe('runTransition refusals', () => {
    const steps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
    ];

    it('returns none when there is no active run', async () => {
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome).toEqual({ kind: 'none' });
    });

    it('refuses untrusted (plugin) caller evidence with actor_context_required', async () => {
      await activate(baseState());
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome).toEqual({ kind: 'actor_context_required', targetRunId: runId });
    });

    it('refuses a bare advance while delegation collection is pending', async () => {
      const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
      await activate(
        baseState({
          resolvedCompletions: {
            [completionKey]: buildResolvedCompletion({
              agentId: 'delegation',
              result: 'pass',
              targetStep: '1',
              targetSubstep: '1',
              targetFrame: activeFrame(buildFrameKey('1'), 1),
              completedAt: '2026-06-28T00:00:00.000Z',
            }),
          },
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome.kind).toBe('delegation_collection_pending');
    });
  });

  describe('top-level transition drive', () => {
    it('applies a PASS CONTINUE and instructs the loop to continue', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.terminalReleaseMode).toBe('stack-pop');
      expect(outcome.loop).toEqual({ kind: 'run', prompted: false });
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.updatedState?.step).toBe('2');
    });

    it('applies a PASS COMPLETE as a terminal done with no loop', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(outcome.loop).toEqual({ kind: 'none' });
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
    });

    it('drives FAIL through the fail handler distinctly from PASS', async () => {
      // pass -> STOP, fail -> CONTINUE: only the FAIL mapping advances, so a
      // continue + persisted `fail` proves the command drove the fail handler
      // rather than silently reusing the pass path.
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'CONTINUE') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.loop).toEqual({ kind: 'run', prompted: false });
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.updatedState?.step).toBe('2');

      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.lastResult).toBe('fail');
    });
  });

  describe('manual substep completion drive', () => {
    it('records a bare substep completion and drains it', async () => {
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        steps,
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('continue');
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      // Pin that the drain actually advanced out of the substep rather than
      // leaving the cursor parked on substep 1.
      expect(outcome.updatedState?.step).toBe('2');
      expect(outcome.updatedState?.substep).toBeUndefined();

      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
      expect(persisted?.substep).toBeUndefined();
    });
  });
});
