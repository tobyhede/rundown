import { describe, it, expect, jest } from '@jest/globals';
import {
  propagateTerminalChildUpward,
  type AdvanceInlineParent,
  type PropagateTerminalChildUpwardDeps,
} from '../../src/runbook/inline-parent-advance.js';
import {
  assertRunId,
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
    tokenHash:
      'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as DelegationLinkage['tokenHash'],
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
  } as RunbookState;
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
        .fn<() => Promise<'recorded' | 'duplicate' | 'not-applicable' | 'cancelled' | 'blocked'>>()
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
      .fn<() => Promise<'recorded'>>()
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
    const recordChildCompletion = jest.fn<() => Promise<'blocked'>>().mockResolvedValue('blocked');
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
      .fn<() => Promise<'not-applicable'>>()
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
      .fn<() => Promise<'duplicate'>>()
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
      .fn<() => Promise<'cancelled'>>()
      .mockResolvedValue('cancelled');
    const result = await propagateTerminalChildUpward(
      makeDeps({ completionService: { recordChildCompletion } }),
      child,
      'pass',
    );
    expect(result).toBe('duplicate');
  });
});
