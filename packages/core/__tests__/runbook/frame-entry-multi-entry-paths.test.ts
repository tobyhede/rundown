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
  RunbookActorService,
  RunbookCompletionService,
  RunbookLifecycleCommandService,
  RunbookStateManager,
  SessionService,
  activateRunProgression,
  assertRunId,
  buildFrameKey,
  createEffectfulActorMutationRunner,
  type CallerEvidence,
  type ClaimId,
  type LifecycleTerminalReleasePolicy,
  type ResolvedStep,
  type RunbookState,
  type Transitions,
} from '../../src/runbook/index.js';
import { inferFrameEntryFromState } from '../../src/runbook/frame-entry.js';
import { unwrapSessionMutation } from '../../src/testing/session-fixtures.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

import { CURRENT_SCHEMA_VERSION } from '../../src/runbook/index.js';

const RELEASE_POLICY: LifecycleTerminalReleasePolicy = {
  releaseOnTerminal: true,
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
/** A parent whose PASS action sends the cursor back into its own step. */
const PARENT_SELF_GOTO_TRANSITIONS: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '2' } } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};
/** The same self-GOTO parent, for a fixture whose loop is step `1`. */
const PARENT_SELF_GOTO_TRANSITIONS_STEP_1: Transitions = {
  pass: { kind: 'pass', retry: 0, action: { type: 'GOTO', target: { step: '1' } } },
  fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
};

const runId = assertRunId('rd_22222222222222222222222222222222');
const FRAME_1 = buildFrameKey('1');

describe('one mutation, one entry bump', () => {
  let tmp: string;
  let manager: RunbookStateManager;
  let actorService: RunbookActorService;
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
    completionService = new RunbookCompletionService(manager, actorService);
    sessionService = new SessionService(manager);
    steps = [];

    seam = new RunbookLifecycleCommandService({
      sessionService,
      actorService,
      completionService,
      actorMutationRunner: createEffectfulActorMutationRunner(tmp),
      loadRun: async (id) => (await manager.load(id)) ?? undefined,
      loadSteps: () => steps,
      resolveChildRunbook: async (name) => ({
        path: name,
        ref: { source: 'project' as const, path: name },
      }),
      findDelegationsByTokenHash: (tokenHash) =>
        new DelegationScanService(manager).scanByTokenHash(tokenHash),
    });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function baseState(overrides: Partial<RunbookState> = {}): RunbookState {
    return {
      prompted: false,
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
    if (outcome.progression.kind === 'activate') {
      const progressed = await activateRunProgression(
        outcome.progression.authority,
        {
          manager,
          actorService,
          sessionService,
          actorMutationRunner: createEffectfulActorMutationRunner(tmp),
          loadSteps: () => steps,
          sink: { emit() {} },
          dispatchInlineChild: async () => ({ kind: 'waiting' }),
          propagateTerminal: async () => ({ kind: 'propagated' }),
        },
        outcome.progression.entryBoundary,
      );
      if (progressed.kind === 'failed' || progressed.kind === 'refused') {
        throw new Error(`expected progression, got ${JSON.stringify(progressed)}`);
      }
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
      navigation: allowed.navigation,
      target,
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
   * Read the committed `activeEntry`, requiring it to be present.
   *
   * A `?? 0` fallback here would let a baseline that is missing entirely pass a
   * `+1` assertion, which is the one thing this suite exists to catch.
   *
   * @returns The committed entry ordinal.
   * @throws {Error} When the committed state carries no entry.
   */
  async function committedEntry(): Promise<number> {
    const entry = (await loadCommitted()).activeEntry;
    if (typeof entry !== 'number') throw new Error('committed state carries no activeEntry');
    return entry;
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

    const before = await committedEntry();
    await goto({ step: '2', substep: '1' });

    expect(await committedEntry()).toBe(before + 1);
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
    const before = await committedEntry();
    await drive('fail'); // ALL aggregation fails -> parent retry -> first substep

    expect(await committedEntry()).toBe(before + 1);
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
      seen.push(await committedEntry());
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

    const before = await committedEntry();
    await drive('fail');

    const after = await loadCommitted();
    expect(after.step).toBe('2');
    expect(after.activeEntry).toBe(before + 1);
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
    const beforeEntry = before.activeEntry;
    if (typeof beforeEntry !== 'number') throw new Error('expected a committed activeEntry');

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

  it('a parent-exit GOTO back into its own step bumps by exactly 1', async () => {
    // The unconditional parent-exit `always` branches build their own `assign`
    // instead of routing through `buildSimpleGotoAssign`, so they are the one
    // family of GOTO transitions that has to declare re-entry for itself. A
    // non-FOR parent whose PASS action targets its own step lands back in the
    // frame it just left, so there is no frame switch for `advanceFrameEntry` to
    // notice: without the marker the re-entered frame keeps the entry the
    // previous pass used, and every credential that pass issued still reads as
    // live in a frame that has since reset its substep rows and re-fired
    // `__issue-delegations`.
    steps = [
      { kind: 'base', name: '1', description: 'Plain step', transitions: CONTINUE_TRANSITIONS },
      {
        kind: 'substeps',
        name: '2',
        description: 'Parent that GOTOs its own step on PASS',
        transitions: PARENT_SELF_GOTO_TRANSITIONS,
        substeps: [
          { id: '1', description: 'First', transitions: DEFER_TRANSITIONS },
          { id: '2', description: 'Second', transitions: DEFER_TRANSITIONS },
        ],
      },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState());

    await drive('pass'); // step 1 CONTINUE -> frame 2, substep 1
    const before = await committedEntry();
    expect((await loadCommitted()).activeFrameKey).toBe(buildFrameKey('2'));

    await drive('pass'); // 2.1 DEFER -> sibling 2.2: same frame, no bump
    expect(await committedEntry()).toBe(before);

    await drive('pass'); // 2.2 DEFER -> parent exit -> PASS GOTO 2 -> re-entry
    const after = await loadCommitted();
    expect(after.substep).toBe('1');
    expect(after.activeFrameKey).toBe(buildFrameKey('2'));
    expect(after.activeEntry).toBe(before + 1);
    expect(after.frameEntryCounts?.[buildFrameKey('2')]).toBe(before + 1);
  });

  it('a first-iteration BREAK into a self-GOTO FOR parent bumps by exactly 1', async () => {
    // The control-exit branch routes to the PASS target like its two siblings,
    // so it needs the same re-entry marker — but only this shape exposes it. An
    // exit from any later iteration rebuilds the loop at `forClause.start`, a
    // different frame from the one it abandoned, so the frame switch supplies
    // the bump on its own. BREAK on the FIRST iteration abandons `1|1` and
    // rebuilds `1|1`: same frame, and the entry stalls without the marker.
    steps = [
      {
        kind: 'for',
        name: '1',
        description: 'Loop that breaks immediately',
        forClause: {
          start: 1,
          end: 3,
          transitions: {
            pass: { kind: 'pass', retry: 0, action: { type: 'DEFER' } },
            fail: { kind: 'fail', retry: 0, action: { type: 'BREAK' } },
          },
        },
        // No parent aggregation: that is what routes the exit through the
        // unconditional Case C branches rather than the aggregating ones.
        transitions: PARENT_SELF_GOTO_TRANSITIONS_STEP_1,
        substeps: [{ id: '1', description: 'Body', transitions: DEFER_TRANSITIONS }],
      },
      { kind: 'base', name: '2', description: 'After the loop', transitions: CONTINUE_TRANSITIONS },
    ] satisfies readonly ResolvedStep[];
    await activate(baseState({ activeFrameKey: buildFrameKey('1', 1) }));

    const before = await committedEntry();
    await drive('fail'); // body fails -> BREAK -> control exit -> PASS GOTO 1

    const after = await loadCommitted();
    expect(after.step).toBe('1');
    expect(after.activeFrameKey).toBe(buildFrameKey('1', 1));
    expect(after.activeEntry).toBe(before + 1);
  });
});
