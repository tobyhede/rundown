import { describe, it, expect, jest } from '@jest/globals';
import {
  INLINE_PARENT_CYCLE_CODE,
  inlineParentCycleMessage,
  reportDelegatedTerminal,
} from '../../src/runbook/inline-parent-advance.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { buildFrameKey } from '../../src/runbook/targeting.js';
import type { RunbookCompletionService } from '../../src/runbook/completion-service.js';
import type { RunbookState } from '../../src/runbook/types.js';
import {
  brandInitialTemplateVarsForTest,
  brandStoredOutputsForTest,
} from '../../src/testing/effective-vars.js';

// `recordChildCompletion` answers with FIVE outcomes. `reportDelegatedTerminal`
// switched on three of them and swept the rest into a catch-all `duplicate`, so
// `cancelled` — the delegation is gone, nothing was recorded — reached the
// caller wearing the label of "already recorded". They are different facts with
// different remedies, and only an exhaustive switch makes a sixth outcome a
// build error rather than another silent collapse.

const CHILD_RUN_ID = assertRunId('rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PARENT_RUN_ID = assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function terminalChild(overrides: Partial<RunbookState> = {}): RunbookState {
  return {
    prompted: false,
    id: CHILD_RUN_ID,
    runbook: { source: 'project', path: 'child.md' },
    runbookPath: 'child.md',
    step: '1',
    stepName: 'Work',
    retryCount: 0,
    variables: brandStoredOutputsForTest({}),
    templateVars: brandInitialTemplateVarsForTest({ ContextId: 'ctx', WorkPath: '.rundown/work' }),
    steps: [],
    lifecycle: 'completed',
    lastResult: 'pass',
    startedAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:01:00.000Z',
    activeFrameKey: buildFrameKey('1'),
    activeEntry: 1,
    substepStates: [],
    resolvedCompletions: {},
    parentLinkage: {
      kind: 'delegation',
      parentRunId: PARENT_RUN_ID,
      parentStepId: '1',
      parentStep: '1',
      parentFrameKey: buildFrameKey('1'),
      parentEntry: 1,
    },
    ...overrides,
  } as unknown as RunbookState;
}

describe('reportDelegatedTerminal maps every completion outcome to its own kind', () => {
  it.each([
    ['recorded', 'reported'],
    ['duplicate', 'duplicate'],
    ['cancelled', 'cancelled'],
    ['blocked', 'refused'],
    ['not-applicable', 'not-applicable'],
  ] as const)('reports %s as %s', async (recorded, expected) => {
    const completionService = {
      recordChildCompletion: jest.fn(async () => recorded),
    } as unknown as RunbookCompletionService;

    await expect(
      reportDelegatedTerminal({ completionService }, terminalChild(), 'pass'),
    ).resolves.toEqual({ kind: expected });
  });
});

describe('reportDelegatedTerminal refuses before it records', () => {
  /**
   * A completion service whose recorder must never be reached.
   *
   * Every early refusal below is defined by what it does NOT do, so the
   * assertion that matters is the call count: returning the right `kind` while
   * still writing an outcome row onto a parent would be the same defect the
   * catch-all `duplicate` was.
   *
   * @returns The double, and the spy standing in for `recordChildCompletion`.
   */
  function unreachableRecorder(): {
    readonly completionService: RunbookCompletionService;
    readonly recordChildCompletion: jest.Mock<() => Promise<'recorded'>>;
  } {
    const recordChildCompletion = jest.fn(async () => 'recorded' as const);
    return {
      completionService: { recordChildCompletion } as unknown as RunbookCompletionService,
      recordChildCompletion,
    };
  }

  it('is not applicable to a child with no parent linkage at all', async () => {
    // A root run reaches this seam whenever a frontend reports a terminal
    // without knowing whether the run was delegated. `linkage?.kind` must
    // survive the absent linkage rather than dereferencing it.
    const { completionService, recordChildCompletion } = unreachableRecorder();

    await expect(
      reportDelegatedTerminal(
        { completionService },
        terminalChild({ parentLinkage: undefined }),
        'pass',
      ),
    ).resolves.toEqual({ kind: 'not-applicable' });
    expect(recordChildCompletion).not.toHaveBeenCalled();
  });

  it('is not applicable to an INLINE-linked child', async () => {
    // Inline composition advances its parent through the machine, not through
    // an outcome row. Reporting one here would record a delegation result for a
    // step that was never delegated.
    const { completionService, recordChildCompletion } = unreachableRecorder();

    await expect(
      reportDelegatedTerminal(
        { completionService },
        terminalChild({
          parentLinkage: {
            kind: 'inline',
            parentRunId: PARENT_RUN_ID,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          } as unknown as RunbookState['parentLinkage'],
        }),
        'pass',
      ),
    ).resolves.toEqual({ kind: 'not-applicable' });
    expect(recordChildCompletion).not.toHaveBeenCalled();
  });

  it('is not applicable to a child that has not reached a terminal lifecycle', async () => {
    // With no authored result the projection is inferred from lifecycle, and a
    // running child projects `not_terminal`. Nothing to report yet — reporting
    // one would fix an outcome for a run that can still pass or fail.
    const { completionService, recordChildCompletion } = unreachableRecorder();

    await expect(
      reportDelegatedTerminal(
        { completionService },
        terminalChild({ lifecycle: 'running', lastResult: undefined }),
        undefined,
      ),
    ).resolves.toEqual({ kind: 'not-applicable' });
    expect(recordChildCompletion).not.toHaveBeenCalled();
  });

  it('REFUSES a child stopped by command infrastructure rather than reporting a fail', async () => {
    // The arm that separates "refused" from "nothing to do". A policy denial or
    // a spawn failure is not a runbook FAIL: projecting one would tell the
    // parent its delegated step ran and failed, when it never ran at all.
    const { completionService, recordChildCompletion } = unreachableRecorder();

    await expect(
      reportDelegatedTerminal(
        { completionService },
        terminalChild({
          lifecycle: 'stopped',
          lastResult: undefined,
          lastAction: {
            type: 'POLICY_DENIED',
            origin: 'direct',
            message: 'blocked by policy',
          } as unknown as RunbookState['lastAction'],
        }),
        undefined,
      ),
    ).resolves.toEqual({ kind: 'refused' });
    expect(recordChildCompletion).not.toHaveBeenCalled();
  });

  it('surfaces a self-linked child as a linkage-cycle trip naming the run to prune', async () => {
    // A delegation edge pointing at its own run is corrupt persisted state, and
    // the recorder would happily write the child's outcome onto itself. The trip
    // carries the run to prune as DATA — core composes the message and code
    // because the frontend renders the refusal, it does not diagnose it.
    const { completionService, recordChildCompletion } = unreachableRecorder();

    await expect(
      reportDelegatedTerminal(
        { completionService },
        terminalChild({
          parentLinkage: {
            kind: 'delegation',
            parentRunId: CHILD_RUN_ID,
            parentStepId: '1',
            parentStep: '1',
            parentFrameKey: buildFrameKey('1'),
            parentEntry: 1,
          } as unknown as RunbookState['parentLinkage'],
        }),
        'pass',
      ),
    ).resolves.toEqual({
      kind: 'linkage-cycle',
      trip: {
        cause: 'repeat',
        repeatedRunId: CHILD_RUN_ID,
        code: INLINE_PARENT_CYCLE_CODE,
        message: inlineParentCycleMessage(CHILD_RUN_ID),
      },
    });
    expect(recordChildCompletion).not.toHaveBeenCalled();
  });

  it('throws on an unmapped completion outcome instead of collapsing it into duplicate', async () => {
    // The runtime half of the exhaustive switch. TypeScript makes a sixth
    // outcome a build error at the `never` assignment; this pins that the guard
    // behind it also fires at runtime, naming the outcome it could not map,
    // rather than silently answering `duplicate` the way the old catch-all did.
    const completionService = {
      recordChildCompletion: jest.fn(async () => 'quarantined'),
    } as unknown as RunbookCompletionService;

    await expect(
      reportDelegatedTerminal({ completionService }, terminalChild(), 'pass'),
    ).rejects.toThrow('Unhandled child completion outcome: quarantined');
  });
});
