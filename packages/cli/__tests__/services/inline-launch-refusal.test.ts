import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ErrorCodes, type InlineLaunchIntent } from '@rundown-org/core';
import type { InlineLaunchLatch } from '../../src/services/inline-launch-latch.js';

// The launch span's REFUSAL arms, which review found were reporting two
// different lies about what the store said:
//
//  1. Every non-`concurrent_modification` refusal from the latch's commit was
//     flattened to `superseded`, which the span renders as the benign "the
//     launch moved on, re-run to observe". An execution-ownership refusal is
//     not that, and `recovery_required` in particular can never clear by
//     repeating the gesture.
//  2. A spent optimistic-retry budget threw `ConcurrentStateModificationError`
//     straight out of the span into `activateRunProgression`, even though the
//     latch's own TSDoc said "the CLI wrapper reports it as RD-308". Nothing
//     caught it, so a transient, retryable condition arrived as an untyped
//     failure carrying no recovery classification.
//
// Only the latch is substituted: each arm below returns before the span
// touches the manager, the session, or the child, so the refusal is the whole
// observable behaviour.
const actualLatch = await import('../../src/services/inline-launch-latch.js');
const latchInlineLaunch = jest.fn<() => Promise<InlineLaunchLatch>>();
jest.unstable_mockModule('../../src/services/inline-launch-latch.js', () => ({
  ...actualLatch,
  latchInlineLaunch,
}));

const { launchInlineChildFromIntent, CONTENTION_LAUNCH_CODES } = await import(
  '../../src/services/execution.js'
);
const core = await import('@rundown-org/core');

const PARENT_RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD_RUN_ID = 'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const INTENT: InlineLaunchIntent = {
  parentRunId: PARENT_RUN_ID,
  parentStepId: '1',
  parentStep: '1',
  parentFrameKey: '1|',
  parentEntry: 1,
  childRunId: CHILD_RUN_ID,
  childRunbookPath: 'child.runbook.md',
  childRunbookRef: { source: 'project', path: 'child.runbook.md' },
  // Never read on these arms; branded through `unknown` rather than staged,
  // for the same reason the services above are bare doubles.
  contextSnapshot: { vars: {}, ancestors: [] } as unknown as InlineLaunchIntent['contextSnapshot'],
};

/**
 * Drive the launch span far enough to observe its refusal.
 *
 * @returns The span's dispatch result plus every event it announced.
 */
async function launch(): Promise<{
  readonly result: Awaited<ReturnType<typeof launchInlineChildFromIntent>>;
  readonly emitted: { type: string; payload?: { message?: string; code?: string } }[];
}> {
  const emitted: { type: string; payload?: { message?: string; code?: string } }[] = [];
  const result = await launchInlineChildFromIntent({
    manager: {} as never,
    // Branded by core in production; only `runId` is read before the span
    // returns, so the double carries exactly that.
    authority: { runId: core.assertRunId(PARENT_RUN_ID) } as never,
    actorService: {} as never,
    sessionService: {} as never,
    emitter: {
      emit: (event: unknown) => {
        emitted.push(event as { type: string; payload?: { message?: string; code?: string } });
      },
    },
    cwd: '/test',
    steps: [],
    intent: INTENT,
    prompted: false,
    output: { warning: () => undefined } as never,
    driveProgression: async () => {
      throw new Error('the refusal arms must return before any progression is driven');
    },
  });
  return { result, emitted };
}

describe('inline launch refusals keep the store’s own answer', () => {
  beforeEach(() => {
    latchInlineLaunch.mockReset();
  });

  it.each([
    ['execution_in_progress', 'EXECUTION_IN_PROGRESS', 'retryable'],
    ['recovery_required', 'RECOVERY_REQUIRED', 'permanent'],
  ] as const)(
    'reports a %s commit refusal under its own code with %s recovery',
    async (kind, code, recovery) => {
      latchInlineLaunch.mockResolvedValue({
        kind: 'store-refused',
        refusal: {
          kind,
          runId: core.assertRunId(PARENT_RUN_ID),
          message: `Run ${PARENT_RUN_ID} is ${kind}`,
          ...(kind === 'recovery_required' ? { epoch: 3 } : {}),
        },
      } as InlineLaunchLatch);

      const { result, emitted } = await launch();

      // NOT `{kind:'waiting'}` with a "was superseded" warning, which is what
      // the collapse to `superseded` produced for both of these.
      expect(result).toMatchObject({ kind: 'launch_refused', code, recovery });
      expect(emitted).toContainEqual(
        expect.objectContaining({
          type: 'ERROR_OCCURRED',
          payload: expect.objectContaining({ code }),
        }),
      );
    },
  );

  it('reports a spent optimistic-retry budget as retryable RD-308 rather than throwing', async () => {
    latchInlineLaunch.mockRejectedValue(
      new core.ConcurrentStateModificationError(
        core.assertRunId(PARENT_RUN_ID),
        `Run ${PARENT_RUN_ID} changed while latching inline launch`,
      ),
    );

    const { result, emitted } = await launch();

    const code = ErrorCodes.CONCURRENT_STATE_MODIFICATION.code;
    expect(result).toMatchObject({ kind: 'launch_refused', code, recovery: 'retryable' });
    // Membership, not a repeated literal: the classification and the set that
    // produces it must stay one fact.
    expect(CONTENTION_LAUNCH_CODES.has(code)).toBe(true);
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: 'ERROR_OCCURRED',
        payload: expect.objectContaining({ code }),
      }),
    );
  });

  it('still lets an unrelated throw out of the latch escape unchanged', async () => {
    // The catch is scoped to the ONE documented throw. Swallowing anything
    // else would turn a genuine bug into a retryable refusal.
    latchInlineLaunch.mockRejectedValue(new Error('disk on fire'));

    await expect(launch()).rejects.toThrow('disk on fire');
  });
});
