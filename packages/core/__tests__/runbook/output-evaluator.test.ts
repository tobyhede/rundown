import { describe, it, expect } from '@jest/globals';
import type { OutputDeclaration } from '@rundown-org/parser';
import type { ForContext, TemplateVarValue } from '../../src/runbook/types.js';
import {
  buildExecutionFrame,
  evaluateFrontmatterOutputDeclarations,
  evaluateOutputExpression,
  evaluateStepOutputDeclarations,
  flattenTemplateVars,
} from '../../src/runbook/output-evaluator.js';

describe('evaluateOutputExpression', () => {
  it('supports path helper, quoted literal, template reference, and bare identifier forms', () => {
    expect(
      evaluateOutputExpression('{{ path "plan.json" }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'ctx-abc',
      }),
    ).toMatch(/^\.rundown\/work\/demo\/\.rd-ctx-abc\/\d{4}-\d{2}-\d{2}-plan\.json$/);
    expect(evaluateOutputExpression('"literal"', {})).toBe('literal');
    expect(evaluateOutputExpression('{{ Region }}', { Region: 'us-east-1' })).toBe('us-east-1');
    expect(evaluateOutputExpression('PlanPath', { PlanPath: '/tmp/plan.md' })).toBe('/tmp/plan.md');
  });

  it('renders booleans and null the same way the CLI wrapper does today', () => {
    expect(evaluateOutputExpression('{{ enabled }}', { enabled: false })).toBe('false');
    expect(evaluateOutputExpression('{{ nullable }}', { nullable: null })).toBe('null');
  });
});

describe('evaluateStepOutputDeclarations', () => {
  it('skips naked-form step outputs and omits failed evaluations', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'Literal', value: '"value"' },
      { name: 'Naked' },
      { name: 'Missing', value: '{{ MissingVar }}' },
    ];

    expect(
      evaluateStepOutputDeclarations(outputs, {
        ContextId: 'ctx',
        WorkPath: '.rundown/work/demo',
      }),
    ).toEqual({
      Literal: 'value',
      Missing: '{{ MissingVar }}',
    });
  });
});

describe('evaluateFrontmatterOutputDeclarations', () => {
  it('supports naked-form export-by-name and value-form export', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'PlanPath' },
      { name: 'Mode', value: '"manual"' },
    ];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        PlanPath: '/tmp/plan.md',
      }),
    ).toEqual({
      PlanPath: '/tmp/plan.md',
      Mode: 'manual',
    });
  });
});

describe('flattenTemplateVars', () => {
  it('keeps scalars, stringifies objects, comma-joins arrays, and omits streams', () => {
    const vars: Record<string, TemplateVarValue> = {
      Region: 'us-east-1',
      Port: 3000,
      Items: ['a', 'b', 'c'],
      Config: { host: 'localhost', debug: true },
      Stream: { kind: 'json-array-stream', path: '/tmp/items.jsonl' },
    };

    expect(flattenTemplateVars(vars)).toEqual({
      Region: 'us-east-1',
      Port: 3000,
      Items: 'a,b,c',
      Config: '{"host":"localhost","debug":true}',
    });
  });
});

describe('buildExecutionFrame', () => {
  it('merges template vars, stored outputs, and the active FOR frame for the provided cursor', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 2,
        start: 1,
        end: 3,
        variable: 'item',
        implicit: false,
        source: { kind: 'variable', name: 'items' },
        currentValue: 'b',
      },
    ];

    expect(
      buildExecutionFrame(
        {
          templateVars: {
            ContextId: 'ctx-abc',
            WorkPath: '.rundown/work/demo',
            Message: 'template-value',
          },
          variables: {
            Message: 'stored-value',
            Existing: 'already-here',
          },
          forStack,
        },
        { stepName: '1', substepId: '1' },
      ),
    ).toMatchObject({
      ContextId: 'ctx-abc',
      WorkPath: '.rundown/work/demo',
      Message: 'stored-value',
      Existing: 'already-here',
      Step: '1.1',
      step: '1.1',
      Index: '2',
      index: '2',
      'context.current.step': '1.1',
      'context.current.substep': '1',
      'context.current.index': '2',
      'context.current.at': '1.2.1',
      item: 'b',
    });
  });
});
