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

  it('throws when the path helper is used but WorkPath is missing', () => {
    expect(() => evaluateOutputExpression('{{ path "plan.json" }}', {})).toThrow(/WorkPath/);
  });

  it('throws when the path helper is used without ctx= and ContextId is missing', () => {
    expect(() =>
      evaluateOutputExpression('{{ path "plan.json" }}', { WorkPath: '.rundown/work/demo' }),
    ).toThrow(/ContextId/);
  });

  it('throws when ctx= expands to a value that is not a valid ContextId', () => {
    expect(() =>
      evaluateOutputExpression('{{ path "plan.json" ctx={{ Bad }} }}', {
        WorkPath: '.rundown/work/demo',
        Bad: 'not a valid id',
      }),
    ).toThrow(/valid ContextId/);
  });

  it('honours ctx= override with a nested Handlebars expression', () => {
    expect(
      evaluateOutputExpression('{{ path "plan.json" ctx={{ childCtx }} }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
        childCtx: 'child-123',
      }),
    ).toMatch(/\.rd-child-123\/.*-plan\.json$/);
  });

  it('honours ctx= override with a bare literal containing hyphens', () => {
    expect(
      evaluateOutputExpression('{{ path "plan.json" ctx=alt-ctx }}', {
        WorkPath: '.rundown/work/demo',
        ContextId: 'parent',
      }),
    ).toMatch(/\.rd-alt-ctx\/.*-plan\.json$/);
  });
});

describe('evaluateStepOutputDeclarations', () => {
  it('returns an empty map when there are no declarations', () => {
    expect(evaluateStepOutputDeclarations([], {})).toEqual({});
  });

  it('skips naked-form step outputs and leaves the value out of the result', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Literal', value: '"value"' }, { name: 'Naked' }];

    expect(evaluateStepOutputDeclarations(outputs, {})).toEqual({
      Literal: 'value',
    });
  });

  it('preserves literal-looking {{ VarName }} text when the variable is unresolved', () => {
    // Current behavior: the expander leaves the token alone when the path is
    // unknown, so the output string still contains the `{{ }}` — not an error.
    const outputs: OutputDeclaration[] = [{ name: 'Missing', value: '{{ MissingVar }}' }];

    expect(evaluateStepOutputDeclarations(outputs, {})).toEqual({
      Missing: '{{ MissingVar }}',
    });
  });

  it('omits entries whose expression evaluation throws (e.g. path helper without WorkPath)', () => {
    const outputs: OutputDeclaration[] = [
      { name: 'Plan', value: '{{ path "plan.json" }}' },
      { name: 'Literal', value: '"kept"' },
    ];

    expect(evaluateStepOutputDeclarations(outputs, {})).toEqual({
      Literal: 'kept',
    });
  });
});

describe('evaluateFrontmatterOutputDeclarations', () => {
  it('returns an empty map when there are no declarations', () => {
    expect(evaluateFrontmatterOutputDeclarations([], {})).toEqual({});
  });

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

  it('renders non-scalar naked values by delegating to renderOutputValue (boolean, number)', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Enabled' }, { name: 'Port' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Enabled: true,
        Port: 3000,
      }),
    ).toEqual({
      Enabled: 'true',
      Port: '3000',
    });
  });

  it('renders a naked null value as the string "null"', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Missing' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Missing: null,
      }),
    ).toEqual({
      Missing: 'null',
    });
  });

  it('omits naked entries whose referenced variable is absent from the frame', () => {
    const outputs: OutputDeclaration[] = [{ name: 'Present' }, { name: 'Absent' }];

    expect(
      evaluateFrontmatterOutputDeclarations(outputs, {
        Present: 'value',
      }),
    ).toEqual({
      Present: 'value',
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

  it('omits Index keys when the FOR stack is empty (non-FOR step cursor)', () => {
    const frame = buildExecutionFrame({ variables: {}, forStack: [] }, { stepName: '1' });

    expect(frame).toMatchObject({
      Step: '1',
      step: '1',
      'context.current.step': '1',
      'context.current.at': '1',
    });
    expect(frame).not.toHaveProperty('Index');
    expect(frame).not.toHaveProperty('index');
    expect(frame).not.toHaveProperty('context.current.index');
  });

  it('omits Index keys when the active FOR frame is implicit', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 2,
        variable: '',
        implicit: true,
        source: { kind: 'range', start: 1, end: 2 },
      },
    ];

    const frame = buildExecutionFrame({ variables: {}, forStack }, { stepName: '1' });

    expect(frame).not.toHaveProperty('Index');
    expect(frame).not.toHaveProperty('index');
  });

  it('omits Index keys when the cursor is on a step outside the active FOR frame', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 1,
        start: 1,
        end: 2,
        variable: 'outer',
        implicit: false,
        source: { kind: 'variable', name: 'outers' },
        currentValue: 'x',
      },
    ];

    const frame = buildExecutionFrame(
      { variables: {}, forStack },
      { stepName: '2', substepId: '1' },
    );

    expect(frame).not.toHaveProperty('Index');
    expect(frame.Step).toBe('2.1');
    expect(frame['context.current.at']).toBe('2.1');
  });

  it('sets the loop variable from iteration count for a range FOR source', () => {
    const forStack: ForContext[] = [
      {
        stepId: '1',
        iteration: 3,
        start: 1,
        end: 5,
        variable: 'n',
        implicit: false,
        source: { kind: 'range', start: 1, end: 5 },
      },
    ];

    const frame = buildExecutionFrame({ variables: {}, forStack }, { stepName: '1' });

    expect(frame.n).toBe('3');
    expect(frame.Index).toBe('3');
  });

  it('uses empty cursor for terminal-entry frontmatter evaluation', () => {
    // At terminal entry there is no active step — callers pass stepName: '' so
    // Step/step/context.current.step render as empty strings. Outputs that resolve
    // by name from templateVars or stored variables remain unaffected.
    const frame = buildExecutionFrame(
      {
        templateVars: { PlanPath: '/tmp/plan.md' },
        variables: { Stored: 'kept' },
        forStack: [],
      },
      { stepName: '' },
    );

    expect(frame.Step).toBe('');
    expect(frame.step).toBe('');
    expect(frame['context.current.step']).toBe('');
    expect(frame.PlanPath).toBe('/tmp/plan.md');
    expect(frame.Stored).toBe('kept');
  });
});
