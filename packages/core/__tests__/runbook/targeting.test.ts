import { describe, expect, it } from '@jest/globals';
import {
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
  deriveExecutionAt,
  derivePositionAt,
  parseCompletionKey,
} from '../../src/runbook/targeting.js';

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
      expect(buildCompletionKey('1|2', 3, '1')).toBe('1|2|3|1');
    });

    it('builds completion key without substep', () => {
      expect(buildCompletionKey('1|2', 3)).toBe('1|2|3|');
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

    it('returns null for zero entry', () => {
      expect(parseCompletionKey('1|2|0|sub')).toBeNull();
    });

    it('returns null for negative entry', () => {
      expect(parseCompletionKey('1|2|-1|sub')).toBeNull();
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
        targetFrameKey: '2|3',
        targetEntry: 1,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(completion).toEqual({
        agentId: 'agent-1',
        result: 'pass',
        targetStep: '2',
        targetSubstep: '1',
        targetIteration: 3,
        targetFrameKey: '2|3',
        targetEntry: 1,
        completedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('omits targetSubstep and targetIteration when undefined', () => {
      const completion = buildResolvedCompletion({
        agentId: 'agent-1',
        result: 'fail',
        targetStep: '1',
        targetFrameKey: '1|',
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
        targetFrameKey: '1|',
        targetEntry: 1,
      });
      const after = new Date().toISOString();
      expect(completion.completedAt >= before).toBe(true);
      expect(completion.completedAt <= after).toBe(true);
    });
  });
});
