import { describe, expect, it } from '@jest/globals';
import {
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  buildStepPosition,
  buildTargetKey,
  deriveActiveFrame,
  deriveExecutionAt,
  derivePositionAt,
  getActiveForContext,
  parseCompletionKey,
} from '../../src/runbook/targeting.js';
import type { ForContext, RunbookState } from '../../src/runbook/types.js';

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

  describe('buildCompletionKey', () => {
    it('builds completion key with substep', () => {
      expect(buildCompletionKey(buildFrameKey('1', 2), 3, '1')).toBe('1|2|3|1');
    });

    it('builds completion key without substep', () => {
      expect(buildCompletionKey(buildFrameKey('1', 2), 3)).toBe('1|2|3|');
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
        entry: 0,
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
        targetFrameKey: buildFrameKey('2', 3),
        targetEntry: 1,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(completion).toEqual({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '2',
        targetSubstep: '1',
        targetIteration: 3,
        targetFrameKey: buildFrameKey('2', 3),
        targetEntry: 1,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('omits targetSubstep and targetIteration when undefined', () => {
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'fail',
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 2,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(completion).not.toHaveProperty('targetSubstep');
      expect(completion).not.toHaveProperty('targetIteration');
    });

    it('defaults completedAt to current ISO timestamp', () => {
      const before = new Date().toISOString();
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '1',
        targetFrameKey: buildFrameKey('1'),
        targetEntry: 1,
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
          source: { kind: 'file', path: '/data.txt', format: 'text', snapshot: null },
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
});
