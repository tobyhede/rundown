import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ResolvedStep,
  ResolvedStepWithSubsteps,
  Substep,
  Transitions,
} from '@rundown-org/parser';
import type { RunbookRef } from '../../src/runbook/runbook-ref.js';
import {
  DelegationScanService,
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  activeFrame,
  assertRunId,
  brandCurrentCursorResolvedCompletionForTest,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  inactiveFrame,
  type CallerEvidence,
  type InlineLinkage,
  type LifecycleTerminalReleasePolicy,
  type ResolveChildRunbook,
  type RunbookLifecycleCommandServiceDependencies,
  type RunbookState,
  type SubstepState,
} from '../../src/runbook/index.js';
import { buildContextSnapshot } from '../../src/runbook/delegation-context.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';
import { assertClaimed, linkageFor } from './claim-test-helpers.js';

// Lifecycle command seam contract coverage. Maps the Task 3 contract
// (docs/superpowers/notes/2026-06-28-lifecycle-command-seam-contract.md):
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

const SUBSTEP_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'CONTINUE' } },
};

/** Build an authored DELEGATE substep with the given runbook reference. */
function delegateSubstep(id: string, runbook: string): Substep {
  return {
    id,
    description: `Substep ${id}`,
    delegate: true,
    runbooks: [runbook],
    transitions: SUBSTEP_TRANSITIONS,
  };
}

/** Build a step that owns one or more authored DELEGATE substeps. */
function delegateStep(name: string, substeps: readonly Substep[]): ResolvedStepWithSubsteps {
  return {
    kind: 'substeps',
    name,
    description: `Step ${name}`,
    transitions: SUBSTEP_TRANSITIONS,
    substeps,
  };
}

describe('RunbookLifecycleCommandService', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;
  // Test-controlled `loadSteps`: each drive test sets `loadStepsImpl` to the steps
  // for the run it resolves; `loadStepsArgs` records the states it was called with
  // so single-resolution can be asserted (it is the observable proxy for "resolve
  // once" — `resolveTransitionTarget` is a free function and cannot be spied).
  let loadStepsImpl: (state: RunbookState) => readonly ResolvedStep[];
  let loadStepsArgs: RunbookState[];

  const runId = assertRunId('rd_11111111111111111111111111111111');

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-command-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager);
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    sessionService = new SessionService(manager);
    loadStepsImpl = () => [];
    loadStepsArgs = [];
    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      lifecycleService,
      completionService,
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: (state) => {
        loadStepsArgs.push(state);
        return loadStepsImpl(state);
      },
      // Stubs: the pass/fail + precheck suites never call issueDelegation. The
      // issueDelegation suites build their own seam via startSeamOnDelegateStep.
      resolveChildRunbook: async () => undefined,
      persistSubstepStates: async () => {},
      findDelegationByToken: async () => undefined,
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

  /**
   * Build a seam wired to issuance deps for an already-activated `state`, with
   * `loadSteps` returning the supplied parsed steps. Returns the mutable `deps`
   * object so a test can swap a dependency mid-run (the seam holds it in private
   * `#deps`).
   */
  function buildIssuanceSeam(
    state: RunbookState,
    steps: readonly ResolvedStep[],
  ): {
    seam: RunbookLifecycleCommandService;
    deps: RunbookLifecycleCommandServiceDependencies & {
      resolveChildRunbook: ResolveChildRunbook;
    };
    manager: RunbookStateManager;
    state: RunbookState;
  } {
    const deps: RunbookLifecycleCommandServiceDependencies & {
      resolveChildRunbook: ResolveChildRunbook;
    } = {
      sessionService,
      actorService,
      lifecycleService,
      completionService,
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: () => steps,
      // Resolve by name so a positional naming a *different* runbook produces a
      // distinct ref (drives the RD-822 mismatch path).
      resolveChildRunbook: async (
        name,
      ): Promise<{ path: string; ref: RunbookRef } | undefined> => ({
        path: name,
        ref: { source: 'project', path: name },
      }),
      persistSubstepStates: async (id, substepStates) => {
        await manager.update(id, { substepStates });
      },
      findDelegationByToken: async (token) =>
        (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
    };
    return { seam: new RunbookLifecycleCommandService(deps), deps, manager, state };
  }

  /**
   * Stand up a real active runbook whose current step `1` has one authored
   * DELEGATE substep `1.1` targeting `child.md`, then build a fresh seam wired
   * to issuance deps.
   */
  async function startSeamOnDelegateStep(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const state = baseState();
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up an active runbook with a reported-but-uncollected delegation
   * outcome on step `1`, so the delegation-issuance policy gate refuses with
   * `delegation_collection_pending` (mirrors the precheck collection-pending
   * fixture). Used to pin refusal-without-mutation.
   */
  async function startSeamWithCollectionPending(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
    const state = baseState({
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
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up a runbook positioned ON the DELEGATE substep `1.1` (so
   * `state.substep` is set), used by the inferred `{ kind: 'active' }` retry.
   */
  async function startSeamOnActiveDelegateSubstep(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [delegateStep('1', [delegateSubstep('1', 'child.md')])];
    const state = baseState({ substep: '1' });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  /**
   * Stand up an active runbook positioned on step `2`, which owns two authored
   * DELEGATE substeps `2.1` and `2.2`. Exercises explicit `--step` targeting.
   */
  async function startSeamOnMultiStepRunbook(): Promise<ReturnType<typeof buildIssuanceSeam>> {
    const steps: readonly ResolvedStep[] = [
      delegateStep('1', [delegateSubstep('1', 'a.md')]),
      delegateStep('2', [delegateSubstep('1', 'b.md'), delegateSubstep('2', 'c.md')]),
    ];
    const state = baseState({
      step: '2',
      stepName: 'Step two',
      frameEntryCounts: { [buildFrameKey('2')]: 1 },
      activeFrameKey: buildFrameKey('2'),
    });
    await activate(state);
    return buildIssuanceSeam(state, steps);
  }

  describe('issueDelegation (fresh)', () => {
    it('refuses an untrusted caller (no actor context) with actor_context_required', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'plugin', agentId: 'a' },
      });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('actor_context_required');
    });

    it('issues a bare delegation and persists the new substep state', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });

      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      expect(outcome.token).toMatch(/^rdtk_/); // DELEGATION_TOKEN_PREFIX === 'rdtk_'
      expect(outcome.parentRunId).toBe(state.id);

      const persisted = await mgr.load(state.id);
      const issued = persisted?.substepStates?.find((s) => s.delegation?.token === outcome.token);
      expect(issued).toBeDefined();
    });

    it('echoes an existing in-flight delegation without re-resolving the child', async () => {
      // `deps` is the SAME mutable object passed to the seam constructor, so
      // reassigning a field here changes what the seam calls. The seam's own
      // field is private (`#deps`), so the test mutates the shared object.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');

      // Make the child unresolvable for the second call; echo must still succeed.
      deps.resolveChildRunbook = async () => undefined;

      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      expect(second.kind).toBe('already-delegated');
      if (second.kind !== 'already-delegated') throw new Error('expected echo');
      expect(second.token).toBe(first.token);
    });

    it('rejects a positional arg that names a different child than the authored target (RD-822)', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep(); // authored child is "child.md"
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        requestedRunbook: 'different.md',
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-822');
    });

    it('refuses a bare issue when the run has pending uncollected outcomes', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamWithCollectionPending();
      const before = await mgr.load(state.id);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });

      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') throw new Error('expected refused');
      expect(outcome.policy.kind).toBe('delegation_collection_pending');

      const after = await mgr.load(state.id);
      expect(after?.substepStates).toEqual(before?.substepStates); // no mutation
    });

    it('issues for an explicit --step target', async () => {
      const { seam: localSeam } = await startSeamOnMultiStepRunbook();
      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        explicitStep: '2.2',
      });
      expect(outcome.kind).toBe('delegated');
      if (outcome.kind !== 'delegated') throw new Error('expected delegated');
      expect(outcome.stepId).toBe('2.2');
    });
  });

  describe('issueDelegation (retry)', () => {
    it('retries a delegation by step locator and mints a fresh token', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'step', step: first.stepId },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.token).not.toBe(first.token);
    });

    it('retries the active substep via { kind: "active" }', async () => {
      const { seam: localSeam } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');
    });

    it('retries by token across runs', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');
      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'token', token: first.token },
      });
      expect(retried.kind).toBe('retried');
    });

    it('returns token-not-found for an unknown token', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const outcome = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'token', token: 'rdtk_unknown00000000000000000000000000' },
      });
      expect(outcome.kind).toBe('token-not-found');
    });
  });

  describe('runTransition refusals', () => {
    const steps: ResolvedStep[] = [
      { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
    ];

    beforeEach(() => {
      loadStepsImpl = () => steps;
    });

    it('returns none when there is no active run', async () => {
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
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
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome.kind).toBe('delegation_collection_pending');
    });

    it('still refuses (does not throw) an explicit-step transition with no active run', async () => {
      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
      });
      expect(outcome).toEqual({ kind: 'none' });
    });

    it('throws when a ready explicit-step transition carries no manual target', async () => {
      await activate(baseState());
      await expect(
        seam.runTransition({
          command: 'pass',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'explicit-step', step: '1.1' },
          terminalPolicy: RELEASE_POLICY,
        }),
      ).rejects.toThrow(/resolved manual target/);
    });

    it('fails closed when the supplied cursor no longer matches the re-resolved run step', async () => {
      // TOCTOU: the frontend resolves and validates the `--step` cursor against a
      // prior snapshot, then the seam re-resolves independently. Here the run is
      // at step '2' but the supplied cursor targets step '1' (resolved before the
      // run advanced) — the seam must refuse rather than record a completion
      // against the abandoned step.
      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');
      await activate(baseState({ step: '2', stepName: 'Step two', substep: '1' }));

      await expect(
        seam.runTransition({
          command: 'pass',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'explicit-step', step: '1.1' },
          terminalPolicy: RELEASE_POLICY,
          manualTarget: {
            step: '1',
            substep: '1',
            frame: activeFrame(buildFrameKey('1'), 1),
            at: '1.1',
          },
        }),
      ).rejects.toThrow(/no longer matches the resolved run's active step/);

      // Fail-closed: no completion was recorded against the wrong unit.
      expect(recordSpy).not.toHaveBeenCalled();
      const persisted = await manager.load(runId);
      expect(persisted?.step).toBe('2');
    });

    it('fails closed when an active-frame cursor entry is stale (frame re-entered after resolution)', async () => {
      // TOCTOU on the active frame's ENTRY (not the step): the frontend resolves
      // an `active`-kind cursor against a prior snapshot (entry 1), then the run
      // re-enters the same frame (GOTO/RETRY bumps the entry to 2) before the seam
      // re-resolves. Recording against the stale entry would persist a
      // resolved-completion row at entry 1 that the entry-filtered drain can never
      // consume — an orphan — and would prematurely flip the substep to `done`.
      // The seam must refuse before any write.
      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '1',
          frameEntryCounts: { [buildFrameKey('1')]: 2 },
          activeFrameKey: buildFrameKey('1'),
          activeEntry: 2,
          substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
        }),
      );

      await expect(
        seam.runTransition({
          command: 'pass',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'explicit-step', step: '1.1' },
          terminalPolicy: RELEASE_POLICY,
          manualTarget: {
            step: '1',
            substep: '1',
            frame: activeFrame(buildFrameKey('1'), 1), // stale entry 1; run is now on entry 2
            at: '1.1',
          },
        }),
      ).rejects.toThrow(/no longer matches the resolved run's active frame/);

      // Fail-closed: no completion recorded, no orphan row persisted, substep not
      // prematurely marked done.
      expect(recordSpy).not.toHaveBeenCalled();
      const persisted = await manager.load(runId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([]);
      expect(persisted?.substepStates).toEqual([
        { id: '1', frameKey: buildFrameKey('1'), status: 'running' },
      ]);
    });

    it('does not over-tighten: an inactive-frame (deliberate non-active) cursor is not refused by the frame guard', async () => {
      // A deliberate `--step`/`--index` target of a non-active substep/iteration is
      // encoded by the frontend as an `inactive` frame (frame-only, sentinel
      // entry). The active-frame TOCTOU guard must NOT fire for it — only the
      // active-frame identity is re-validated. Drive is mocked so this isolates the
      // guard decision: the call reaches recordManualCompletion rather than
      // throwing the active-frame mismatch.
      const recordSpy = jest
        .spyOn(completionService, 'recordManualCompletion')
        .mockResolvedValue({ status: 'recorded', key: 'k' });
      jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
        status: 'not_active',
        frameKey: buildFrameKey('1', 5),
        activeFrameKey: buildFrameKey('1'),
        unresolved: 1,
        applied: [],
      });
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
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        manualTarget: {
          step: '1',
          substep: '1',
          iteration: 5,
          frame: inactiveFrame(buildFrameKey('1', 5)), // deliberate non-active iteration
          at: '1.5.1',
        },
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe('applied');
    });
  });

  describe('top-level transition drive', () => {
    it('applies a PASS CONTINUE and instructs the loop to continue', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
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
      loadStepsImpl = () => steps;
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
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
      loadStepsImpl = () => steps;
      await activate(baseState());

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
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
      loadStepsImpl = () => steps;
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

    it('treats an explicit cursor for an already-advanced sibling substep as an idempotent duplicate (no orphan row)', async () => {
      // TOCTOU within the same active frame: the frontend resolved `--step 1.1`
      // against a snapshot where substep '1' was active, but the run advanced to
      // sibling substep '2' (frame key + entry unchanged) before the seam ran.
      // The explicit cursor's active frame still matches the run's active frame,
      // so the frame guard does not fire; the completion-service duplicate guard
      // (substep '1' already `done`) makes this a graceful no-op rather than an
      // orphaned resolved-completion / premature `done` write.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [
            { id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') },
            { id: '2', description: 'B', transitions: tx('CONTINUE', 'STOP') },
          ],
          transitions: tx('CONTINUE', 'STOP'),
        },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(
        baseState({
          step: '1',
          stepName: 'Substeps',
          substep: '2',
          substepStates: [
            { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
            { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
          ],
        }),
      );

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        manualTarget: {
          step: '1',
          substep: '1',
          frame: activeFrame(buildFrameKey('1'), 1),
          at: '1.1',
        },
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      // Idempotent: surfaced as already-resolved, not an advance.
      expect(outcome.duplicate?.at).toBe('1.1');
      expect(outcome.updatedState).toBeUndefined();

      // No orphan row was written and the run did not move.
      const persisted = await manager.load(runId);
      expect(Object.keys(persisted?.resolvedCompletions ?? {})).toEqual([]);
      expect(persisted?.substep).toBe('2');
      expect(persisted?.substepStates).toEqual([
        { id: '1', frameKey: buildFrameKey('1'), status: 'done', result: 'pass' },
        { id: '2', frameKey: buildFrameKey('1'), status: 'running' },
      ]);
    });

    it('emits a terminal event when the drain reaches terminal but the completion observation did not', async () => {
      // Divergence the seam must handle: `drainResolvedCompletions` derives
      // terminal from the applied completion's `state.lifecycle`, while
      // `deriveTransitionObservation` derives it from the XState snapshot's
      // top-level status/value. Force the drain to report `done` for an applied
      // completion whose snapshot is still active — the per-completion
      // observation returns `continue` (STEP_TRANSITIONED only), so the seam must
      // emit RUNBOOK_COMPLETED from the drain's authoritative status. Without the
      // fix the run is released but the outcome carries no terminal envelope.
      const steps: ResolvedStep[] = [
        {
          kind: 'substeps',
          name: '1',
          description: 'Substeps',
          aggregation: { strategy: 'ALL' },
          substeps: [{ id: '1', description: 'A', transitions: tx('CONTINUE', 'STOP') }],
          transitions: tx('CONTINUE', 'STOP'),
        },
      ];
      loadStepsImpl = () => steps;
      const activeState = baseState({
        step: '1',
        stepName: 'Substeps',
        substep: '1',
        substepStates: [{ id: '1', frameKey: buildFrameKey('1'), status: 'running' }],
      });
      await activate(activeState);

      // Record succeeds; the divergence lives entirely in the drain result.
      jest
        .spyOn(completionService, 'recordManualCompletion')
        .mockResolvedValue({ status: 'recorded', key: 'k' });

      const built = buildResolvedCompletion({
        agentId: 'manual',
        result: 'pass',
        targetStep: '1',
        targetSubstep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
        completedAt: '2026-06-28T00:00:00.000Z',
      });
      // `buildResolvedCompletion` widens `targetSubstep` to `string | undefined`;
      // re-narrow it (the value is known) so the branded-current-cursor helper,
      // which requires a concrete `targetSubstep`, accepts it without a cast.
      const terminalCompletion = brandCurrentCursorResolvedCompletionForTest({
        ...built,
        targetSubstep: built.targetSubstep ?? '1',
      });
      jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
        status: 'done',
        unresolved: 0,
        applied: [
          {
            key: 'k',
            completion: terminalCompletion,
            stateBefore: activeState,
            // Terminal via `state.lifecycle` only — the snapshot stays active so
            // `deriveTransitionObservation` reports `continue`.
            stateAfter: { ...activeState, lifecycle: 'completed' },
            snapshot: { status: 'active', value: '1' },
          },
        ],
      });

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(outcome.loop).toEqual({ kind: 'none' });
      // The STEP_TRANSITIONED from the continue observation AND the terminal
      // envelope derived from the drain's authoritative status.
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_COMPLETED')).toBe(true);
    });
  });

  describe('bare inline-child reactivation', () => {
    const childRunId = assertRunId('rd_22222222222222222222222222222222');

    const inlineSteps: ResolvedStep[] = [
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

    beforeEach(() => {
      loadStepsImpl = () => inlineSteps;
    });

    // Parent parked at substep 1 whose substep state is running with inline-child
    // launch metadata. `withInline` lets a test drop the inline metadata to model
    // "no running inline child" while keeping the running substep.
    function parentAtSubstep(withInline = true): RunbookState {
      const frameKey = buildFrameKey('1');
      const parent = baseState({
        step: '1',
        stepName: 'Substeps',
        substep: '1',
        activeFrameKey: frameKey,
        activeEntry: 1,
      });
      const inline: NonNullable<SubstepState['inline']> = {
        childRunbookPath: 'child.runbook.md',
        childRunbookRef: { source: 'project', path: 'child.runbook.md' },
        contextSnapshot: buildContextSnapshot(parent, '1'),
        childRunId,
        createdAt: '2026-06-28T00:00:00.000Z',
        startedAt: '2026-06-28T00:00:01.000Z',
      };
      const substepState: SubstepState = {
        id: '1',
        frameKey,
        status: 'running',
        ...(withInline ? { inline } : {}),
      };
      return { ...parent, substepStates: [substepState] };
    }

    // Running inline child whose linkage matches the parent cursor by default.
    function childState(linkage: Partial<InlineLinkage> = {}): RunbookState {
      return baseState({
        id: childRunId,
        runbook: { source: 'project', path: 'child.runbook.md' },
        runbookPath: 'child.runbook.md',
        lifecycle: 'running',
        parentLinkage: {
          kind: 'inline',
          parentRunId: runId,
          parentStep: '1',
          parentStepId: '1',
          parentFrameKey: buildFrameKey('1'),
          parentEntry: 1,
          ...linkage,
        },
      });
    }

    it('resumes the running inline child instead of recording a completion', async () => {
      await manager.save(childState());
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      // No manual completion recorded; the parent did not change; the child is
      // now the active run.
      expect(outcome).toEqual({
        kind: 'applied',
        runId,
        mutation: 'manual-completion',
        terminalReleaseMode: 'stack-pop',
        status: 'continue',
        events: [],
        loop: { kind: 'none' },
      });
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledWith(childRunId);
      expect(recordSpy).not.toHaveBeenCalled();
    });

    it('records a completion when there is no running inline child', async () => {
      await activate(parentAtSubstep(false));

      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.updatedState?.step).toBe('2');
    });

    it('records a completion when the running child linkage does not match the parent cursor', async () => {
      // Linkage points at a different parent entry, so it is not the inline child
      // of this cursor: the seam must record, not reactivate.
      await manager.save(childState({ parentEntry: 2 }));
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');

      await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).not.toHaveBeenCalledWith(childRunId);
    });

    it('never reactivates on the explicit --step path (always records)', async () => {
      await manager.save(childState());
      await activate(parentAtSubstep());

      const pushSpy = jest.spyOn(sessionService, 'pushRunbook');
      const recordSpy = jest.spyOn(completionService, 'recordManualCompletion');

      await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'explicit-step', step: '1.1' },
        terminalPolicy: RELEASE_POLICY,
        manualTarget: {
          step: '1',
          substep: '1',
          frame: activeFrame(buildFrameKey('1'), 1),
          at: '1.1',
        },
      });

      expect(recordSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).not.toHaveBeenCalledWith(childRunId);
    });
  });

  describe('single-resolution loadSteps', () => {
    it('derives steps exactly once from the resolved active state', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('CONTINUE', 'STOP') },
        { kind: 'base', name: '2', description: 'two', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());

      await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      // The seam resolves the target once and derives steps once from that
      // resolved state — the observable proxy for single resolution.
      expect(loadStepsArgs).toHaveLength(1);
      expect(loadStepsArgs[0]?.id).toBe(runId);
    });

    it('derives steps for the claimed child run, not the active default', async () => {
      const parentRunId = assertRunId('rd_44444444444444444444444444444444');
      const claimChildRunId = assertRunId('rd_33333333333333333333333333333333');
      const childSteps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'child one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => childSteps;

      await manager.save(baseState({ id: parentRunId }));
      await sessionService.pushRunbook(parentRunId);
      await manager.save(
        baseState({
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' },
          runbookPath: 'claim-child.md',
          parentLinkage: linkageFor(parentRunId, 'a'),
        }),
      );
      const claimed = assertClaimed(
        await sessionService.claimRunbook(claimChildRunId, linkageFor(parentRunId, 'a')),
      );

      await seam.runTransition({
        command: 'pass',
        callerEvidence: {
          kind: 'claim',
          claimId: claimed.claim.claimId,
          tokenHash: claimed.claim.tokenHash,
          controlledRunId: claimChildRunId,
        },
        targetSelector: { kind: 'claim', claimId: claimed.claim.claimId },
        terminalPolicy: RELEASE_POLICY,
      });

      // loadSteps saw the resolved claimed child, not the active default parent.
      expect(loadStepsArgs).toHaveLength(1);
      expect(loadStepsArgs[0]?.id).toBe(claimChildRunId);
    });
  });
});
