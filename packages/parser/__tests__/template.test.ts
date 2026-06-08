import { describe, expect, it } from '@jest/globals';
import { tokenizeTemplate } from '../src/index.js';

describe('tokenizeTemplate', () => {
  it('returns one literal token for plain text', () => {
    expect(tokenizeTemplate('hello')).toEqual([{ kind: 'literal', text: 'hello' }]);
  });

  it('classifies plain and explicit variables', () => {
    expect(tokenizeTemplate('a {{ Name }} {{ ./path.0.value }}')).toEqual([
      { kind: 'literal', text: 'a ' },
      { kind: 'variable', name: 'Name', explicit: false, raw: '{{ Name }}' },
      { kind: 'literal', text: ' ' },
      { kind: 'variable', name: 'path.0.value', explicit: true, raw: '{{ ./path.0.value }}' },
    ]);
  });

  it('classifies built-in and user helpers', () => {
    expect(tokenizeTemplate('{{ path Plan }} {{ upper "abc" }}')).toEqual([
      {
        kind: 'builtinHelper',
        name: 'path',
        arg: { kind: 'ref', name: 'Plan' },
        raw: '{{ path Plan }}',
      },
      { kind: 'literal', text: ' ' },
      {
        kind: 'userHelper',
        name: 'upper',
        arg: { kind: 'literal', value: 'abc' },
        raw: '{{ upper "abc" }}',
      },
    ]);
  });

  it('preserves unsupported expressions as literal text', () => {
    expect(tokenizeTemplate('{{ }} {{ outer (inner x) }}')).toEqual([
      { kind: 'literal', text: '{{ }} {{ outer (inner x) }}' },
    ]);
  });

  it('preserves unsupported spans while still tokenizing later valid spans', () => {
    expect(tokenizeTemplate('x {{ }} y {{ A }}')).toEqual([
      { kind: 'literal', text: 'x {{ }} y ' },
      { kind: 'variable', name: 'A', explicit: false, raw: '{{ A }}' },
    ]);
  });

  it('handles adjacent tokens without inserting empty literals', () => {
    expect(tokenizeTemplate('{{ A }}{{ upper "b" }}')).toEqual([
      { kind: 'variable', name: 'A', explicit: false, raw: '{{ A }}' },
      {
        kind: 'userHelper',
        name: 'upper',
        arg: { kind: 'literal', value: 'b' },
        raw: '{{ upper "b" }}',
      },
    ]);
  });

  it('treats quoted literals containing closing braces as unsupported literal text', () => {
    expect(tokenizeTemplate('{{ validateSchema "a}}b" }}')).toEqual([
      { kind: 'literal', text: '{{ validateSchema "a}}b" }}' },
    ]);
  });

  it('preserves placeholders padded with excessive whitespace as literal text', () => {
    const raw = `{{${' '.repeat(256)}name}}`;
    expect(tokenizeTemplate(raw)).toEqual([{ kind: 'literal', text: raw }]);
  });

  it('classifies placeholders padded with whitespace within the edge bound', () => {
    const raw = `{{${' '.repeat(64)}name${' '.repeat(64)}}}`;
    expect(tokenizeTemplate(raw)).toEqual([
      { kind: 'variable', name: 'name', explicit: false, raw },
    ]);
  });
});

import {
  isTemplatePath,
  parseTemplateExpression,
  TEMPLATE_IDENTIFIER_PATTERN,
  TEMPLATE_PATH_PATTERN,
} from '../src/index.js';

describe('template grammar helpers', () => {
  it('validates identifiers and dotted paths through parser-owned regexes', () => {
    expect(TEMPLATE_IDENTIFIER_PATTERN.test('Name_1')).toBe(true);
    expect(TEMPLATE_IDENTIFIER_PATTERN.test('1Name')).toBe(false);
    expect(TEMPLATE_PATH_PATTERN.test('config.items.0.name')).toBe(true);
    expect(TEMPLATE_PATH_PATTERN.test('config..name')).toBe(false);
    expect(isTemplatePath('context.current.step')).toBe(true);
    expect(isTemplatePath('./context')).toBe(false);
  });
});

describe('parseTemplateExpression', () => {
  it('parses anchored variable and helper expressions', () => {
    expect(parseTemplateExpression('{{ ./PlanPath }}')).toEqual({
      ok: true,
      expression: {
        kind: 'variable',
        name: 'PlanPath',
        explicit: true,
        raw: '{{ ./PlanPath }}',
      },
    });

    expect(parseTemplateExpression('{{ path Artifact }}')).toEqual({
      ok: true,
      expression: {
        kind: 'builtinHelper',
        name: 'path',
        arg: { kind: 'ref', name: 'Artifact' },
        raw: '{{ path Artifact }}',
      },
    });

    expect(parseTemplateExpression('{{ upper "abc" }}')).toEqual({
      ok: true,
      expression: {
        kind: 'userHelper',
        name: 'upper',
        arg: { kind: 'literal', value: 'abc' },
        raw: '{{ upper "abc" }}',
      },
    });

    expect(parseTemplateExpression('{{ upper }}')).toEqual({
      ok: true,
      expression: {
        kind: 'variable',
        name: 'upper',
        explicit: false,
        raw: '{{ upper }}',
      },
    });
  });

  it('returns typed rejection reasons for malformed anchored expressions', () => {
    expect(parseTemplateExpression('{{ }}')).toEqual({
      ok: false,
      reason: 'empty',
      raw: '{{ }}',
    });
    expect(parseTemplateExpression('{{ ./bad-path }}')).toEqual({
      ok: false,
      reason: 'invalid-variable',
      raw: '{{ ./bad-path }}',
    });
    expect(parseTemplateExpression('{{ upper (bad) }}')).toEqual({
      ok: false,
      reason: 'invalid-helper',
      raw: '{{ upper (bad) }}',
    });
    expect(parseTemplateExpression('before {{ Name }}')).toEqual({
      ok: false,
      reason: 'unsupported-expression',
      raw: 'before {{ Name }}',
    });
  });
});

import { isBuiltinName, type TemplateNode } from '../src/index.js';

describe('TemplateToken built-in names and kind switching', () => {
  it('recognizes parser-owned built-in names', () => {
    expect(isBuiltinName('artifact')).toBe(true);
    expect(isBuiltinName('path')).toBe(true);
    expect(isBuiltinName('validateSchema')).toBe(true);
    expect(isBuiltinName('upper')).toBe(false);
  });

  it('supports exhaustive kind switching through the TemplateNode alias', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- exercising the compatibility alias on purpose
    const render = (node: TemplateNode): string => {
      switch (node.kind) {
        case 'literal':
          return node.text;
        case 'variable':
          return node.name;
        case 'userHelper':
          return node.name;
        case 'builtinHelper':
          return node.name;
      }
    };
    expect(render({ kind: 'literal', text: 'x' })).toBe('x');
  });
});

import { performance } from 'node:perf_hooks';

describe('tokenizeTemplate performance guard', () => {
  it('handles long literals and many adjacent placeholders in bounded time', () => {
    const longLiteral = 'x'.repeat(100_000);
    const manyPlaceholders = Array.from(
      { length: 2_000 },
      (_, index) => `{{ Var${String(index)} }}`,
    ).join('');
    const started = performance.now();
    const tokens = tokenizeTemplate(`${longLiteral}${manyPlaceholders}`);
    const elapsedMs = performance.now() - started;

    expect(tokens.length).toBeGreaterThan(1_000);
    expect(elapsedMs).toBeLessThan(500);
  });
});
