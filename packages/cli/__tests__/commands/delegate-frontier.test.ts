import { describe, it, expect } from '@jest/globals';
import type { FrameKey, RunbookState, SubstepState } from '@rundown-org/core';
import { deriveFrontierFromState } from '../../src/commands/delegate.js';

/**
 * Build a minimal `SubstepState` carrying a pending (non-cancelled) delegation
 * with a recoverable token, scoped to a specific frame.
 *
 * Only the fields read by `deriveFrontierFromState` are populated; the value is
 * cast through `unknown` because the full persisted shape is irrelevant here.
 *
 * @param id - Substep id (e.g. "1").
 * @param frameKey - Frame key scoping this substep instance (e.g. "1|1").
 * @param token - Recoverable delegation token.
 * @returns A substep state with a pending delegation.
 */
function pendingDelegationSubstep(id: string, frameKey: string, token: string): SubstepState {
  return {
    id,
    frameKey: frameKey as FrameKey,
    status: 'pending',
    delegation: {
      token,
      cancelledAt: null,
      childRunbookRef: { path: 'child.runbook.md' },
    },
  } as unknown as SubstepState;
}

/**
 * Build a minimal `RunbookState` for a FOR step whose `substepStates` has
 * accumulated entries from multiple iterations.
 *
 * @param activeFrameKey - The frame the cursor is currently positioned in.
 * @param substeps - Per-frame substep states.
 * @returns A runbook state suitable for `deriveFrontierFromState`.
 */
function forLoopState(activeFrameKey: string, substeps: SubstepState[]): RunbookState {
  return {
    step: '1',
    activeFrameKey: activeFrameKey as FrameKey,
    substepStates: substeps,
  } as unknown as RunbookState;
}

describe('deriveFrontierFromState frame scoping', () => {
  // Regression: a FOR loop accumulates one substep entry per (id, frameKey).
  // Iteration 1 issued a delegation whose token is still recoverable; the cursor
  // has advanced to iteration 2 which issued its own. The derived frontier must
  // surface only the active frame's token. Without frame scoping the flat scan
  // returned both entries (same qualified id "1.1"), and resolveDelegateTarget's
  // first-match `.find` would surface iteration 1's stale token in iteration 2.
  it('returns only the active frame entry when iterations share a substep id', () => {
    const state = forLoopState('1|2', [
      pendingDelegationSubstep('1', '1|1', 'stale-iter1-token'),
      pendingDelegationSubstep('1', '1|2', 'fresh-iter2-token'),
    ]);

    const frontier = deriveFrontierFromState(state);

    expect(frontier).toHaveLength(1);
    expect(frontier[0]).toMatchObject({ id: '1.1', token: 'fresh-iter2-token' });
    // The earlier iteration's token must not leak across the frame boundary.
    expect(frontier.map((entry) => entry.token)).not.toContain('stale-iter1-token');
  });

  // Scoping is by frame, not by array position: the same input keyed to the
  // earlier active frame must surface that frame's token instead.
  it('is genuinely frame-scoped, not order-dependent', () => {
    const substeps = [
      pendingDelegationSubstep('1', '1|1', 'iter1-token'),
      pendingDelegationSubstep('1', '1|2', 'iter2-token'),
    ];

    expect(deriveFrontierFromState(forLoopState('1|1', substeps))).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'iter1-token' },
    ]);
    expect(deriveFrontierFromState(forLoopState('1|2', substeps))).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'iter2-token' },
    ]);
  });

  // Non-FOR steps use a bare frame key ("1|"); a single in-frame pending
  // delegation is still surfaced.
  it('surfaces a single non-FOR frame delegation', () => {
    const state = forLoopState('1|', [pendingDelegationSubstep('1', '1|', 'tok')]);

    expect(deriveFrontierFromState(state)).toEqual([
      { id: '1.1', runbook: 'child.runbook.md', token: 'tok' },
    ]);
  });
});
