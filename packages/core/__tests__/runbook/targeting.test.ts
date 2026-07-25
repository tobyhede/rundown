import { describe, expect, it } from '@jest/globals';
import {
  SENTINEL_ENTRY,
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  buildStepPosition,
  buildTargetKey,
  completionEntryForFrame,
  deriveActiveFrame,
  deriveExecutionAt,
  deriveOpenFrames,
  derivePositionAt,
  exactFrame,
  findSubstepState,
  frameHasExactEntry,
  getActiveForContext,
  inactiveFrame,
  parseCompletionKey,
  upsertSubstepState,
  classifyDelegationLiveness,
  type DelegationLivenessLinkage,
} from '../../src/runbook/targeting.js';
import type { ForContext, RunbookState, SubstepState } from '../../src/runbook/types.js';
import { assertDelegationTokenHash } from '../../src/runbook/delegation-token.js';
import { makeStepDelegation } from '../helpers/step-factories.js';

describe('targeting helpers', () => {
  describe('deriveExecutionAt', () => {
    it('derives step-only location for non-loop steps', () => {
      expect(deriveExecutionAt('1')).toBe('1');
    });

    it('derives step.substep location for non-loop substeps', () => {
      expect(deriveExecutionAt('1', '1')).toBe('1.1');
    });

    it('derives step.iteration location for loop-scoped step targets', () => {
      expect(deriveExecutionAt('1', undefined, 2)).toBe('1.2');
    });

    it('derives step.iteration.substep location for loop-scoped substeps', () => {
      expect(deriveExecutionAt('1', '1', 2)).toBe('1.2.1');
    });

    it('supports named steps with and without substeps', () => {
      expect(deriveExecutionAt('Recover')).toBe('Recover');
      expect(deriveExecutionAt('Recover', 'verify')).toBe('Recover.verify');
    });
  });

  describe('derivePositionAt', () => {
    it('derives location from canonical position fields', () => {
      expect(derivePositionAt({ current: '2' })).toBe('2');
      expect(derivePositionAt({ current: '2', substep: '1' })).toBe('2.1');
      expect(derivePositionAt({ current: '2', for: { index: 3 } })).toBe('2.3');
      expect(derivePositionAt({ current: '2', substep: '1', for: { index: 3 } })).toBe('2.3.1');
    });
  });

  describe('buildFrameKey', () => {
    it('builds non-loop frame key', () => {
      expect(buildFrameKey('1')).toBe('1|');
    });

    it('builds loop frame key', () => {
      expect(buildFrameKey('1', 2)).toBe('1|2');
    });
  });

  describe('Frame', () => {
    it('constructs an active frame with an entry', () => {
      const frameKey = buildFrameKey('1', 2);
      expect(activeFrame(frameKey, 7)).toEqual({
        kind: 'active',
        frameKey,
        entry: 7,
      });
    });

    it('constructs an exact frame with an entry', () => {
      const frameKey = buildFrameKey('1', 2);
      expect(exactFrame(frameKey, 7)).toEqual({
        kind: 'exact',
        frameKey,
        entry: 7,
      });
    });

    it('constructs an inactive frame without an entry', () => {
      const frameKey = buildFrameKey('1', 2);
      expect(inactiveFrame(frameKey)).toEqual({
        kind: 'inactive',
        frameKey,
      });
    });

    it('derives exact entries for active/exact frames and sentinel entry for inactive frames', () => {
      expect(completionEntryForFrame(activeFrame(buildFrameKey('1'), 3))).toBe(3);
      expect(completionEntryForFrame(exactFrame(buildFrameKey('1'), 4))).toBe(4);
      expect(completionEntryForFrame(inactiveFrame(buildFrameKey('1', 5)))).toBe(SENTINEL_ENTRY);
    });

    it('narrows frames that carry exact entries', () => {
      expect(frameHasExactEntry(activeFrame(buildFrameKey('1'), 3))).toBe(true);
      expect(frameHasExactEntry(exactFrame(buildFrameKey('1'), 4))).toBe(true);
      expect(frameHasExactEntry(inactiveFrame(buildFrameKey('1')))).toBe(false);
    });

    it('rejects non-positive entries in activeFrame', () => {
      const frameKey = buildFrameKey('1');
      expect(() => activeFrame(frameKey, 0)).toThrow(RangeError);
      expect(() => activeFrame(frameKey, -1)).toThrow(RangeError);
      expect(() => activeFrame(frameKey, Number.NaN)).toThrow(RangeError);
      expect(() => activeFrame(frameKey, 1.5)).toThrow(RangeError);
    });

    it('rejects non-positive entries in exactFrame', () => {
      const frameKey = buildFrameKey('1');
      expect(() => exactFrame(frameKey, 0)).toThrow(RangeError);
      expect(() => exactFrame(frameKey, -2)).toThrow(RangeError);
      expect(() => exactFrame(frameKey, Number.NaN)).toThrow(RangeError);
    });
  });

  describe('buildCompletionKey', () => {
    it('builds active-frame completion key with substep', () => {
      expect(buildCompletionKey(activeFrame(buildFrameKey('1', 2), 3), '1')).toBe('1|2|3|1');
    });

    it('builds exact-frame completion key with substep', () => {
      expect(buildCompletionKey(exactFrame(buildFrameKey('1', 2), 4), '1')).toBe('1|2|4|1');
    });

    it('builds inactive-frame completion key with sentinel entry', () => {
      expect(buildCompletionKey(inactiveFrame(buildFrameKey('1', 2)), '1')).toBe('1|2|0|1');
    });
  });

  describe('parseCompletionKey', () => {
    it('parses a valid key with substep', () => {
      expect(parseCompletionKey('1|2|3|1')).toEqual({
        frameKey: '1|2',
        entry: 3,
        substep: '1',
      });
    });

    it('parses a valid key without substep', () => {
      expect(parseCompletionKey('1||1|')).toEqual({
        frameKey: '1|',
        entry: 1,
      });
    });

    it('returns null for extra pipe segments', () => {
      expect(parseCompletionKey('1|2|3|1|extra')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseCompletionKey('')).toBeNull();
    });

    it('returns null for too few segments', () => {
      expect(parseCompletionKey('1|2')).toBeNull();
      expect(parseCompletionKey('1|2|3')).toBeNull();
    });

    it('returns null when entry is missing', () => {
      expect(parseCompletionKey('1|2||sub')).toBeNull();
    });

    it('accepts entry=0 as sentinel', () => {
      expect(parseCompletionKey('1|2|0|sub')).toEqual({
        frameKey: '1|2',
        entry: SENTINEL_ENTRY,
        substep: 'sub',
      });
    });

    it('returns null for negative entry', () => {
      expect(parseCompletionKey('1|2|-1|sub')).toBeNull();
    });

    it('rejects entry with trailing non-numeric characters', () => {
      expect(parseCompletionKey('1||3abc|sub')).toBeNull();
    });

    it('rejects entry with leading non-numeric characters', () => {
      expect(parseCompletionKey('1||abc3|sub')).toBeNull();
    });
  });

  describe('buildResolvedCompletion', () => {
    it('includes all fields when present', () => {
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '2',
        targetSubstep: '1',
        targetIteration: 3,
        targetFrame: exactFrame(buildFrameKey('2', 3), 1),
        finalVars: { childOutput: 'value' },
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(completion.targetFrameKey).toBe(buildFrameKey('2', 3));
      expect(completion.targetEntry).toBe(1);
      expect(completion).toEqual({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '2',
        targetSubstep: '1',
        targetIteration: 3,
        targetFrameKey: buildFrameKey('2', 3),
        targetEntry: 1,
        finalVars: { childOutput: 'value' },
        completedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('omits targetSubstep and targetIteration when undefined', () => {
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'fail',
        targetStep: '1',
        targetFrame: inactiveFrame(buildFrameKey('1')),
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(completion.targetFrameKey).toBe(buildFrameKey('1'));
      expect(completion.targetEntry).toBe(SENTINEL_ENTRY);
      expect(completion).not.toHaveProperty('targetSubstep');
      expect(completion).not.toHaveProperty('targetIteration');
    });

    it('defaults completedAt to current ISO timestamp', () => {
      const before = new Date().toISOString();
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '1',
        targetFrame: activeFrame(buildFrameKey('1'), 1),
      });
      const after = new Date().toISOString();
      expect(completion.completedAt >= before).toBe(true);
      expect(completion.completedAt <= after).toBe(true);
    });
  });

  describe('buildTargetKey', () => {
    it('returns step only key', () => {
      expect(buildTargetKey('1')).toBe('1||');
    });

    it('returns step with substep key', () => {
      expect(buildTargetKey('1', 'sub')).toBe('1|sub|');
    });

    it('returns step with iteration key', () => {
      expect(buildTargetKey('1', undefined, 2)).toBe('1||2');
    });

    it('returns step with both substep and iteration key', () => {
      expect(buildTargetKey('1', 'sub', 2)).toBe('1|sub|2');
    });
  });

  describe('getActiveForContext', () => {
    it('returns undefined for empty forStack', () => {
      expect(getActiveForContext([], '1')).toBeUndefined();
    });

    it('returns undefined for undefined forStack', () => {
      expect(getActiveForContext(undefined, '1')).toBeUndefined();
    });

    it('returns undefined when top stepId does not match', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '2',
          iteration: 1,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      expect(getActiveForContext(forStack, '1')).toBeUndefined();
    });

    it('returns undefined when top context is implicit', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 1,
          implicit: true,
          source: { kind: 'range' },
        },
      ];
      expect(getActiveForContext(forStack, '1')).toBeUndefined();
    });

    it('returns matching explicit context', () => {
      const context: ForContext = {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        implicit: false,
        source: { kind: 'range' },
      };
      const forStack: readonly ForContext[] = [context];
      expect(getActiveForContext(forStack, '1')).toBe(context);
    });
  });

  describe('deriveActiveFrame', () => {
    it('returns frame without iteration for non-loop state', () => {
      const state = { step: '1', forStack: undefined } as unknown as RunbookState;
      const frame = deriveActiveFrame(state);
      expect(frame).toEqual({
        frameKey: '1|',
        step: '1',
      });
      expect(frame.iteration).toBeUndefined();
    });

    it('returns frame with iteration for loop state with matching forStack', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = {
        step: '1',
        forStack,
      } as unknown as RunbookState;
      const frame = deriveActiveFrame(state);
      expect(frame).toEqual({
        frameKey: '1|2',
        step: '1',
        iteration: 2,
      });
    });

    it('returns frame without iteration when forStack does not match step', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '2',
          iteration: 1,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const state = {
        step: '1',
        forStack,
      } as unknown as RunbookState;
      const frame = deriveActiveFrame(state);
      expect(frame).toEqual({
        frameKey: '1|',
        step: '1',
      });
      expect(frame.iteration).toBeUndefined();
    });
  });

  describe('deriveOpenFrames', () => {
    const rangeContext = (stepId: string, iteration: number, implicit = false): ForContext => ({
      stepId,
      iteration,
      start: 1,
      end: 3,
      implicit,
      source: { kind: 'range' },
    });

    it('returns only the active frame when forStack is empty', () => {
      const state = { step: '1', forStack: [] } as unknown as RunbookState;
      const open = deriveOpenFrames(state);
      expect(open.has(buildFrameKey('1'))).toBe(true);
      expect(open.has(buildFrameKey('9', 9))).toBe(false);
    });

    it('returns only the active frame when forStack is undefined', () => {
      const state = { step: '1', forStack: undefined } as unknown as RunbookState;
      const open = deriveOpenFrames(state);
      expect(open.has(buildFrameKey('1'))).toBe(true);
      expect(open.has(buildFrameKey('1', 1))).toBe(false);
    });

    it('excludes implicit FOR contexts from the open set', () => {
      // An implicit context (synthetic 1..1 loop) must not contribute an open
      // frame. Active step `1` has no matching non-implicit context, so only
      // `1|` is open — the implicit `5|2` frame is excluded.
      const state = {
        step: '1',
        forStack: [rangeContext('5', 2, true)],
      } as unknown as RunbookState;
      const open = deriveOpenFrames(state);
      expect(open.has(buildFrameKey('1'))).toBe(true);
      expect(open.has(buildFrameKey('5', 2))).toBe(false);
    });

    it('includes every non-implicit FOR context at its current iteration (nested FOR)', () => {
      // Outer loop at step 2 iteration 1, inner loop at step 2.1 iteration 3,
      // cursor on the inner step. Both stack frames are open; the active-frame
      // add alone would only contribute `2.1|3`, so `2|1` being open pins the
      // forStack accumulation. A closed inner iteration and an unrelated frame
      // are not open.
      const state = {
        step: '2.1',
        forStack: [rangeContext('2', 1), rangeContext('2.1', 3)],
      } as unknown as RunbookState;
      const open = deriveOpenFrames(state);
      expect(open.has(buildFrameKey('2', 1))).toBe(true); // outer, from forStack
      expect(open.has(buildFrameKey('2.1', 3))).toBe(true); // inner + active frame
      expect(open.has(buildFrameKey('2.1', 2))).toBe(false); // closed inner iteration
      expect(open.has(buildFrameKey('9', 9))).toBe(false); // unrelated
    });

    it('does not treat a frame present only in frameEntryCounts as open', () => {
      // The monotonic entry counter retains closed-frame keys forever. Openness
      // is derived from forStack, not the counter, so a frame the loop has left
      // (`1|1`) is closed even though its entry count persists.
      const state = {
        step: '2',
        forStack: [],
        activeFrameKey: buildFrameKey('2'),
        frameEntryCounts: {
          [buildFrameKey('2')]: 4,
          [buildFrameKey('1', 1)]: 1,
        },
      } as unknown as RunbookState;
      const open = deriveOpenFrames(state);
      expect(open.has(buildFrameKey('2'))).toBe(true);
      expect(open.has(buildFrameKey('1', 1))).toBe(false);
    });
  });

  describe('buildStepPosition', () => {
    it('builds basic position with step and total', () => {
      const position = buildStepPosition('1', 3, undefined);
      expect(position).toEqual({
        current: '1',
        total: 3,
      });
      expect(position.substep).toBeUndefined();
      expect(position.for).toBeUndefined();
    });

    it('builds position with substep', () => {
      const position = buildStepPosition('1', 3, '1');
      expect(position).toEqual({
        current: '1',
        total: 3,
        substep: '1',
      });
      expect(position.for).toBeUndefined();
    });

    it('builds position with forStack matching step', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 5,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const position = buildStepPosition('1', 3, undefined, forStack);
      expect(position).toEqual({
        current: '1',
        total: 3,
        for: {
          index: 2,
          end: 5,
        },
      });
    });

    it('returns no for field when forStack does not match step', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '2',
          iteration: 1,
          start: 1,
          end: 3,
          implicit: false,
          source: { kind: 'range' },
        },
      ];
      const position = buildStepPosition('1', 3, undefined, forStack);
      expect(position).toEqual({
        current: '1',
        total: 3,
      });
      expect(position.for).toBeUndefined();
    });

    it('omits end field when forStack end is undefined', () => {
      const forStack: readonly ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          implicit: false,
          source: { kind: 'variable', name: 'data' },
        },
      ];
      const position = buildStepPosition('1', 3, undefined, forStack);
      expect(position).toEqual({
        current: '1',
        total: 3,
        for: {
          index: 1,
        },
      });
      expect(position.for?.end).toBeUndefined();
    });
  });

  describe('upsertSubstepState', () => {
    const fk1 = buildFrameKey('1');
    const fk1_2 = buildFrameKey('1', 2);
    const fk1_3 = buildFrameKey('1', 3);

    const pending = (id: string, frameKey: ReturnType<typeof buildFrameKey>): SubstepState => ({
      id,
      frameKey,
      status: 'pending' as const,
    });

    it('appends new entry when no match exists', () => {
      const result = upsertSubstepState([], '1', fk1, { status: 'running' });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ id: '1', frameKey: fk1, status: 'running' });
    });

    it('appends new entry for non-initialized frame (FOR loop)', () => {
      const existing = [pending('1', fk1_2)];
      const result = upsertSubstepState(existing, '1', fk1_3, { status: 'running' });
      expect(result).toHaveLength(2);
      expect(findSubstepState(result, '1', fk1_2)?.status).toBe('pending');
      expect(findSubstepState(result, '1', fk1_3)?.status).toBe('running');
    });

    it('updates existing entry when match is found', () => {
      const existing = [pending('1', fk1), pending('2', fk1)];
      const result = upsertSubstepState(existing, '1', fk1, { status: 'running' });
      expect(result).toHaveLength(2);
      expect(findSubstepState(result, '1', fk1)?.status).toBe('running');
      expect(findSubstepState(result, '2', fk1)?.status).toBe('pending');
    });

    it('does not match same id with different frameKey', () => {
      const existing = [pending('1', fk1_2)];
      const result = upsertSubstepState(existing, '1', fk1_3, { status: 'running' });
      expect(result).toHaveLength(2);
      expect(findSubstepState(result, '1', fk1_2)?.status).toBe('pending');
      expect(findSubstepState(result, '1', fk1_3)?.status).toBe('running');
    });

    it('preserves other fields when updating', () => {
      const existing: readonly SubstepState[] = [
        { id: '1', frameKey: fk1, status: 'pending', delegation: undefined },
      ];
      const result = upsertSubstepState(existing, '1', fk1, { status: 'running' });
      expect(result[0]).toEqual({
        id: '1',
        frameKey: fk1,
        status: 'running',
        delegation: undefined,
      });
    });

    it('defaults to pending status for new entries', () => {
      const result = upsertSubstepState([], '1', fk1, { result: 'pass' });
      expect(result[0]).toEqual({ id: '1', frameKey: fk1, status: 'pending', result: 'pass' });
    });
  });

  describe('classifyDelegationLiveness', () => {
    const TOKEN = assertDelegationTokenHash(`sha256:${'a'.repeat(64)}`);
    const OTHER_TOKEN = assertDelegationTokenHash(`sha256:${'b'.repeat(64)}`);
    const FRAME = buildFrameKey('1');

    const linkage: DelegationLivenessLinkage = {
      parentStep: '1',
      parentStepId: '1',
      parentFrameKey: FRAME,
      parentEntry: 1,
      tokenHash: TOKEN,
    };

    /** Build a parent state exposing only the fields the classifier reads. */
    function parent(over: Partial<RunbookState> = {}): RunbookState {
      return {
        step: '1',
        lifecycle: 'running',
        activeFrameKey: FRAME,
        activeEntry: 1,
        substepStates: [
          {
            id: '1',
            frameKey: FRAME,
            status: 'running',
            delegation: makeStepDelegation({ tokenHash: TOKEN }),
          },
        ],
        ...over,
      } as unknown as RunbookState;
    }

    it('classifies a matching, unresolved delegation as live', () => {
      const result = classifyDelegationLiveness(parent(), linkage);
      expect(result.kind).toBe('live');
    });

    it('treats a missing parent as a hard integrity signal, not a routine close', () => {
      expect(classifyDelegationLiveness(null, linkage)).toEqual({ kind: 'parent-unreadable' });
    });

    it.each([
      'completed',
      'stopped',
    ] as const)('closes as parent-ended when the parent is %s', (lifecycle) => {
      expect(classifyDelegationLiveness(parent({ lifecycle }), linkage)).toEqual({
        kind: 'closed',
        reason: 'parent-ended',
      });
    });

    it('closes as cursor-advanced when the top-level cursor moved past the step with no done row', () => {
      // #driveTopLevel advances the cursor without writing a `done` substep entry.
      expect(
        classifyDelegationLiveness(
          parent({ step: '2', activeFrameKey: buildFrameKey('2') }),
          linkage,
        ),
      ).toEqual({ kind: 'closed', reason: 'cursor-advanced' });
    });

    it('closes as cursor-advanced when the substep row is absent', () => {
      expect(classifyDelegationLiveness(parent({ substepStates: [] }), linkage)).toEqual({
        kind: 'closed',
        reason: 'cursor-advanced',
      });
    });

    it('closes as resolved when the delegated substep is done', () => {
      const state = parent({
        substepStates: [
          {
            id: '1',
            frameKey: FRAME,
            status: 'done',
            result: 'pass',
            delegation: makeStepDelegation({ tokenHash: TOKEN }),
          },
        ],
      });
      expect(classifyDelegationLiveness(state, linkage)).toEqual({
        kind: 'closed',
        reason: 'resolved',
      });
    });

    it('closes as token-reissued when the substep carries a different token (RETRY/GOTO reissue)', () => {
      const state = parent({
        substepStates: [
          {
            id: '1',
            frameKey: FRAME,
            status: 'running',
            delegation: makeStepDelegation({ tokenHash: OTHER_TOKEN }),
          },
        ],
      });
      expect(classifyDelegationLiveness(state, linkage)).toEqual({
        kind: 'closed',
        reason: 'token-reissued',
      });
    });

    it('closes as token-reissued when the substep no longer carries a delegation', () => {
      const state = parent({
        substepStates: [{ id: '1', frameKey: FRAME, status: 'running' }],
      });
      expect(classifyDelegationLiveness(state, linkage)).toEqual({
        kind: 'closed',
        reason: 'token-reissued',
      });
    });

    it('closes as resolved when the delegation was cancelled', () => {
      const state = parent({
        substepStates: [
          {
            id: '1',
            frameKey: FRAME,
            status: 'running',
            delegation: makeStepDelegation({
              tokenHash: TOKEN,
              cancelledAt: '2026-07-20T00:00:00.000Z',
            }),
          },
        ],
      });
      expect(classifyDelegationLiveness(state, linkage)).toEqual({
        kind: 'closed',
        reason: 'resolved',
      });
    });

    it('closes as cursor-advanced when the frame was re-entered past the captured entry', () => {
      // The active frame's entry advanced beyond the value captured on the claim.
      expect(classifyDelegationLiveness(parent({ activeEntry: 2 }), linkage)).toEqual({
        kind: 'closed',
        reason: 'cursor-advanced',
      });
    });

    it('closes as cursor-advanced on an entry mismatch recorded in frameEntryCounts', () => {
      const state = parent({
        activeFrameKey: buildFrameKey('other'),
        activeEntry: undefined,
        frameEntryCounts: { [FRAME]: 3 },
      });
      expect(classifyDelegationLiveness(state, linkage)).toEqual({
        kind: 'closed',
        reason: 'cursor-advanced',
      });
    });

    it('stays live when the frame carries no recorded entry to compare', () => {
      const state = parent({ activeFrameKey: buildFrameKey('other'), activeEntry: undefined });
      expect(classifyDelegationLiveness(state, linkage).kind).toBe('live');
    });
  });
});
