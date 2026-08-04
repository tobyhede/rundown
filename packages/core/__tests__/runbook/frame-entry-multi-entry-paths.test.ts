/**
 * One CLI-level mutation moves the committed frame entry by exactly one bump.
 *
 * The single-writer model (#680) advances `context.frameEntry` on entry to a
 * step/substep leaf, and a single `prepareActorMutation` can drive several such
 * entries in one macrostep. `__parent-entry::` artifact routing is two, a
 * BREAK chain out of a loop is several, and a parent-aggregation RETRY on a FOR
 * parent legitimately enters two *different* frames. The one-shot
 * `context.frameReentry` marker is what keeps the first three at one bump; this
 * suite proves it at the seam, on committed state, rather than on machine
 * context.
 *
 * A failure here is not churn. A delta of `+2` where `+1` is asserted means a
 * transition set the marker on a path that also switches frames, or a retry
 * site both advanced inline and set the marker — fix the compiler, not the
 * expectation.
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
const PARENT_RETRY_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
  fail: { kind: 'fail', retry: 1, action: { type: 'STOP' } },
};

const runId = assertRunId('rd_22222222222222222222222222222222');
const FRAME_1 = buildFrameKey('1');

describe('one mutation, one entry bump', () => {
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
    tmp = await mkdtemp(path.join(tmpdir(), 'frame-entry-paths-'));
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
    steps = [];

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
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      id: runId,
      runbook: { source: 'project', path: 'paths.md' },
      runbookPath: 'paths.md',
      step: '1',
      stepName: 'Plain step',
      substep: undefined,
      retryCount: 0,
      variables: brandStoredOutputsForTest({}),
      templateVars: brandInitialTemplateVarsForTest({
        RunId: runId,
        // ARTIFACTS resolution needs a work path and context to build the URI.
        ContextId: 'ctx1',
        WorkPath: '.rundown/work',
        RunbookRef: { source: 'project', path: 'paths.md' },
      }),
      steps: [],
      resolvedCompletions: {},
      frameEntryCounts: { [FRAME_1]: 1 },
      activeFrameKey: FRAME_1,
      activeEntry: 1,
      startedAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
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
   * Navigate through the seam and require the mutation to apply.
   *
   * @param target - Step (and optional substep) to navigate to.
   * @throws {Error} When the seam refuses the navigation or the mutation.
   */
  async function goto(target: { step: string; substep?: string }): Promise<void> {
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
      target,
      terminalReleaseMode: allowed.terminalReleaseMode,
      ...(allowed.issueDelegationCredential === undefined
        ? {}
        : { issueDelegationCredential: allowed.issueDelegationCredential }),
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

  it('__parent-entry:: artifact routing: a GOTO into an artifact-declaring parent bumps by exactly 1', async () => {
    // Step 2 declares ARTIFACTS and has substeps, so the GOTO routes
    // step::2::__parent-entry::1 -> step::2::1 — two state entries, one frame.
    steps = [
      { kind: 'base', name: '1', description: 'Plain step', transitions: CONTINUE_TRANSITIONS },
      {
        kind: 'substeps',
        name: '2',
        description: 'Parent with artifacts',
        transitions: CONTINUE_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        artifacts: [{ name: 'ParentPath', rawToken: 'parent.json' }],
        substeps: [
          { id: '1', description: 'First', transitions: DEFER_TRANSITIONS },
          { id: '2', description: 'Second', transitions: DEFER_TRANSITIONS },
        ],
      },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState());

    const before = (await loadCommitted()).activeEntry;
    await goto({ step: '2', substep: '1' });

    expect((await loadCommitted()).activeEntry).toBe((before ?? 0) + 1);
  });

  it('aggregation RETRY into firstSubstepStateId bumps by exactly 1', async () => {
    steps = [
      { kind: 'base', name: '1', description: 'Plain step', transitions: CONTINUE_TRANSITIONS },
      {
        kind: 'substeps',
        name: '2',
        description: 'Aggregating parent',
        transitions: PARENT_RETRY_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        substeps: [{ id: '1', description: 'Only', transitions: DEFER_TRANSITIONS }],
      },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState());

    await drive('pass'); // into frame 2
    const before = (await loadCommitted()).activeEntry;
    await drive('fail'); // ALL aggregation fails -> parent retry -> first substep

    expect((await loadCommitted()).activeEntry).toBe((before ?? 0) + 1);
  });

  it('FOR loop-back bumps by exactly 1 per iteration', async () => {
    steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: {
          start: 1,
          end: 3,
          transitions: DEFER_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
        },
        transitions: CONTINUE_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        substeps: [{ id: '1', description: 'Body', transitions: DEFER_TRANSITIONS }],
      },
      { kind: 'base', name: '2', description: 'Done', transitions: CONTINUE_TRANSITIONS },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState({ activeFrameKey: buildFrameKey('1', 1) }));

    const seen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push((await loadCommitted()).activeEntry ?? 0);
      await drive('pass');
    }

    expect(seen).toEqual([seen[0], seen[0] + 1, seen[0] + 2]);
  });

  it('a BREAK chain that crosses steps bumps by exactly 1', async () => {
    // BREAK exits the loop to the parent, which exits to step 2 in one
    // macrostep: several state entries, one frame actually entered.
    steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: {
          start: 1,
          end: 3,
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
          },
          aggregation: { strategy: 'ALL' },
        },
        transitions: CONTINUE_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        substeps: [{ id: '1', description: 'Body', transitions: DEFER_TRANSITIONS }],
      },
      { kind: 'base', name: '2', description: 'After the loop', transitions: CONTINUE_TRANSITIONS },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState({ activeFrameKey: buildFrameKey('1', 1) }));

    const before = (await loadCommitted()).activeEntry;
    await drive('fail');

    const after = await loadCommitted();
    expect(after.step).toBe('2');
    expect(after.activeEntry).toBe((before ?? 0) + 1);
  });

  it('aggregation RETRY on a FOR parent bumps the retried frame and the rebuilt frame once each', async () => {
    // The one legitimate two-bump path, and the reason the assertion here is
    // `+2` rather than `+1`. The parent-aggregation retry assigns
    // `forStack: EMPTY_FOR_STACK`, so the leaf `initForStack` that follows
    // rebuilds the loop at `forClause.start` — a *different* frame from the one
    // `runRetryHook` retried. Two frames are entered, so two bumps are correct;
    // what must hold is that each frame is scored exactly once.
    //
    // The retried frame's recorded count is raised by the inline advance rather
    // than left behind, which is what keeps `inferFrameEntryFromState` able to
    // reproduce the entry any credential stamped in that frame.
    //
    // Note which frame that is: it is the bare step frame `1|`, not the
    // iteration frame — see the assertions below for why.
    //
    // The substep is deliberately NOT a DELEGATE. A FOR parent that carries
    // delegations and a parent-level retry budget refuses this transition with
    // RD-902 ("all delegations are under stale frame keys") before the retry
    // lands: the hook derives its frame from the cursor, which has left the
    // iteration the delegations belong to. That refusal predates #680 —
    // `retry-hook.ts` is untouched by it and the hook selects frames from
    // `step`/`forStack`, neither of which this change writes — so it is not
    // this suite's to assert or to fix.
    steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop',
        forClause: {
          start: 1,
          end: 2,
          transitions: DEFER_TRANSITIONS,
          aggregation: { strategy: 'ALL' },
        },
        transitions: PARENT_RETRY_TRANSITIONS,
        aggregation: { strategy: 'ALL' },
        substeps: [{ id: '1', description: 'Body', transitions: DEFER_TRANSITIONS }],
      },
      { kind: 'base', name: '2', description: 'Done', transitions: CONTINUE_TRANSITIONS },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState({ activeFrameKey: buildFrameKey('1', 1) }));

    await drive('pass'); // iteration 1 passes, loop advances to iteration 2
    const before = await loadCommitted();
    const abandonedIteration = before.activeFrameKey;
    if (!abandonedIteration) throw new Error('expected an active frame');
    expect(abandonedIteration).toBe(buildFrameKey('1', 2));
    const beforeEntry = before.activeEntry ?? 0;

    await drive('fail'); // iteration 2 fails -> parent ALL fails -> parent retry

    const after = await loadCommitted();
    expect(after.lastAction).toEqual({ origin: 'aggregation', type: 'RETRY' });

    // The frame the inline advance scores is the BARE STEP frame, not the
    // iteration frame the loop was sitting in: the loop has exhausted by the
    // time the parent aggregation resolves, so `frameKeyForCursor` finds no
    // active FOR context. That is the same derivation `runRetryHook` performs
    // on the coordinates it is handed, which is what keeps the two consistent.
    const retriedFrame = buildFrameKey('1');
    expect(after.frameEntryCounts?.[retriedFrame]).toBe(beforeEntry + 1);
    expect(inferFrameEntryFromState(after, retriedFrame)).toBe(beforeEntry + 1);

    // The rebuilt iteration frame is scored once, by the leaf entry action that
    // runs after `initForStack` restarts the loop at `forClause.start`.
    expect(after.activeFrameKey).toBe(buildFrameKey('1', 1));
    expect(after.activeEntry).toBe(beforeEntry + 2);

    // Two frames entered, two bumps — never three. And the iteration the loop
    // abandoned is left exactly where it was.
    expect(after.frameEntryCounts?.[abandonedIteration]).toBe(beforeEntry);
  });
});
