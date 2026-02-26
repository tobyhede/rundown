import { describe, it, expect } from '@jest/globals';
import {
  isValidResult,
  getStepRetryMax,
  buildStepVariables,
} from '../../src/services/execution.js';
import {
  isRunbookComplete,
  isRunbookStopped,
  type Step,
  type ForContext,
  type DataSource,
} from '@rundown-org/core';

describe('execution service', () => {
  describe('isRunbookComplete', () => {
    it('returns true when status is done and value is COMPLETE', () => {
      expect(isRunbookComplete({ status: 'done', value: 'COMPLETE' })).toBe(true);
    });

    it('returns false when status is not done', () => {
      expect(isRunbookComplete({ status: 'active', value: 'COMPLETE' })).toBe(false);
    });

    it('returns false when value is not COMPLETE', () => {
      expect(isRunbookComplete({ status: 'done', value: 'STOPPED' })).toBe(false);
    });
  });

  describe('isRunbookStopped', () => {
    it('returns true when status is done and value is STOPPED', () => {
      expect(isRunbookStopped({ status: 'done', value: 'STOPPED' })).toBe(true);
    });

    it('returns false when status is not done', () => {
      expect(isRunbookStopped({ status: 'active', value: 'STOPPED' })).toBe(false);
    });

    it('returns false when value is not STOPPED', () => {
      expect(isRunbookStopped({ status: 'done', value: 'COMPLETE' })).toBe(false);
    });
  });

  describe('isValidResult', () => {
    it('returns true for pass', () => {
      expect(isValidResult('pass')).toBe(true);
    });
    it('returns true for fail', () => {
      expect(isValidResult('fail')).toBe(true);
    });
    it('returns false for other strings', () => {
      expect(isValidResult('other')).toBe(false);
      expect(isValidResult('')).toBe(false);
    });
  });

  describe('getStepRetryMax', () => {
    it('returns fail retry count if present', () => {
      const step = {
        transitions: {
          fail: { retry: 3 },
          pass: { retry: 0 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(3);
    });

    it('returns pass retry count if fail retry is 0', () => {
      const step = {
        transitions: {
          fail: { retry: 0 },
          pass: { retry: 2 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(2);
    });

    it('returns 0 if no retry', () => {
      const step = {
        transitions: {
          fail: { retry: 0 },
          pass: { retry: 0 },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(0);
    });

    it('returns 0 if transitions missing', () => {
      const step = {} as unknown as Step;
      expect(getStepRetryMax(step)).toBe(0);
    });
  });

  describe('buildStepVariables', () => {
    it('returns Step for simple step', () => {
      const vars = buildStepVariables('3', undefined);
      expect(vars).toMatchObject({
        Step: '3',
        step: '3',
        'context.current.step': '3',
        'context.current.at': '3',
      });
    });

    it('returns Step for substep', () => {
      const vars = buildStepVariables('3', '1');
      expect(vars).toMatchObject({
        Step: '3.1',
        step: '3.1',
        'context.current.step': '3.1',
        'context.current.substep': '1',
        'context.current.at': '3.1',
      });
    });

    // Shorthand-canonicalized workflow steps (e.g., `## 2. Review`) get an implicit
    // substep `.1`, so Step resolves to `2.1` rather than just `2`.
    it('returns Step as N.1 for shorthand-canonicalized workflow steps', () => {
      const vars = buildStepVariables('2', '1');
      expect(vars).toMatchObject({
        Step: '2.1',
        step: '2.1',
        'context.current.step': '2.1',
        'context.current.substep': '1',
        'context.current.at': '2.1',
      });
    });

    it('returns Step for named step', () => {
      const vars = buildStepVariables('ErrorHandler', undefined);
      expect(vars).toMatchObject({
        Step: 'ErrorHandler',
        step: 'ErrorHandler',
        'context.current.step': 'ErrorHandler',
        'context.current.at': 'ErrorHandler',
      });
    });

    it('returns Index and named variable from forStack', () => {
      const vars = buildStepVariables('1', '1', [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'batch',
          implicit: false,
          source: { kind: 'range' },
        },
      ]);
      expect(vars).toMatchObject({ Step: '1.1', Index: '2', batch: '2' });
    });

    it('omits Index for implicit ForContext', () => {
      const vars = buildStepVariables('1', '1', [
        { stepId: '1', iteration: 1, start: 1, end: 1, implicit: true, source: { kind: 'range' } },
      ]);
      expect(vars).toMatchObject({
        Step: '1.1',
        step: '1.1',
        'context.current.step': '1.1',
        'context.current.substep': '1',
        'context.current.at': '1.1',
      });
      expect(vars).not.toHaveProperty('Index');
    });

    it('falls back to forClause when forStack empty', () => {
      const vars = buildStepVariables('1', '1', [], { start: 1, end: 3 });
      expect(vars).toMatchObject({ Step: '1.1', Index: '1' });
    });
  });

  describe('buildStepVariables with data sources', () => {
    it('resolves array source value from currentValue', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'server',
          implicit: false,
          source: { kind: 'array', items: ['alpha', 'beta', 'gamma'] },
          currentValue: 'beta',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.server).toBe('beta');
      expect(vars.Index).toBe('2');
    });

    it('resolves range source value as iteration number (unchanged behavior)', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          variable: 'i',
          implicit: false,
          source: { kind: 'range' },
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.i).toBe('3');
      expect(vars.Index).toBe('3');
    });

    it('resolves file source value from currentValue', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'host',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/hosts.txt',
            format: 'text' as const,
            snapshot: null,
          },
          currentValue: 'web-server-01',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.host).toBe('web-server-01');
      expect(vars.Index).toBe('1');
    });

    it('uses empty string for array source when currentValue is undefined (no silent fallback)', () => {
      // When currentValue is not set, we should get empty string,
      // not silently fall back to items[iteration-1]. An unset currentValue
      // for an array source indicates a compiler bug that should surface.
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'server',
          implicit: false,
          source: { kind: 'array', items: ['alpha', 'beta', 'gamma'] },
          // currentValue intentionally omitted
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      // After the fix, should be '' not 'beta'
      expect(vars.server).toBe('');
    });

    it('uses empty string for file source when currentValue is undefined', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'line',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/f.txt',
            format: 'text' as const,
            snapshot: null,
          },
          // currentValue intentionally omitted
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.line).toBe('');
      expect(vars.Index).toBe('1');
    });

    it('falls back to forClause for array source bootstrap (no forStack)', () => {
      const sources: Readonly<Record<string, DataSource>> = {
        items: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const forClause = {
        start: 1,
        end: 3,
        variable: 'item',
        source: 'items',
      } as unknown as Step['forClause'];

      const vars = buildStepVariables('1', '1', [], forClause, sources);
      expect(vars.item).toBe('a');
      expect(vars.Index).toBe('1');
    });

    it('falls back to forClause for file source bootstrap (no forStack)', () => {
      const sources: Readonly<Record<string, DataSource>> = {
        data: {
          kind: 'file',
          path: '/tmp/data.txt',
          format: 'text' as const,
        },
      };
      const forClause = {
        start: 1,
        variable: 'line',
        source: 'data',
      } as unknown as Step['forClause'];

      const vars = buildStepVariables('1', '1', [], forClause, sources);
      expect(vars.line).toBe('');
      expect(vars.Index).toBe('1');
    });

    it('omits Index for implicit forStack even with source present', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 1,
          variable: 'item',
          implicit: true,
          source: { kind: 'array', items: ['x'] },
          currentValue: 'x',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      // Implicit entries omit both Index and the named variable
      expect(vars).not.toHaveProperty('Index');
      expect(vars).not.toHaveProperty('item');
    });

    it('resolves currentValue from array source at windowed position', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 4,
          variable: 'item',
          implicit: false,
          source: { kind: 'array', items: ['a', 'b', 'c', 'd'] },
          currentValue: 'c',
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.item).toBe('c');
      expect(vars.Index).toBe('3');
    });

    it('clamps bootstrap array index when forClause.start exceeds array length', () => {
      const sources: Readonly<Record<string, DataSource>> = {
        items: { kind: 'array', items: ['a', 'b', 'c'] },
      };
      const forClause = {
        start: 100,
        end: 200,
        variable: 'item',
        source: 'items',
      } as unknown as Step['forClause'];

      const vars = buildStepVariables('1', '1', [], forClause, sources);
      // Clamped to array length (3), matching compiler behavior
      expect(vars.Index).toBe('3');
      expect(vars.item).toBe('c');
    });

    it('preserves JSONL object currentValue in variable map', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'record',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/data.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          currentValue: { host: 'server-a', region: 'us-west' },
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.record).toEqual({ host: 'server-a', region: 'us-west' });
      expect(vars.Index).toBe('1');
    });

    it('preserves JSONL primitive currentValue (number) in variable map', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 3,
          variable: 'count',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/nums.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          currentValue: 42,
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.count).toBe(42);
    });

    it('preserves JSONL boolean currentValue in variable map', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'enabled',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/bools.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          currentValue: false,
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.enabled).toBe(false);
    });

    it('preserves JSONL null currentValue in variable map', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          end: 2,
          variable: 'nullable',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/nulls.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          currentValue: null,
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.nullable).toBe(null);
    });

    it('keeps Index and Step as strings even with object-valued loop variables', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 5,
          variable: 'config',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/config.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          currentValue: { name: 'test', value: 100 },
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.Step).toBe('1.1');
      expect(vars.Index).toBe('3');
      expect(typeof vars.Step).toBe('string');
      expect(typeof vars.Index).toBe('string');
      expect(vars.config).toEqual({ name: 'test', value: 100 });
    });

    it('falls back to empty string for file JSONL when currentValue is undefined', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'item',
          implicit: false,
          source: {
            kind: 'file',
            path: '/tmp/data.jsonl',
            format: 'jsonl' as const,
            snapshot: null,
          },
          // currentValue intentionally omitted
        },
      ];

      const vars = buildStepVariables('1', '1', forStack);
      expect(vars.item).toBe('');
    });
  });
});
