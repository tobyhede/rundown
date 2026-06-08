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
