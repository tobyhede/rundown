import { describe, it, expect } from '@jest/globals';
import {
  isValidResult,
  getStepRetryMax,
  buildStepVariables,
} from '../../src/services/execution.js';
import { expandLoopVariables } from '../../src/services/template-renderer.js';
import {
  createJsonArrayStream,
  isRunbookComplete,
  isRunbookStopped,
  type ForContext,
  type TemplateVarValue,
} from '@rundown-org/core';
import type { ForClause, Step } from '@rundown-org/parser';

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

    it('returns 0 if no retry configured', () => {
      const step = {
        transitions: {
          pass: { kind: 'pass', retry: 0, action: { type: 'CONTINUE' } },
          fail: { kind: 'fail', retry: 0, action: { type: 'STOP' } },
        },
      } as unknown as Step;
      expect(getStepRetryMax(step)).toBe(0);
    });
  });

  describe('buildStepVariables', () => {
    it('returns Step for simple step', () => {
      const vars = buildStepVariables({ stepId: '3' });
      expect(vars).toMatchObject({
        Step: '3',
        step: '3',
        'context.current.step': '3',
        'context.current.at': '3',
      });
    });

    it('returns Step for substep', () => {
      const vars = buildStepVariables({ stepId: '3', substepId: '1' });
      expect(vars).toMatchObject({
        Step: '3.1',
        step: '3.1',
        'context.current.step': '3.1',
        'context.current.substep': '1',
        'context.current.at': '3.1',
      });
    });

    // Shorthand-canonicalized runbook-list steps (e.g., `## 2. Review`) get an implicit
    // substep `.1`, so Step resolves to `2.1` rather than just `2`.
    it('returns Step as N.1 for shorthand-canonicalized runbook-list steps', () => {
      const vars = buildStepVariables({ stepId: '2', substepId: '1' });
      expect(vars).toMatchObject({
        Step: '2.1',
        step: '2.1',
        'context.current.step': '2.1',
        'context.current.substep': '1',
        'context.current.at': '2.1',
      });
    });

    it('returns Step for named step', () => {
      const vars = buildStepVariables({ stepId: 'ErrorHandler' });
      expect(vars).toMatchObject({
        Step: 'ErrorHandler',
        step: 'ErrorHandler',
        'context.current.step': 'ErrorHandler',
        'context.current.at': 'ErrorHandler',
      });
    });

    it('returns Index and named variable from forStack', () => {
      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [
          {
            stepId: '1',
            iteration: 2,
            start: 1,
            end: 3,
            variable: 'batch',
            implicit: false,
            source: { kind: 'range' },
          },
        ],
      });
      expect(vars).toMatchObject({ Step: '1.1', Index: '2', batch: '2' });
    });

    it('omits Index for implicit ForContext', () => {
      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [
          {
            stepId: '1',
            iteration: 1,
            start: 1,
            end: 1,
            implicit: true,
            source: { kind: 'range' },
          },
        ],
      });
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
      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [],
        forClause: { start: 1, end: 3 },
      });
      expect(vars).toMatchObject({ Step: '1.1', Index: '1' });
    });
  });

  describe('buildStepVariables with data sources', () => {
    it('resolves variable source value from currentValue', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'server',
          implicit: false,
          source: { kind: 'variable', name: 'servers' },
          currentValue: 'beta',
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
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

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.i).toBe('3');
      expect(vars.Index).toBe('3');
    });

    it('resolves variable source value from currentValue (file-backed)', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'host',
          implicit: false,
          source: { kind: 'variable', name: 'hosts' },
          currentValue: 'web-server-01',
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.host).toBe('web-server-01');
      expect(vars.Index).toBe('1');
    });

    it('throws on unresolved variable source (array)', () => {
      // An unset currentValue for a variable source is a protocol violation —
      // Machine-owned iteration resolution must run before buildStepVariables.
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 3,
          variable: 'server',
          implicit: false,
          source: { kind: 'variable', name: 'servers' },
          // currentValue intentionally omitted
        },
      ];

      expect(() => buildStepVariables({ stepId: '1', substepId: '1', forStack })).toThrow(
        /has not been resolved/,
      );
    });

    it('throws on unresolved variable source (file-backed)', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'line',
          implicit: false,
          source: { kind: 'variable', name: 'lines' },
          // currentValue intentionally omitted
        },
      ];

      expect(() => buildStepVariables({ stepId: '1', substepId: '1', forStack })).toThrow(
        /has not been resolved/,
      );
    });

    it('falls back to forClause for array variable bootstrap (no forStack)', () => {
      const templateVars: Readonly<Record<string, TemplateVarValue>> = {
        items: ['a', 'b', 'c'],
      };
      const forClause = {
        start: 1,
        end: 3,
        variable: 'item',
        source: 'items',
      } satisfies ForClause;

      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [],
        forClause,
        templateVars,
      });
      expect(vars.item).toBe('a');
      expect(vars.Index).toBe('1');
    });

    it('falls back to forClause for stream variable bootstrap (no forStack)', () => {
      const templateVars: Readonly<Record<string, TemplateVarValue>> = {
        data: createJsonArrayStream('/tmp/data.txt'),
      };
      const forClause = {
        start: 1,
        variable: 'line',
        source: 'data',
      } satisfies ForClause;

      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [],
        forClause,
        templateVars,
      });
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
          source: { kind: 'variable', name: 'items' },
          currentValue: 'x',
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      // Implicit entries omit both Index and the named variable
      expect(vars).not.toHaveProperty('Index');
      expect(vars).not.toHaveProperty('item');
    });

    it('resolves currentValue from variable source at windowed position', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 3,
          start: 1,
          end: 4,
          variable: 'item',
          implicit: false,
          source: { kind: 'variable', name: 'items' },
          currentValue: 'c',
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.item).toBe('c');
      expect(vars.Index).toBe('3');
    });

    it('clamps bootstrap array index when forClause.start exceeds array length', () => {
      const templateVars: Readonly<Record<string, TemplateVarValue>> = {
        items: ['a', 'b', 'c'],
      };
      const forClause = {
        start: 100,
        end: 200,
        variable: 'item',
        source: 'items',
      } satisfies ForClause;

      const vars = buildStepVariables({
        stepId: '1',
        substepId: '1',
        forStack: [],
        forClause,
        templateVars,
      });
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
          source: { kind: 'variable', name: 'records' },
          currentValue: { host: 'server-a', region: 'us-west' },
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
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
          source: { kind: 'variable', name: 'counts' },
          currentValue: 42,
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
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
          source: { kind: 'variable', name: 'flags' },
          currentValue: false,
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.enabled).toBe(false);
      expect(expandLoopVariables('enabled={{enabled}}', vars)).toBe('enabled=false');
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
          source: { kind: 'variable', name: 'nullables' },
          currentValue: null,
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.nullable).toBe(null);
      expect(expandLoopVariables('nullable={{nullable}}', vars)).toBe('nullable=null');
    });

    it('preserves JSONL boolean currentValue (true) through prompt rendering', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 2,
          start: 1,
          end: 2,
          variable: 'active',
          implicit: false,
          source: { kind: 'variable', name: 'flags' },
          currentValue: true,
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.active).toBe(true);
      expect(expandLoopVariables('active={{active}}', vars)).toBe('active=true');
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
          source: { kind: 'variable', name: 'configs' },
          currentValue: { name: 'test', value: 100 },
        },
      ];

      const vars = buildStepVariables({ stepId: '1', substepId: '1', forStack });
      expect(vars.Step).toBe('1.1');
      expect(vars.Index).toBe('3');
      expect(typeof vars.Step).toBe('string');
      expect(typeof vars.Index).toBe('string');
      expect(vars.config).toEqual({ name: 'test', value: 100 });
    });

    it('throws on unresolved variable source (JSONL)', () => {
      const forStack: ForContext[] = [
        {
          stepId: '1',
          iteration: 1,
          start: 1,
          variable: 'item',
          implicit: false,
          source: { kind: 'variable', name: 'data' },
          // currentValue intentionally omitted
        },
      ];

      expect(() => buildStepVariables({ stepId: '1', substepId: '1', forStack })).toThrow(
        /has not been resolved/,
      );
    });
  });
});
