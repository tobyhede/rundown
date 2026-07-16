import { describe, it, expect, jest } from '@jest/globals';
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
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
});
