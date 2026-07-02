import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ResolvedStep,
  ResolvedStepWithFor,
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
  assertClaimId,
  assertRunId,
  brandCurrentCursorResolvedCompletionForTest,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  inactiveFrame,
  replaceSubstepStateEntry,
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

/** Build a FOR step that owns one or more authored DELEGATE substeps. */
function delegateForStep(name: string, substeps: readonly Substep[]): ResolvedStepWithFor {
  return {
    kind: 'for',
    name,
    description: `FOR step ${name}`,
    transitions: SUBSTEP_TRANSITIONS,
    forClause: { variable: 'i', start: 1, end: 10 },
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
      persistIssuedSubstep: async () => {},
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
      persistIssuedSubstep: async (id, entry) => {
        await manager.updateWithState(id, (fresh) => ({
          substepStates: replaceSubstepStateEntry(fresh.substepStates ?? [], entry),
        }));
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
   * Stand up a runbook positioned ON the DELEGATE substep `1.1` within an active
   * FOR iteration (iteration 2). Used to pin that the inferred
   * `{ kind: 'active' }` retry surfaces the iteration-qualified label (`1.2.1`).
   */
  async function startSeamOnActiveForIterationSubstep(): Promise<
    ReturnType<typeof buildIssuanceSeam>
  > {
    const steps: readonly ResolvedStep[] = [
      delegateForStep('1', [delegateSubstep('1', 'child.md')]),
    ];
    const iterationFrameKey = buildFrameKey('1', 2);
    const state = baseState({
      substep: '1',
      activeFrameKey: iterationFrameKey,
      frameEntryCounts: { [iterationFrameKey]: 1 },
      forStack: [
        { stepId: '1', iteration: 2, start: 1, end: 2, implicit: false, source: { kind: 'range' } },
      ],
    });
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

    it('returns the canonical persisted child ref (not the authored alias) and matches the echo', async () => {
      // The authored substep targets "child.md"; resolve it to a DIFFERENT
      // canonical path so returning the authored alias is observably wrong.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      deps.resolveChildRunbook = async (): Promise<{ path: string; ref: RunbookRef }> => ({
        path: 'runbooks/child.md',
        ref: { source: 'project', path: 'runbooks/child.md' },
      });

      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      expect(fresh.kind).toBe('delegated');
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');
      // Canonical ref, not the authored "child.md" alias.
      expect(fresh.runbookRef).toBe('runbooks/child.md');

      // Echo of the same delegation must surface the identical ref.
      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      expect(echo.kind).toBe('already-delegated');
      if (echo.kind !== 'already-delegated') throw new Error('expected echo');
      expect(echo.runbookRef).toBe(fresh.runbookRef);
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

    it('refuses a positional confirmation (requestedRunbook, no --step) when collection is pending', async () => {
      // A positional `rd delegate <child>` names the authored child as a
      // confirmation of the already-pending delegate substep; it is NOT a
      // step-target, so it stays `targeted: false` and remains subject to the
      // collection-pending gate (regression guard: a stray `|| requestedRunbook`
      // in the seam's `targeted` computation bypassed this).
      const { seam: localSeam, manager: mgr, state } = await startSeamWithCollectionPending();
      const before = await mgr.load(state.id);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        requestedRunbook: 'child.md', // matches the authored child (no RD-822)
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

    it('resolves extraVars exactly once on the issuable path', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const resolveExtraVars = jest.fn(async () => ({ environment: 'staging' }) as const);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        resolveExtraVars,
      });

      expect(outcome.kind).toBe('delegated');
      expect(resolveExtraVars).toHaveBeenCalledTimes(1);
    });

    it('never resolves extraVars on the echo path', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected first delegated');

      const resolveExtraVars = jest.fn(async () => undefined);
      const second = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        resolveExtraVars,
      });

      expect(second.kind).toBe('already-delegated');
      expect(resolveExtraVars).not.toHaveBeenCalled();
    });

    it('records the explicit --index iteration in the delegation context snapshot (not the live FOR iteration)', async () => {
      // A fresh `--step 1.1 --index 2` against a FOR step whose LIVE iteration is
      // 1 must capture iteration 2 in the persisted context snapshot. The frame
      // key already scopes the substep entry to `1|2`; the snapshot's `index`/`at`
      // must agree, or the claimed child inherits the wrong `Index`. (Regression:
      // the seam passed a step id WITHOUT the iteration segment to
      // createDelegation, so the snapshot iteration fell back to the live one.)
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam, manager: mgr } = buildIssuanceSeam(state, steps);

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        explicitStep: '1.1',
        explicitIteration: 2,
      });
      expect(outcome.kind).toBe('delegated');

      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.frameKey === buildFrameKey('1', 2));
      expect(entry).toBeDefined();
      expect(entry?.delegation?.contextSnapshot.index).toBe(2);
      expect(entry?.delegation?.contextSnapshot.at).toBe('1.2.1');
    });

    it('positional no-step over an auto-issued frontier echoes the existing token (was RD-813)', async () => {
      // #496: `rd delegate child.md` (positional, no --step) after the frontier
      // was already issued must echo the in-flight token — parity with the bare
      // form — instead of exhausting the frontier scan into a thrown RD-813.
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      const echo = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        requestedRunbook: 'child.md',
      });
      expect(echo.kind).toBe('already-delegated');
      if (echo.kind !== 'already-delegated') throw new Error('expected echo');
      expect(echo.token).toBe(fresh.token);
      expect(echo.stepId).toBe(fresh.stepId);
    });

    it('positional no-step naming a different runbook than the in-flight one errors RD-804', async () => {
      const { seam: localSeam } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        requestedRunbook: 'other.md',
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-804'); // DELEGATION_ALREADY_EXISTS
    });

    it('refuses an explicit --step re-issue over a claimed delegation (RD-811) without re-minting', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnDelegateStep();
      const fresh = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (fresh.kind !== 'delegated') throw new Error('expected delegated');

      // A child claimed the token: persist the linkage on the delegation.
      const childRunId = assertRunId('rd_22222222222222222222222222222222');
      await mgr.updateWithState(state.id, (current) => ({
        substepStates: (current.substepStates ?? []).map((entry) =>
          entry.delegation?.token === fresh.token
            ? { ...entry, delegation: { ...entry.delegation, token: undefined, childRunId } }
            : entry,
        ),
      }));

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        explicitStep: '1.1',
      });
      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-811'); // DELEGATION_ALREADY_CLAIMED

      // The persisted delegation is untouched: same tokenHash, same claim.
      const persisted = await mgr.load(state.id);
      const entry = persisted?.substepStates?.find((s) => s.id === '1');
      expect(entry?.delegation?.tokenHash).toBe(fresh.tokenHash);
      expect(entry?.delegation?.childRunId).toBe(childRunId);
    });

    it('preserves a concurrent substep write landing between the active-state read and the issuance persist', async () => {
      // Last-write-wins guard: the seam reads the active state, computes the new
      // substep array, then persists. A concurrent writer that commits an
      // unrelated substep entry in that gap must NOT be clobbered — the persist
      // merges only the affected entry under a locked read-modify-write.
      const steps: readonly ResolvedStep[] = [
        delegateStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const state = baseState();
      await activate(state);
      const { seam: localSeam, deps, manager: mgr } = buildIssuanceSeam(state, steps);

      // The concurrent write is injected via resolveChildRunbook, which the seam
      // invokes on the issuable path AFTER its active-state read and BEFORE the
      // issuance persist.
      const concurrentEntry: SubstepState = {
        id: '2',
        frameKey: buildFrameKey('1'),
        status: 'running',
      };
      let injected = false;
      deps.resolveChildRunbook = async (name): Promise<{ path: string; ref: RunbookRef }> => {
        if (!injected) {
          injected = true;
          await mgr.updateWithState(state.id, (fresh) => ({
            substepStates: [...(fresh.substepStates ?? []), concurrentEntry],
          }));
        }
        return { path: name, ref: { source: 'project', path: name } };
      };

      const outcome = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      expect(outcome.kind).toBe('delegated');

      const persisted = await mgr.load(state.id);
      // The concurrent substep survives the issuance persist...
      expect(persisted?.substepStates?.find((s) => s.id === '2')).toEqual(concurrentEntry);
      // ...and the freshly issued delegation is present.
      expect(persisted?.substepStates?.find((s) => s.id === '1')?.delegation).toBeDefined();
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

    it('preserves the FOR iteration in the active retry label', async () => {
      const { seam: localSeam } = await startSeamOnActiveForIterationSubstep();
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
      if (retried.kind !== 'retried') throw new Error('expected retried');
      // Iteration-qualified label, not a bare "1.1".
      expect(retried.stepLabel).toBe('1.2.1');
    });

    it('canonicalizes the step-form retry label to include the FOR iteration', async () => {
      // A `--retry --step 1.1 --index 2` must surface the iteration-qualified
      // label `1.2.1`, matching the token/active retry forms — not the bare
      // `1.1` (which drops the resolved frame's iteration).
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        explicitStep: '1.1',
        explicitIteration: 2,
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'step', step: '1.1', iteration: 2 },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.stepLabel).toBe('1.2.1');
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

    it('rejects a token retry whose snapshot is missing `at` (fail closed, no legacy reconstruction)', async () => {
      // A persisted context snapshot ALWAYS records `at` (buildContextSnapshot
      // derives it unconditionally via deriveExecutionAt). A snapshot missing
      // `at` is an incompatible/older persisted shape; per the no-migration rule
      // the retry must fail closed (RD-817) rather than reconstruct a `1.x`
      // label from `substep`/`stepId`.
      const { seam: localSeam, deps } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Resolve the real scan, then strip `at` to emulate an incompatible
      // snapshot. `findDelegationByToken` is a readonly dep, so swap it by
      // constructing a fresh seam over the same deps rather than mutating.
      const realScan = await new DelegationScanService(manager).findByToken(first.token);
      if (!realScan) throw new Error('expected scan');
      const { at: _at, ...snapshotWithoutAt } = realScan.delegation.contextSnapshot;
      const localSeamStale = new RunbookLifecycleCommandService({
        ...deps,
        findDelegationByToken: async () => ({
          ...realScan,
          delegation: { ...realScan.delegation, contextSnapshot: snapshotWithoutAt },
        }),
      });

      const outcome = await localSeamStale.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'token', token: first.token },
      });

      expect(outcome.kind).toBe('error');
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(outcome.error.code).toBe('RD-817');
    });

    it('surfaces the canonical snapshot `at` as the token-retry label (FOR iteration)', async () => {
      // A token retry whose snapshot records `at` = "1.2.1" (a FOR iteration)
      // must surface that canonical label, not the bare step.
      const steps: readonly ResolvedStep[] = [
        delegateForStep('1', [delegateSubstep('1', 'child.md')]),
      ];
      const activeFrameKey = buildFrameKey('1', 1);
      const state = baseState({
        activeFrameKey,
        frameEntryCounts: { [activeFrameKey]: 1 },
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 2,
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      await activate(state);
      const { seam: localSeam } = buildIssuanceSeam(state, steps);

      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
        explicitStep: '1.1',
        explicitIteration: 2,
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'token', token: first.token },
      });
      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      expect(retried.stepLabel).toBe('1.2.1');
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

    it('token retry targets the scan-resolved parent run, not the (different) active run', async () => {
      // Issue a delegation, then activate a SECOND run on top so `getActive()`
      // resolves to the new run. A token retry must resolve its target from the
      // scan result's parent (the issuing run) — exercising the `scan.parentState`
      // branch rather than `getActive()`.
      const { seam: localSeam, state: issuingRun } = await startSeamOnDelegateStep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Activate an unrelated second run so it shadows the issuing run as active.
      const secondRunId = assertRunId('rd_55555555555555555555555555555555');
      await manager.save(
        baseState({
          id: secondRunId,
          runbook: { source: 'project', path: 'other.md' },
          runbookPath: 'other.md',
        }),
      );
      await sessionService.pushRunbook(secondRunId);
      expect((await sessionService.getActive())?.id).toBe(secondRunId);

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'token', token: first.token },
      });

      expect(retried.kind).toBe('retried');
      if (retried.kind !== 'retried') throw new Error('expected retried');
      // The retry committed against the issuing run, not the active second run.
      expect(retried.parentRunId).toBe(issuingRun.id);
      expect(retried.parentRunId).not.toBe(secondRunId);
      expect(retried.token).not.toBe(first.token);
    });

    it('consumes the pending delegation outcome row for the retried substep', async () => {
      const { seam: localSeam, manager: mgr, state } = await startSeamOnActiveDelegateSubstep();
      const first = await localSeam.issueDelegation({
        mode: 'fresh',
        callerEvidence: { kind: 'direct_cli' },
      });
      if (first.kind !== 'delegated') throw new Error('expected delegated');

      // Simulate a reported+aborted attempt: a pending delegation outcome row for
      // the active substep, with the substep mirrored done/fail (as abort --force
      // records).
      const frameKey = buildFrameKey('1');
      const key = buildCompletionKey(activeFrame(frameKey, 1), '1');
      const persisted = await mgr.load(state.id);
      if (!persisted) throw new Error('expected persisted state');
      await mgr.save({
        ...persisted,
        substepStates: (persisted.substepStates ?? []).map((ss) =>
          ss.id === '1' && ss.frameKey === frameKey
            ? { ...ss, status: 'done' as const, result: 'fail' as const }
            : ss,
        ),
        resolvedCompletions: {
          ...(persisted.resolvedCompletions ?? {}),
          [key]: buildResolvedCompletion({
            agentId: 'delegation',
            result: 'fail',
            targetStep: '1',
            targetSubstep: '1',
            targetFrame: activeFrame(frameKey, 1),
            completedAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      });

      const retried = await localSeam.issueDelegation({
        mode: 'retry',
        callerEvidence: { kind: 'direct_cli' },
        locator: { kind: 'active' },
      });
      expect(retried.kind).toBe('retried');

      const after = await mgr.load(state.id);
      expect(after?.resolvedCompletions?.[key]).toBeUndefined();
      expect(Object.keys(after?.resolvedCompletions ?? {})).toHaveLength(0);
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

  describe('terminal release side effects', () => {
    // `#applyTerminalSideEffects` is the seam-owned terminal release: on a
    // terminal `done`/`stopped` it calls `sessionService.releaseRunbook(runId,
    // { retainClaimsAsTerminal: true })`, gated per-status by the terminal
    // policy (`onComplete` for `done`, `onStopped` for `stopped`). These pin that
    // the release fires with the exact args on each status, that the per-status
    // `releaseRunbook: false` opt-out suppresses it, and that the two statuses
    // route through their own policy branch (a `false` on the *other* branch must
    // not leak).

    it('releases the runbook with retainClaimsAsTerminal on a terminal done (onComplete branch)', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(runId, { retainClaimsAsTerminal: true });
    });

    it('releases the runbook with retainClaimsAsTerminal on a terminal stopped (onStopped branch)', async () => {
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledWith(runId, { retainClaimsAsTerminal: true });
    });

    it('does not release a terminal done when onComplete opts out (releaseRunbook: false)', async () => {
      // Split policy: `done` reads `onComplete` (false here) and must NOT release,
      // even though `onStopped` is true — proving `done` routes through its own
      // branch rather than reading `onStopped`.
      const policy: LifecycleTerminalReleasePolicy = {
        onComplete: { releaseRunbook: false },
        onStopped: { releaseRunbook: true },
      };
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: policy,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('done');
      expect(releaseSpy).not.toHaveBeenCalled();
    });

    it('does not release a terminal stopped when onStopped opts out (releaseRunbook: false)', async () => {
      // Mirror of the done opt-out: `stopped` reads `onStopped` (false here) and
      // must NOT release, even though `onComplete` is true — proving `stopped`
      // routes through its own branch rather than reading `onComplete`.
      const policy: LifecycleTerminalReleasePolicy = {
        onComplete: { releaseRunbook: true },
        onStopped: { releaseRunbook: false },
      };
      const steps: ResolvedStep[] = [
        { kind: 'base', name: '1', description: 'one', transitions: tx('STOP', 'STOP') },
      ];
      loadStepsImpl = () => steps;
      await activate(baseState());
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');

      const outcome = await seam.runTransition({
        command: 'pass',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: policy,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(releaseSpy).not.toHaveBeenCalled();
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

    it('emits a terminal stopped event when the drain reaches stopped but the completion observation did not', async () => {
      // The `stopped` mirror of the `done` divergence above. The drain reports
      // `stopped` (derived from the applied completion's `state.lifecycle`) for an
      // applied completion whose snapshot is still active, so the per-completion
      // observation returns `continue` (STEP_TRANSITIONED only). The seam must emit
      // RUNBOOK_STOPPED from the drain's authoritative status via
      // `deriveTerminalDrainObservationEvent` and apply the seam-owned terminal
      // release through the `onStopped` branch.
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
        result: 'fail',
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
      const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
      jest.spyOn(completionService, 'drainResolvedCompletions').mockResolvedValue({
        status: 'stopped',
        unresolved: 0,
        applied: [
          {
            key: 'k',
            completion: terminalCompletion,
            stateBefore: activeState,
            // Terminal via `state.lifecycle` only — the snapshot stays active so
            // `deriveTransitionObservation` reports `continue`.
            stateAfter: { ...activeState, lifecycle: 'stopped' },
            snapshot: { status: 'active', value: '1' },
          },
        ],
      });

      const outcome = await seam.runTransition({
        command: 'fail',
        callerEvidence: DIRECT_CLI,
        targetSelector: { kind: 'default' },
        terminalPolicy: RELEASE_POLICY,
      });

      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      expect(outcome.status).toBe('stopped');
      expect(outcome.loop).toEqual({ kind: 'none' });
      // The STEP_TRANSITIONED from the continue observation AND the stopped
      // terminal envelope derived from the drain's authoritative status.
      expect(outcome.events.some((e) => e.type === 'STEP_TRANSITIONED')).toBe(true);
      expect(outcome.events.some((e) => e.type === 'RUNBOOK_STOPPED')).toBe(true);
      // The drain-stopped exit applies the seam-owned terminal release.
      expect(releaseSpy).toHaveBeenCalledWith(runId, { retainClaimsAsTerminal: true });
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

  describe('runTerminal', () => {
    it('rejects an explicit-step selector', async () => {
      await expect(
        seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'explicit-step', step: '1.1' },
        }),
      ).rejects.toThrow(/do not support --step/);
    });

    describe('claim path', () => {
      const claimParentRunId = assertRunId('rd_55555555555555555555555555555555');
      const claimChildRunId = assertRunId('rd_66666666666666666666666666666666');

      // Stand up a running parent + claimed child, then optionally overwrite the
      // child to a terminal tombstone lifecycle (claimRunbook refuses claiming a
      // terminal child, so the claim must land while the child is still running).
      async function setupClaim(childLifecycle: RunbookState['lifecycle']) {
        await manager.save(baseState({ id: claimParentRunId }));
        await sessionService.pushRunbook(claimParentRunId);
        const childBase = {
          id: claimChildRunId,
          runbook: { source: 'project', path: 'claim-child.md' } as const,
          runbookPath: 'claim-child.md',
          parentLinkage: linkageFor(claimParentRunId, 'a'),
        };
        await manager.save(baseState(childBase));
        const claimed = assertClaimed(
          await sessionService.claimRunbook(claimChildRunId, linkageFor(claimParentRunId, 'a')),
        );
        if (childLifecycle !== 'running') {
          await manager.save(baseState({ ...childBase, lifecycle: childLifecycle }));
        }
        return claimed.claim.claimId;
      }

      it('forwards a stale_claim for a non-existent claim without dispatching', async () => {
        // A claim id that was never claimed resolves as `missing` in the resolver,
        // which the seam forwards as `stale_claim`. Pins the wiring branch and that
        // no FORCE is dispatched for an unresolved claim target.
        const missingClaimId = assertClaimId('rdclm_0000000000000000000000');
        const sendSpy = jest.spyOn(actorService, 'sendAndSync');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'claim', claimId: missingClaimId },
        });
        expect(out).toMatchObject({ kind: 'stale_claim', claimId: missingClaimId });
        expect(sendSpy).not.toHaveBeenCalled();
      });

      it('claim complete on a completed child confirms and retains the tombstone', async () => {
        const claimId = await setupClaim('completed');
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out.kind).toBe('terminal_claim_confirmed');
        // Idempotent path STILL releases with retain (item 4, second site).
        expect(releaseSpy).toHaveBeenCalledWith(claimChildRunId, { retainClaimsAsTerminal: true });
      });

      it('claim complete on a stopped child conflicts (no FORCE, still retains)', async () => {
        const claimId = await setupClaim('stopped');
        const sendSpy = jest.spyOn(actorService, 'sendAndSync');
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbook');
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out.kind).toBe('terminal_claim_conflict');
        expect(sendSpy).not.toHaveBeenCalled();
        expect(releaseSpy).toHaveBeenCalledWith(claimChildRunId, { retainClaimsAsTerminal: true });
      });

      it('claim stop on a running child forces FAIL, records before release, derives outcome', async () => {
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const order: string[] = [];
        const recordSpy = jest
          .spyOn(completionService, 'recordChildCompletion')
          .mockImplementation(async () => {
            order.push('record');
            return 'recorded';
          });
        const releaseSpy = jest
          .spyOn(sessionService, 'releaseRunbook')
          .mockImplementation(async () => {
            order.push('release');
            return {
              status: 'released',
              runbookId: claimChildRunId,
              removedFromDefaultStack: false,
              nextDefaultRunbookId: null,
            };
          });
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'claim', claimId },
        });
        expect(out).toMatchObject({ kind: 'applied_claim', status: 'stopped' });
        // Record BEFORE release (decision #4).
        expect(order).toEqual(['record', 'release']);
        // recordChildCompletion called with NO explicit result (core derives fail).
        expect(recordSpy).toHaveBeenCalledWith({
          childState: expect.objectContaining({ id: claimChildRunId }),
        });
        expect(releaseSpy).toHaveBeenCalledWith(claimChildRunId, { retainClaimsAsTerminal: true });
      });

      it('claim complete on a running child dispatches FORCE_COMPLETE and forwards the message', async () => {
        const claimId = await setupClaim('running');
        loadStepsImpl = () => [
          {
            kind: 'base',
            name: '1',
            description: 'child one',
            transitions: tx('COMPLETE', 'STOP'),
          },
        ];
        const realSend = actorService.sendAndSync.bind(actorService);
        const sendSpy = jest
          .spyOn(actorService, 'sendAndSync')
          .mockImplementation(async (id, steps, ev) => realSend(id, steps, ev));
        jest.spyOn(sessionService, 'releaseRunbook').mockResolvedValue({
          status: 'released',
          runbookId: claimChildRunId,
          removedFromDefaultStack: false,
          nextDefaultRunbookId: null,
        });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'claim', claimId },
          message: 'wrap up',
        });

        // complete → FORCE_COMPLETE (not FORCE_STOP), status derived completed.
        expect(out).toMatchObject({ kind: 'applied_claim', status: 'completed' });
        // The message is forwarded into the FORCE event (not dropped).
        expect(sendSpy).toHaveBeenCalledWith(claimChildRunId, expect.anything(), {
          type: 'FORCE_COMPLETE',
          message: 'wrap up',
        });
      });
    });

    describe('bare path', () => {
      const ROOT = assertRunId('rd_77777777777777777777777777777777');
      const CHILD = assertRunId('rd_88888888888888888888888888888888');

      // A root state carrying a reported-but-uncollected delegation outcome, i.e.
      // collection pending (mirrors command-policy.test.ts stateWithReportedOutcome).
      function collectionPendingState(id: RunbookState['id']): RunbookState {
        const completionKey = buildCompletionKey(activeFrame(buildFrameKey('1'), 1), '1');
        return baseState({
          id,
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
      }

      // Build and install a synthetic resolved plan on the spied session method.
      function installResolvedPlan(target: RunbookState, forceOrder: readonly RunbookState[]) {
        const releaseRunIds = forceOrder.map((s) => s.id);
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'resolved',
          kind: 'complete',
          activeState: forceOrder[0] ?? target,
          targetState: target,
          descendantStates: forceOrder.filter((s) => s.id !== target.id),
          forceOrder,
          releaseRunIds,
        });
      }

      it('bare complete refuses actor_context_required when caller evidence is unknown', async () => {
        installResolvedPlan(baseState({ id: ROOT }), [baseState({ id: ROOT })]);
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: { kind: 'unknown' },
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({ kind: 'actor_context_required', targetRunId: ROOT });
      });

      it('bare stop refuses when the resolved root is collection pending (item 8)', async () => {
        const root = collectionPendingState(ROOT);
        installResolvedPlan(root, [root]);
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out.kind).toBe('delegation_collection_pending');
      });

      it('bare complete forces the chain descendant-to-root and records the root before release', async () => {
        const childState = baseState({ id: CHILD });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        const order: string[] = [];
        const realSend = actorService.sendAndSync.bind(actorService);
        jest.spyOn(actorService, 'sendAndSync').mockImplementation(async (id, steps, ev) => {
          order.push(`force:${id === ROOT ? 'ROOT' : 'CHILD'}`);
          return realSend(id, steps, ev);
        });
        jest.spyOn(completionService, 'recordChildCompletion').mockImplementation(async () => {
          order.push('record');
          return 'not-applicable';
        });
        const releaseDescendantsSpy = jest
          .spyOn(sessionService, 'releaseRunbooks')
          .mockImplementation(async () => {
            order.push('release-descendants');
            return { releasedRunIds: [CHILD], nextDefaultRunbookId: null };
          });
        const releaseRootSpy = jest
          .spyOn(sessionService, 'releaseRunbook')
          .mockImplementation(async () => {
            order.push('release-root');
            return {
              status: 'released',
              runbookId: ROOT,
              removedFromDefaultStack: false,
              nextDefaultRunbookId: null,
            };
          });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({ kind: 'applied_bare', rootRunId: ROOT, status: 'completed' });
        expect(order).toEqual([
          'force:CHILD',
          'force:ROOT',
          'record',
          'release-descendants',
          'release-root',
        ]);
        // Root released WITH retain; descendants WITHOUT.
        expect(releaseRootSpy).toHaveBeenCalledWith(ROOT, { retainClaimsAsTerminal: true });
        expect(releaseDescendantsSpy).toHaveBeenCalledWith([CHILD]);
      });

      it('bare stop maps a non-running resolved root to already_terminal', async () => {
        const root = baseState({ id: ROOT, lifecycle: 'completed' });
        installResolvedPlan(root, [root]);
        const releaseSpy = jest.spyOn(sessionService, 'releaseRunbooks');
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({
          kind: 'already_terminal',
          targetRunId: ROOT,
          lifecycle: 'completed',
        });
        expect(releaseSpy).toHaveBeenCalled();
      });

      it('bare stop maps an already-stopped resolved root to already_terminal (stopped)', async () => {
        // Pins the `lifecycle === 'stopped' ? 'stopped' : 'completed'` arm that the
        // completed-root test above never reaches.
        const root = baseState({ id: ROOT, lifecycle: 'stopped' });
        installResolvedPlan(root, [root]);
        const out = await seam.runTerminal({
          command: 'stop',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toEqual({ kind: 'already_terminal', targetRunId: ROOT, lifecycle: 'stopped' });
      });

      it('skips a non-running descendant in the force loop but still forces the root', async () => {
        // A descendant already terminal (lifecycle !== 'running') is skipped by the
        // in-loop guard; pins `if (state.lifecycle !== 'running') continue;`.
        const childState = baseState({ id: CHILD, lifecycle: 'completed' });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        const forced: string[] = [];
        const realSend = actorService.sendAndSync.bind(actorService);
        jest.spyOn(actorService, 'sendAndSync').mockImplementation(async (id, steps, ev) => {
          forced.push(id === ROOT ? 'ROOT' : 'CHILD');
          return realSend(id, steps, ev);
        });

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });

        if (out.kind !== 'applied_bare') {
          throw new Error(`expected applied_bare, got ${out.kind}`);
        }
        // The non-running child was never dispatched; only the root was forced.
        expect(forced).toEqual(['ROOT']);
        expect(out.forcedRunIds).toEqual([ROOT]);
      });

      it('bare complete maps plan status none to outcome none', async () => {
        jest
          .spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan')
          .mockResolvedValue({ status: 'none', kind: 'complete' });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out.kind).toBe('none');
      });

      it('bare complete maps missing-inline-parent to inline_plan_unavailable', async () => {
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'missing-inline-parent',
          kind: 'complete',
          activeState: baseState({ id: CHILD }),
          missingParentRunId: ROOT,
        });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({
          kind: 'inline_plan_unavailable',
          reason: 'missing-inline-parent',
          code: 'INLINE_PARENT_UNAVAILABLE',
        });
      });

      it('bare complete maps inline-cycle to inline_plan_unavailable', async () => {
        jest.spyOn(sessionService, 'resolveActiveInlineForceTerminalPlan').mockResolvedValue({
          status: 'inline-cycle',
          kind: 'complete',
          activeState: baseState({ id: CHILD }),
          repeatedRunId: ROOT,
        });
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({
          kind: 'inline_plan_unavailable',
          reason: 'inline-cycle',
          code: 'INLINE_PARENT_CYCLE',
        });
      });

      it('bare complete surfaces root-unavailable when the root races to null mid-loop', async () => {
        const rootState = baseState({ id: ROOT });
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [rootState]);
        // Plan resolves (root running) but the root's sendAndSync races to null, so
        // forcedRunIds never includes the root → dedicated non-terminal outcome.
        jest.spyOn(actorService, 'sendAndSync').mockResolvedValue(null);
        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });
        expect(out).toMatchObject({
          kind: 'inline_plan_unavailable',
          reason: 'root-unavailable',
          code: 'RUNBOOK_STATE_CHANGED',
        });
      });

      it('skips a descendant that races to null but still forces the root', async () => {
        const childState = baseState({ id: CHILD });
        const rootState = baseState({ id: ROOT });
        await manager.save(childState);
        await manager.save(rootState);
        loadStepsImpl = () => [
          { kind: 'base', name: '1', description: 'one', transitions: tx('COMPLETE', 'STOP') },
        ];
        installResolvedPlan(rootState, [childState, rootState]);

        // The descendant races to null (skipped via `continue`) while the root
        // forces for real. This pins the `if (!result) continue;` skip: a
        // `continue`→`break` mutant would abort the loop at the descendant,
        // leaving the root unforced → `inline_plan_unavailable` (root-unavailable).
        const realSend = actorService.sendAndSync.bind(actorService);
        jest
          .spyOn(actorService, 'sendAndSync')
          .mockImplementation(async (id, steps, ev) =>
            id === CHILD ? null : realSend(id, steps, ev),
          );

        const out = await seam.runTerminal({
          command: 'complete',
          callerEvidence: DIRECT_CLI,
          targetSelector: { kind: 'default' },
        });

        if (out.kind !== 'applied_bare') {
          throw new Error(`expected applied_bare, got ${out.kind}`);
        }
        expect(out).toMatchObject({ rootRunId: ROOT, status: 'completed' });
        // Only the root was forced; the raced-to-null descendant is absent.
        expect(out.forcedRunIds).toEqual([ROOT]);
        // Every streamed event is attributed to the root, none to the skipped child.
        expect(out.events.every((e) => e.runId === ROOT)).toBe(true);
        expect(out.events.some((e) => e.runId === CHILD)).toBe(false);
      });
    });
  });
});
