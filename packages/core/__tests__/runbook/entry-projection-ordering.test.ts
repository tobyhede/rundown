/**
 * Regression pin for #680: the machine is the single writer of frame entry.
 *
 * A machine-issued delegation credential must stamp the `parentEntry` that the
 * *committed* `RunbookState` carries for the same frame, on every issuance
 * path. Part B's `unobservedReplacement` predicate compares those two values
 * directly, so a lag on either machine-owned path would silently degrade the
 * retry idempotency contract to an unconditional re-mint while reading as
 * implemented.
 *
 * Method: drive real transitions through the real
 * `RunbookLifecycleCommandService` — the production caller that sequences
 * `RunbookActorService.prepareActorMutation` (which runs the machine, and
 * therefore issues credentials) — then read the credential back off committed
 * state and compare.
 *
 * All five cases assert agreement. Before #680 the first, second and fifth
 * lagged the committed value by exactly one.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DelegationScanService,
  ExecutionLifecycleService,
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  assertRunId,
  buildFrameKey,
  createEffectfulActorMutationRunner,
  type CallerEvidence,
  type ClaimId,
  type FrameKey,
  type LifecycleTerminalReleasePolicy,
  type ResolvedStep,
  type RunbookState,
  type StepDelegation,
  type Transitions,
} from '../../src/runbook/index.js';
import { inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  onComplete: { releaseRunbook: true },
  onStopped: { releaseRunbook: true },
};

const CONTINUE_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};
const DEFER_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
  fail: { kind: 'fail', retry: 0, action: { type: 'DEFER' } },
};

const runId = assertRunId('rd_11111111111111111111111111111111');
const FRAME_1 = buildFrameKey('1');
const FRAME_2 = buildFrameKey('2');

/**
 * Plain step `1`, then a delegating parent step `2` whose FAIL retries once.
 *
 * The leading plain step exists so a transition can carry execution *into* the
 * delegating frame — machine-owned issuance fires on entry to the DELEGATE
 * substep, so the issuing transition is always the one that also moves the
 * frame.
 *
 * @returns Resolved steps for the fixture runbook.
 */
function fixtureSteps(): readonly ResolvedStep[] {
  return [
    { kind: 'base', name: '1', description: 'Plain step', transitions: CONTINUE_TRANSITIONS },
    {
      kind: 'substeps',
      name: '2',
      description: 'Delegating parent',
      transitions: {
        pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
        fail: { kind: 'fail', retry: 1, action: { type: 'STOP' } },
      },
      aggregation: { strategy: 'ALL' },
      substeps: [
        {
          id: '1',
          description: 'Delegated substep',
          transitions: DEFER_TRANSITIONS,
          runbooks: ['child.runbook.md'],
          delegate: true,
        },
      ],
    },
  ] satisfies readonly ResolvedStep[];
}

describe('entry projection ordering: machine credential issuance agrees with committed state', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
  let lifecycleService: ExecutionLifecycleService;
  let completionService: RunbookCompletionService;
  let sessionService: SessionService;
  let seam: RunbookLifecycleCommandService;
  let runControlClaim: ClaimId;
  let steps: readonly ResolvedStep[];

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'entry-projection-'));
    manager = new RunbookStateManager(tmp);
    actorService = new RunbookActorService(manager, {
      resolveDelegationRunbook: async (runbookRef) => ({
        path: runbookRef,
        runbookRef,
        childRunbookRef: { source: 'project' as const, path: runbookRef },
      }),
    });
    lifecycleService = new ExecutionLifecycleService(manager);
    completionService = new RunbookCompletionService(manager, lifecycleService, actorService);
    sessionService = new SessionService(manager);
    steps = fixtureSteps();

    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      lifecycleService,
      completionService,
      actorMutationRunner: createEffectfulActorMutationRunner(tmp),
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: () => steps,
      resolveChildRunbook: async (name) => ({
        path: name,
        ref: { source: 'project' as const, path: name },
      }),
      findDelegationByToken: async (token) =>
        (await new DelegationScanService(manager).findByToken(token)) ?? undefined,
      findDelegationsBySupersededToken: (token) =>
        new DelegationScanService(manager).findBySupersededToken(token),
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runId,
      runbook: { source: 'project', path: 'investigation.md' },
      runbookPath: 'investigation.md',
      step: '1',
      stepName: 'Plain step',
      substep: undefined,
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      templateVars: brandInitialTemplateVarsForTest({ RunId: runId }),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: { [FRAME_1]: 1 },
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      startedAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
      lifecycle: 'running',
      schemaVersion: 1,
      frontmatterOutputs: [],
      ...overrides,
    };
  }

  async function activate(state: RunbookState): Promise<void> {
    await manager.save(state);
    await sessionService.pushRunbook(state.id);
    const { claimId } = unwrapSessionMutation(await sessionService.issueRunControlClaim(state.id));
    runControlClaim = claimId;
  }

  function evidence(): CallerEvidence {
    return { kind: 'claim_bearer', claimId: runControlClaim };
  }

  /**
   * Drive a pass/fail transition through the seam and require it to apply.
   *
   * @param command - Transition command to drive.
   * @throws {Error} When the seam refuses instead of applying.
   */
  async function drive(command: 'pass' | 'fail'): Promise<void> {
    const outcome = await seam.runTransition({
      command,
      callerEvidence: evidence(),
      targetSelector: { kind: 'run', runId },
      terminalPolicy: RELEASE_POLICY,
    });
    if (outcome.kind !== 'applied') {
      throw new Error(`expected applied, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
  }

  /**
   * Load the committed run state.
   *
   * @returns The persisted state.
   * @throws {Error} When the run is missing.
   */
  async function loadCommitted(): Promise<RunbookState> {
    const state = await manager.load(runId);
    if (!state) throw new Error('committed state missing');
    return state;
  }

  /**
   * Find the single delegation recorded against a frame.
   *
   * @param state - State to search.
   * @param frameKey - Frame the delegation must belong to.
   * @returns The delegation record.
   * @throws {Error} When no delegation exists on that frame.
   */
  function delegationFor(state: RunbookState, frameKey: FrameKey): StepDelegation {
    const entry = (state.substepStates ?? []).find(
      (ss) => ss.frameKey === frameKey && ss.delegation !== undefined,
    );
    if (!entry?.delegation) {
      throw new Error(
        `no delegation on frame ${frameKey}; substepStates=${JSON.stringify(state.substepStates)}`,
      );
    }
    return entry.delegation;
  }

  it('AGREES: machine-owned FRESH issuance, carried into the frame by PASS', async () => {
    await activate(baseState());

    // PASS on plain step 1 -> the machine enters step 2's DELEGATE substep. The
    // leaf's `syncFrameEntry` advances the entry BEFORE `delegationIssueActor`
    // reads it, and `deriveActorStatePatch` commits that same value, so the
    // stamp and the commit are one number written once.
    await drive('pass');

    const committed = await loadCommitted();
    const delegation = delegationFor(committed, FRAME_2);

    expect(delegation.credential.parentFrameKey).toBe(FRAME_2);
    expect(delegation.credential.parentEntry).toBe(2);
    expect(committed.activeFrameKey).toBe(FRAME_2);
    expect(committed.activeEntry).toBe(2);
    expect(committed.frameEntryCounts).toEqual({ [FRAME_1]: 1, [FRAME_2]: 2 });
    expect(inferFrameEntryFromState(committed, FRAME_2)).toBe(2);

    // The fourth conjunct holds for a credential this very transition issued.
    expect(delegation.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
  });

  it('AGREES: machine-owned RETRY re-issuance re-entering the same frame', async () => {
    await activate(baseState());
    await drive('pass');

    const afterFresh = await loadCommitted();
    const fresh = delegationFor(afterFresh, FRAME_2);
    expect(fresh.credential.parentEntry).toBe(2);
    expect(afterFresh.activeEntry).toBe(2);

    // FAIL the delegated substep -> parent aggregation fails -> retry(1) ->
    // `runRetryHook` re-issues a SUPERSEDING credential. The hook runs as a
    // TRANSITION action, so that assign advances `frameEntry` inline and hands
    // the hook the advanced coordinates rather than relying on the leaf entry
    // action that runs after it.
    await drive('fail');

    const committed = await loadCommitted();
    const replacement = delegationFor(committed, FRAME_2);

    // This is exactly the shape the idempotency contract's `unobservedReplacement`
    // predicate is written for: a superseding credential with no child and no
    // cancellation.
    expect(replacement.credential.supersedesTokenHash).toBe(fresh.tokenHash);
    expect(replacement.childRunId).toBeNull();
    expect(replacement.cancelledAt).toBeNull();
    expect(committed.lastAction).toEqual({ origin: 'aggregation', type: 'RETRY' });

    expect(replacement.credential.parentEntry).toBe(3);
    expect(committed.activeEntry).toBe(3);
    expect(committed.frameEntryCounts).toEqual({ [FRAME_1]: 1, [FRAME_2]: 3 });
    expect(inferFrameEntryFromState(committed, FRAME_2)).toBe(3);

    // The conjunct holds for the retry case the contract targets.
    expect(replacement.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
  });

  it('AGREES: machine-owned FRESH issuance carried into the frame by GOTO', async () => {
    // `rundown goto` into a new frame now bumps the entry, like every other
    // frame-entering transition. The old `transitioned=false` workaround existed
    // only because two writers could each score one navigation; with a single
    // writer the correct number under the stated rule ("entry increments when
    // execution enters a frame from another frame") is 2.
    await activate(baseState());

    const allowed = await seam.resolveRunNavigation({
      command: 'goto',
      callerEvidence: evidence(),
      targetSelector: { kind: 'run', runId },
    });
    if (allowed.kind !== 'allowed') {
      throw new Error(`expected allowed, got ${allowed.kind}`);
    }

    const outcome = await seam.runNavigationMutation({
      runId,
      callerEvidence: evidence(),
      steps,
      target: { step: '2' },
      terminalReleaseMode: allowed.terminalReleaseMode,
      ...(allowed.delegationRuntime === undefined
        ? {}
        : { issueDelegationCredential: allowed.delegationRuntime.issueDelegationCredential }),
    });
    expect(outcome.kind).toBe('applied');

    const committed = await loadCommitted();
    const delegation = delegationFor(committed, FRAME_2);

    expect(delegation.credential.parentEntry).toBe(2);
    expect(committed.activeFrameKey).toBe(FRAME_2);
    expect(committed.activeEntry).toBe(2);
    expect(inferFrameEntryFromState(committed, FRAME_2)).toBe(2);
    expect(delegation.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
  });

  it('AGREES: manual retry issuance through `issueDelegation`', async () => {
    // The manual path calls `createDelegation` against the captured state and
    // never re-projects the entry afterwards, so `parentEntry` matches committed
    // state by construction. Pinning it here establishes the asymmetry: the
    // fourth conjunct would hold for manually issued credentials and fail for
    // machine-issued ones — a contract that works only for half its inputs.
    await activate(baseState());
    await drive('pass');

    const afterFresh = await loadCommitted();
    const fresh = delegationFor(afterFresh, FRAME_2);

    const retried = await seam.issueDelegation({
      mode: 'retry',
      callerEvidence: evidence(),
      locator: { kind: 'step', step: '2.1' },
    });
    expect(retried.kind).toBe('retried');

    const committed = await loadCommitted();
    const replacement = delegationFor(committed, FRAME_2);

    expect(replacement.credential.supersedesTokenHash).toBe(fresh.tokenHash);
    expect(replacement.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
    // Manual retry does not move the frame at all.
    expect(committed.activeEntry).toBe(afterFresh.activeEntry);
  });

  it('AGREES: machine-owned FRESH issuance is frame-scoped, so EVERY substep in the frame agrees', async () => {
    // Anti-loophole for case 1. `delegationIssueActor` calls
    // `inferAllDelegateSubsteps`, so entering a frame issues a credential for
    // every DELEGATE substep it holds, in the same transition. There is no
    // machine-owned fresh issuance that happens on a later, within-frame advance
    // and could therefore escape the frame-switch bump — the entering transition
    // is the only one that issues, and it is always scored as a frame switch.
    steps = [
      { kind: 'base', name: '1', description: 'Plain step', transitions: CONTINUE_TRANSITIONS },
      {
        kind: 'substeps',
        name: '2',
        description: 'Delegating parent',
        transitions: CONTINUE_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        substeps: [
          {
            id: '1',
            description: 'First delegated substep',
            transitions: DEFER_TRANSITIONS,
            runbooks: ['child.runbook.md'],
            delegate: true,
          },
          {
            id: '2',
            description: 'Second delegated substep',
            transitions: DEFER_TRANSITIONS,
            runbooks: ['other.runbook.md'],
            delegate: true,
          },
        ],
      },
    ] satisfies readonly ResolvedStep[];

    await activate(baseState());
    // ONE transition into the frame issues BOTH delegations.
    await drive('pass');

    const committed = await loadCommitted();
    const byId = new Map(
      (committed.substepStates ?? [])
        .filter((ss) => ss.frameKey === FRAME_2 && ss.delegation !== undefined)
        .map((ss) => [ss.id, ss.delegation!]),
    );

    expect([...byId.keys()].sort()).toEqual(['1', '2']);
    expect(committed.substep).toBe('1'); // still parked on the first substep
    expect(committed.activeEntry).toBe(2);
    expect(inferFrameEntryFromState(committed, FRAME_2)).toBe(2);

    for (const [id, delegation] of byId) {
      expect(delegation.credential.parentStepId).toBe(`2.${id}`);
      expect(delegation.credential.parentEntry).toBe(2);
      expect(delegation.credential.parentEntry).toBe(inferFrameEntryFromState(committed, FRAME_2));
    }
  });
});
