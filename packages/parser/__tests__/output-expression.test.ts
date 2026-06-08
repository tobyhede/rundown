import { describe, expect, it } from '@jest/globals';
import { parseOutputExpression } from '../src/index.js';

describe('parseOutputExpression', () => {
  it('parses artifact and path literal helpers', () => {
    expect(parseOutputExpression('{{ artifact "file.json" }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputArtifactHelper',
        name: 'artifact',
        arg: { kind: 'literal', value: 'file.json' },
        raw: '{{ artifact "file.json" }}',
      },
    });

    expect(parseOutputExpression('{{ path "file.json" }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: 'file.json' },
        raw: '{{ path "file.json" }}',
      },
    });
  });

  it('parses legacy ctx path helpers and rejects ctx on artifact', () => {
    expect(parseOutputExpression('{{ path "file.json" ctx=child }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: 'file.json' },
        ctx: 'child',
        raw: '{{ path "file.json" ctx=child }}',
      },
    });

    expect(parseOutputExpression('{{ path "file.json" ctx={{ ChildContext }} }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputPathHelper',
        name: 'path',
        arg: { kind: 'literal', value: 'file.json' },
        ctx: '{{ ChildContext }}',
        raw: '{{ path "file.json" ctx={{ ChildContext }} }}',
      },
    });

    expect(parseOutputExpression('{{ artifact "file.json" ctx=child }}')).toEqual({
      ok: true,
      expression: {
        kind: 'templateText',
        text: '{{ artifact "file.json" ctx=child }}',
        raw: '{{ artifact "file.json" ctx=child }}',
      },
    });
  });

  it('parses explicit variables, template text, user helpers, quoted literals, and bare identifiers', () => {
    expect(parseOutputExpression('{{ ./PlanPath }}')).toEqual({
      ok: true,
      expression: {
        kind: 'variable',
        name: 'PlanPath',
        explicit: true,
        raw: '{{ ./PlanPath }}',
      },
    });

    expect(parseOutputExpression('{{ PlanPath }}')).toEqual({
      ok: true,
      expression: {
        kind: 'templateText',
        text: '{{ PlanPath }}',
        raw: '{{ PlanPath }}',
      },
    });

    expect(parseOutputExpression('{{ slug Title }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputUserHelper',
        name: 'slug',
        arg: { kind: 'ref', name: 'Title' },
        raw: '{{ slug Title }}',
      },
    });

    expect(parseOutputExpression('{{ slug "Hello World" }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputUserHelper',
        name: 'slug',
        arg: { kind: 'literal', value: 'Hello World' },
        raw: '{{ slug "Hello World" }}',
      },
    });

    expect(parseOutputExpression('"quoted {{ Step }}"')).toEqual({
      ok: true,
      expression: {
        kind: 'quotedLiteral',
        value: 'quoted {{ Step }}',
        containsTemplates: true,
        raw: '"quoted {{ Step }}"',
      },
    });

    expect(parseOutputExpression('"quoted literal"')).toEqual({
      ok: true,
      expression: {
        kind: 'quotedLiteral',
        value: 'quoted literal',
        containsTemplates: false,
        raw: '"quoted literal"',
      },
    });

    expect(parseOutputExpression('PlanPath')).toEqual({
      ok: true,
      expression: { kind: 'bareIdentifier', name: 'PlanPath', raw: 'PlanPath' },
    });

    expect(parseOutputExpression('at {{ Step }}')).toEqual({
      ok: true,
      expression: { kind: 'templateText', text: 'at {{ Step }}', raw: 'at {{ Step }}' },
    });
  });

  it('keeps validateSchema out of OUTPUTS artifact helper semantics', () => {
    expect(parseOutputExpression('{{ validateSchema "plan.json" }}')).toEqual({
      ok: true,
      expression: {
        kind: 'outputUserHelper',
        name: 'validateSchema',
        arg: { kind: 'literal', value: 'plan.json' },
        raw: '{{ validateSchema "plan.json" }}',
      },
    });
  });

  it('returns typed rejection reasons', () => {
    expect(parseOutputExpression('')).toEqual({ ok: false, reason: 'empty', raw: '' });
    expect(parseOutputExpression('{{ ./bad-path }}')).toEqual({
      ok: true,
      expression: {
        kind: 'templateText',
        text: '{{ ./bad-path }}',
        raw: '{{ ./bad-path }}',
      },
    });
    expect(parseOutputExpression('"unterminated')).toEqual({
      ok: false,
      reason: 'invalid-quoted-literal',
      raw: '"unterminated',
    });
    expect(parseOutputExpression('not a valid literal')).toEqual({
      ok: false,
      reason: 'unsupported-expression',
      raw: 'not a valid literal',
    });
  });
});
