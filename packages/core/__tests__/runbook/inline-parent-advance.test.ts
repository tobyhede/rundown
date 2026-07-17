import { describe, it, expect, jest } from '@jest/globals';
import {
  propagateTerminalChildUpward,
  MAX_INLINE_PROPAGATION_CHAIN,
  type AdvanceInlineParent,
  type LinkageCycleTrip,
  type PropagateTerminalChildUpwardDeps,
} from '../../src/runbook/inline-parent-advance.js';
import {
  assertRunId,
  assertDelegationTokenHash,
  type RunbookState,
  type RunId,
  type DelegationLinkage,
  type InlineLinkage,
  type ReleaseRunbookResult,
} from '../../src/runbook/index.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import { brandStoredOutputsForTest } from '../../src/testing/effective-vars.js';

const CHILD = assertRunId('rd_22222222222222222222222222222222');
const PARENT = assertRunId('rd_11111111111111111111111111111111');
const GRANDPARENT = assertRunId('rd_33333333333333333333333333333333');

function inlineLinkage(parentRunId: RunId = PARENT): InlineLinkage {
  return {
    kind: 'inline',
    parentRunId,
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
  };
}

function delegationLinkage(parentRunId: RunId = PARENT): DelegationLinkage {
  return {
    kind: 'delegation',
    parentRunId,
    parentStepId: '1',
    parentStep: '1',
    parentFrameKey: buildFrameKey('1'),
    parentEntry: 1,
    tokenHash: assertDelegationTokenHash(
      'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ),
  };
}

function makeState(id: RunId, overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    id,
    runbook: { source: 'project', path: 'test.md' },
    runbookPath: '/tmp/test.md',
    step: '1',
    stepName: 'Step',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    steps: [{ id: '1', status: 'running' }],
    lifecycle: 'completed',
    startedAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    schemaVersion: 1,
    frontmatterOutputs: [],
    ...overrides,
  };
}

const NEVER_ADVANCE: AdvanceInlineParent = () => {
  throw new Error('advanceInlineParent must not be called on this path');
};

function makeDeps(
  overrides: Partial<PropagateTerminalChildUpwardDeps> = {},
): PropagateTerminalChildUpwardDeps {
  return {
    manager: {
      load: jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(null),
    },
    sessionService: {
      releaseRunbook: jest
        .fn<
          (
            id: RunId,
            o?: { readonly retainClaimsAsTerminal?: boolean },
          ) => Promise<ReleaseRunbookResult>
        >()
        .mockResolvedValue({} as ReleaseRunbookResult),
    },
    completionService: {
      recordChildCompletion: jest
        .fn<
          (
            args: unknown,
          ) => Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'>
        >()
        .mockResolvedValue('recorded'),
    },
    advanceInlineParent: NEVER_ADVANCE,
    onLinkageCycle: () => {},
    ...overrides,
  };
}

describe('propagateTerminalChildUpward — pure decision + delegation arm', () => {
  it('returns not-applicable when the child has no parent linkage', async () => {
    const child = makeState(CHILD, { parentLinkage: undefined });
    const result = await propagateTerminalChildUpward(makeDeps(), child, 'pass');
    expect(result).toBe('not-applicable');
  });

  it('returns not-applicable for a non-terminal child (lifecycle inference, no explicit result)', async () => {
    const child = makeState(CHILD, { lifecycle: 'running', parentLinkage: inlineLinkage() });
    const result = await propagateTerminalChildUpward(makeDeps(), child, undefined);
    expect(result).toBe('not-applicable');
  });

  it('returns blocked for a command-infrastructure terminal (decided before any callable)', async () => {
    const child = makeState(CHILD, {
      lifecycle: 'stopped',
      parentLinkage: inlineLinkage(),
      lastAction: { type: 'POLICY_DENIED', origin: 'direct', message: 'blocked by policy' },
    });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent }),
      child,
      undefined,
    );
    expect(result).toBe('blocked');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('delegation linkage records report-only and returns reported', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('reported');
    expect(recordChildCompletion).toHaveBeenCalledWith({ childState: child, result: 'pass' });
  });

  it('delegation linkage returns blocked when recording is blocked', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'blocked'>>()
      .mockResolvedValue('blocked');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'fail',
    );
    expect(result).toBe('blocked');
  });

  it('delegation linkage returns not-applicable when recording finds no linkage', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'not-applicable'>>()
      .mockResolvedValue('not-applicable');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('not-applicable');
  });

  // RD-598 review finding 2: a 'duplicate' (or 'cancelled') record is NOT a fresh
  // report. The seam MUST surface it as 'duplicate', not 'reported', so the
  // collect path keeps reportedTerminalOutcome:false (pinned at
  // collection-service.test.ts:1429). Collapsing it to 'reported' is the bug.
  it('delegation linkage returns duplicate when the outcome was already recorded', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'duplicate'>>()
      .mockResolvedValue('duplicate');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('duplicate');
  });

  it('delegation linkage returns duplicate for an ordinary cancel short-circuit', async () => {
    const child = makeState(CHILD, { parentLinkage: delegationLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'cancelled'>>()
      .mockResolvedValue('cancelled');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('duplicate');
  });
});

describe('propagateTerminalChildUpward — inline arm', () => {
  it('cancelled recording short-circuits to handled without advancing', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'cancelled'>>()
      .mockResolvedValue('cancelled');
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion }, advanceInlineParent }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('blocked recording returns blocked without advancing', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'blocked'>>()
      .mockResolvedValue('blocked');
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion }, advanceInlineParent }),
      child,
      'fail',
    );
    expect(result).toBe('blocked');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('active advance (parent waiting on siblings) returns handled, no release', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'active' });
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, sessionService: { releaseRunbook } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).toHaveBeenCalledWith({
      parentRunId: PARENT,
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
      result: 'pass',
    });
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('stopped advance releases the parent and returns stopped (parent has no linkage)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const parent = makeState(PARENT, { lifecycle: 'stopped', parentLinkage: undefined });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(parent);
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, sessionService: { releaseRunbook } }),
      child,
      'fail',
    );
    expect(result).toBe('stopped');
    // Release disposition: retain the claim tombstone (matches collect + loop),
    // so a bare second release never destroys it. See RD-598 verification.
    expect(releaseRunbook).toHaveBeenCalledWith(PARENT, { retainClaimsAsTerminal: true });
  });

  it('done advance with a linkage-free parent returns handled', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const parent = makeState(PARENT, { lifecycle: 'completed', parentLinkage: undefined });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(parent);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
  });

  it('done advance still reloads and recurses when releaseRunbook rejects (RD-102)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const parent = makeState(PARENT, { lifecycle: 'completed', parentLinkage: undefined });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(parent);
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockRejectedValue(new Error('release boom'));
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, sessionService: { releaseRunbook } }),
      child,
      'pass',
    );
    // A failed release must not mask the committed upward propagation: the parent
    // is still reloaded (proving the recursion was not skipped) and, being
    // linkage-free, the result is still 'handled'.
    expect(result).toBe('handled');
    expect(load).toHaveBeenCalledWith(PARENT);
  });

  it('inline→inline chain advances synchronously (callable re-invoked per level)', async () => {
    // child -> parent(inline-linked to grandparent) -> grandparent.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(GRANDPARENT),
    });
    const grandparentTerminal = makeState(GRANDPARENT, {
      lifecycle: 'completed',
      parentLinkage: undefined,
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValueOnce(parentTerminal) // reload after advancing parent
      .mockResolvedValueOnce(grandparentTerminal); // reload after advancing grandparent
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    // Callable invoked once for the parent, once for the grandparent.
    expect(advanceInlineParent).toHaveBeenCalledTimes(2);
    expect(advanceInlineParent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ parentRunId: PARENT }),
    );
    expect(advanceInlineParent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentRunId: GRANDPARENT }),
    );
  });

  it('inline→delegation boundary is report-only (single-level invariant)', async () => {
    // Advancing the inline parent drives it terminal; the parent is delegation-linked,
    // so the recursion takes the report-only arm — the grandparent is NOT collected.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: delegationLinkage(GRANDPARENT),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        manager: { load },
        completionService: { recordChildCompletion },
      }),
      child,
      'pass',
    );
    // 'done' at the inline level + 'reported' at the delegation recursion => handled.
    expect(result).toBe('handled');
    // Callable invoked ONCE (for the parent) — never for the grandparent.
    expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    // The recursion recorded the parent's outcome report-only against the grandparent.
    expect(recordChildCompletion).toHaveBeenLastCalledWith({
      childState: parentTerminal,
      result: 'pass',
    });
  });

  // --- Mutation-gap closers (#598, step 6.5): the recursion's blocked/stopped
  // bubble-up and the not-applicable / null-parent branches. ---

  it('inline recording not-applicable short-circuits without advancing', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'not-applicable'>>()
      .mockResolvedValue('not-applicable');
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion }, advanceInlineParent }),
      child,
      'pass',
    );
    expect(result).toBe('not-applicable');
    expect(advanceInlineParent).not.toHaveBeenCalled();
  });

  it('stopped advance with a vanished parent (load → null) still returns stopped', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage() });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    // Parent released then reloaded as null — the recursion is skipped
    // (propagated = 'not-applicable'), so a stopped advance stays 'stopped'.
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>().mockResolvedValue(null);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('stopped');
  });

  it('stopped advance whose recursion blocks returns blocked', async () => {
    // child -> parent(delegation-linked). Advancing the parent STOPS it; the
    // delegation recursion records 'blocked', so the stopped result escalates.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'stopped',
      parentLinkage: delegationLinkage(GRANDPARENT),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded' | 'blocked'>>()
      .mockResolvedValueOnce('recorded') // child recorded on the parent
      .mockResolvedValueOnce('blocked'); // recursion: parent report blocked
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        manager: { load },
        completionService: { recordChildCompletion },
      }),
      child,
      'fail',
    );
    expect(result).toBe('blocked');
  });

  it('done advance whose recursion blocks returns blocked', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: delegationLinkage(GRANDPARENT),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded' | 'blocked'>>()
      .mockResolvedValueOnce('recorded')
      .mockResolvedValueOnce('blocked');
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        manager: { load },
        completionService: { recordChildCompletion },
      }),
      child,
      'pass',
    );
    expect(result).toBe('blocked');
  });

  it('done advance whose inline→inline recursion stops returns stopped', async () => {
    // child -> parent(inline-linked to grandparent). Parent advance DONE; the
    // grandparent advance STOPS, so the done result escalates to stopped.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(GRANDPARENT),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValueOnce({ status: 'done' }) // parent
      .mockResolvedValueOnce({ status: 'stopped' }); // grandparent
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValueOnce(parentTerminal) // reload after advancing parent
      .mockResolvedValueOnce(null); // grandparent reload → null, recursion stops
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('stopped');
    expect(advanceInlineParent).toHaveBeenCalledTimes(2);
  });

  // --- #602: cycle guard. The linkage graph is a tree by construction, so a
  // repeat means corrupted persisted state: fail closed, perform no side
  // effects for the repeated run, and never downgrade to 'handled'.

  it('self-linked child (parent === child) trips the guard with no side effects', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(CHILD) });
    const advanceInlineParent = jest.fn<AdvanceInlineParent>();
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        completionService: { recordChildCompletion },
        sessionService: { releaseRunbook },
      }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(recordChildCompletion).not.toHaveBeenCalled();
    expect(advanceInlineParent).not.toHaveBeenCalled();
    expect(releaseRunbook).not.toHaveBeenCalled();
  });

  it('two-node cycle (child→parent→child) trips after exactly one advance', async () => {
    // child(A) -> parent(B); B's persisted linkage points back at A.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const releaseRunbook = jest
      .fn<
        (
          id: RunId,
          o?: { readonly retainClaimsAsTerminal?: boolean },
        ) => Promise<ReleaseRunbookResult>
      >()
      .mockResolvedValue({} as ReleaseRunbookResult);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, sessionService: { releaseRunbook } }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // The FIRST level is legitimate and completes; the repeat of A performs nothing.
    expect(advanceInlineParent).toHaveBeenCalledTimes(1);
    expect(advanceInlineParent).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: PARENT }),
    );
    expect(releaseRunbook).toHaveBeenCalledTimes(1);
    expect(releaseRunbook).toHaveBeenCalledWith(PARENT, { retainClaimsAsTerminal: true });
  });

  it('a cycle discovered by the recursion outranks a stopped advance', async () => {
    // Severity precedence: linkage-cycle > blocked > stopped > handled. A cycle
    // must not be downgraded to 'stopped' (or 'handled') by a shallower level.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'stopped',
      parentLinkage: inlineLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'stopped' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'fail',
    );
    expect(result).toBe('linkage-cycle');
  });

  it('does not call a purely DELEGATION cycle "inline" in the operator message', async () => {
    // The guard sits BEFORE the kind dispatch, so it trips on a delegation
    // back-edge with no inline linkage anywhere in the graph. Reachable:
    // propagateDrivenRunTerminal routes a delegation-linked child straight to the
    // seam with no claim gate, so `rundown pass` on a self-linked delegation
    // child lands here. Telling that operator "Inline parent cycle" is simply
    // false and sends them looking for a composition that does not exist.
    //
    // The INLINE_PARENT_CYCLE *code* deliberately stays: it is an established
    // agent-facing identifier shared with the force-terminal path, and both
    // conditions have one recovery — prune the named run. The code is an index
    // into that recovery; the message is what a human reads. Only the message
    // has to be true about the linkage kind.
    const child = makeState(CHILD, { parentLinkage: delegationLinkage(CHILD) });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();

    const result = await propagateTerminalChildUpward(makeDeps({ onLinkageCycle }), child, 'pass');

    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledWith({
      cause: 'repeat',
      repeatedRunId: CHILD,
      code: 'INLINE_PARENT_CYCLE',
      message: `Parent linkage cycle detected at ${CHILD}`,
    });
    // The message must not assert a linkage kind the graph does not have. This
    // outlives the exact-string assertion above: a future reword still cannot
    // reintroduce "inline" on a delegation-only graph.
    const [trip] = onLinkageCycle.mock.calls[0];
    expect(trip.message).not.toMatch(/inline/i);
  });

  it('a cyclic DELEGATION linkage trips before recording report-only', async () => {
    // child(A) -> inline parent(B); B is delegation-linked back to A. The guard
    // is checked before the kind dispatch, so the report is refused too.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: delegationLinkage(CHILD),
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const recordChildCompletion = jest
      .fn<(args: unknown) => Promise<'recorded'>>()
      .mockResolvedValue('recorded');
    const result = await propagateTerminalChildUpward(
      makeDeps({
        advanceInlineParent,
        manager: { load },
        completionService: { recordChildCompletion },
      }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // Only the child's own record ran (level 1); the cyclic report never did.
    expect(recordChildCompletion).toHaveBeenCalledTimes(1);
    expect(recordChildCompletion).toHaveBeenCalledWith({ childState: child, result: 'pass' });
  });

  // --- #602: depth cap. The visited-set cannot bound a chain of DISTINCT ids;
  // the cap converts unbounded advance/release/reload work into a fixed bound.

  /** Nth synthetic run id in a long acyclic chain: rd_ + 32 hex chars. */
  const chainRunId = (n: number): RunId => assertRunId(`rd_${n.toString(16).padStart(32, '0')}`);

  it('bounds an over-deep acyclic chain at MAX_INLINE_PROPAGATION_CHAIN', async () => {
    // An unbounded chain of distinct ids: level n's parent is level n+1, forever.
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage: inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    // depth starts at 1 (the child) and grows by one per advance; the guard
    // refuses at depth === MAX, so exactly MAX - 1 advances run.
    expect(advanceInlineParent).toHaveBeenCalledTimes(MAX_INLINE_PROPAGATION_CHAIN - 1);
  });

  it('the cap is 64 — a documented bound, pinned so a change is deliberate', () => {
    expect(MAX_INLINE_PROPAGATION_CHAIN).toBe(64);
  });

  it('a chain exactly at the bound propagates normally (off-by-one boundary)', async () => {
    // MAX - 1 advances then a linkage-free root: the LAST legitimate chain. If the
    // guard used `>` instead of `>=`, or seeded depth at 0, this would still pass —
    // but the over-deep test above would then trip one level late. The two together
    // pin the boundary exactly.
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      // The final run in the chain is the root: no linkage, walk ends naturally.
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage:
          current === MAX_INLINE_PROPAGATION_CHAIN - 1
            ? undefined
            : inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load } }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(advanceInlineParent).toHaveBeenCalledTimes(MAX_INLINE_PROPAGATION_CHAIN - 1);
  });

  // --- #602: the trip's operator diagnostic. A fail-closed 'blocked' with no
  // named run leaves the operator unable to know which run to prune.

  it('names the repeated run on the sink when the visited set trips (#602)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(CHILD) });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(makeDeps({ onLinkageCycle }), child, 'pass');
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    // Core owns the operator message and code, mirroring the force-terminal
    // precedent (`lifecycle-command-service.ts` builds both for its
    // `INLINE_PARENT_CYCLE`). The frontend renders; it does not compose.
    expect(onLinkageCycle).toHaveBeenCalledWith({
      cause: 'repeat',
      repeatedRunId: CHILD,
      code: 'INLINE_PARENT_CYCLE',
      message: `Parent linkage cycle detected at ${CHILD}`,
    });
  });

  it('reports the run the walk stalled at, not the entry child, on a deep cycle (#602)', async () => {
    // child(A) -> parent(B) -> back to B itself. The trip is found at level 2, so
    // the operator must be told to prune B — telling them A would be useless.
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentTerminal = makeState(PARENT, {
      lifecycle: 'completed',
      parentLinkage: inlineLinkage(PARENT),
    });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentTerminal);
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    expect(onLinkageCycle).toHaveBeenCalledWith({
      cause: 'repeat',
      repeatedRunId: PARENT,
      code: 'INLINE_PARENT_CYCLE',
      message: `Parent linkage cycle detected at ${PARENT}`,
    });
  });

  it('distinguishes the depth cause on an over-deep acyclic chain (#602)', async () => {
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage: inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    // The walk stalls trying to step from level MAX-1 onto level MAX. The depth
    // arm names its OWN field (`deepestRunId`) — a repeat names `repeatedRunId`.
    // One field whose meaning depended on a sibling string was the #602 review's
    // missing-type-structure finding; the union now makes each meaning explicit.
    expect(onLinkageCycle).toHaveBeenCalledWith({
      cause: 'depth',
      deepestRunId: chainRunId(MAX_INLINE_PROPAGATION_CHAIN - 1),
      code: 'INLINE_PARENT_CYCLE',
      message: `Parent linkage chain from ${chainRunId(MAX_INLINE_PROPAGATION_CHAIN - 1)} exceeded the maximum propagation depth of ${String(MAX_INLINE_PROPAGATION_CHAIN)}`,
    });
  });

  it('does not call a delegation-linked depth trip an "inline" chain (#602 review)', async () => {
    // The depth guard fires BEFORE the kind dispatch, so the run it stalls at may
    // carry a DELEGATION linkage — an inline chain that reaches the cap one level
    // below a delegation boundary. `inlineParentCycleMessage`'s own TSDoc holds
    // that wording asserting "inline" is "flatly false" for such a graph and sends
    // the operator hunting for a composition that does not exist. That rule is a
    // property of the guard, not of the repeat arm: it binds this arm identically.
    const child = makeState(chainRunId(0), { parentLinkage: inlineLinkage(chainRunId(1)) });
    let level = 1;
    const load = jest.fn<(id: string) => Promise<RunbookState | null>>(async () => {
      const current = level;
      level += 1;
      // The run the cap stalls at is delegation-linked; every level below is inline
      // (only the inline arm recurses, so only it can carry the walk this deep).
      return makeState(chainRunId(current), {
        lifecycle: 'completed',
        parentLinkage:
          current === MAX_INLINE_PROPAGATION_CHAIN - 1
            ? delegationLinkage(chainRunId(current + 1))
            : inlineLinkage(chainRunId(current + 1)),
      });
    });
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('linkage-cycle');
    expect(onLinkageCycle).toHaveBeenCalledTimes(1);
    const [trip] = onLinkageCycle.mock.calls[0];
    expect(trip.cause).toBe('depth');
    expect(trip.message).not.toMatch(/inline/i);
  });

  it('never fires the sink on a valid acyclic chain (#602)', async () => {
    const child = makeState(CHILD, { parentLinkage: inlineLinkage(PARENT) });
    const parentRoot = makeState(PARENT, { lifecycle: 'completed' });
    const load = jest
      .fn<(id: string) => Promise<RunbookState | null>>()
      .mockResolvedValue(parentRoot);
    const advanceInlineParent = jest
      .fn<AdvanceInlineParent>()
      .mockResolvedValue({ status: 'done' });
    const onLinkageCycle = jest.fn<(trip: LinkageCycleTrip) => void>();
    const result = await propagateTerminalChildUpward(
      makeDeps({ advanceInlineParent, manager: { load }, onLinkageCycle }),
      child,
      'pass',
    );
    expect(result).toBe('handled');
    expect(onLinkageCycle).not.toHaveBeenCalled();
  });
});
