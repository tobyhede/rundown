import { describe, expect, it } from '@jest/globals';
import { parseRuntimeVariableValue } from '../../src/runbook/runtime-variable-value.js';

describe('parseRuntimeVariableValue', () => {
  it('preserves non-JSON strings unchanged', () => {
    expect(parseRuntimeVariableValue('plain text')).toBe('plain text');
  });

  it('parses JSON arrays and objects as typed runtime variables', () => {
    expect(parseRuntimeVariableValue('["a",{"id":2}]')).toEqual(['a', { id: 2 }]);
    expect(parseRuntimeVariableValue('{"host":"localhost","port":5432}')).toEqual({
      host: 'localhost',
      port: 5432,
    });
  });

  it('parses finite JSON numbers and JSON strings', () => {
    expect(parseRuntimeVariableValue('42')).toBe(42);
    expect(parseRuntimeVariableValue('"quoted"')).toBe('quoted');
  });

  it('keeps top-level JSON booleans and null as strings', () => {
    expect(parseRuntimeVariableValue('true')).toBe('true');
    expect(parseRuntimeVariableValue('null')).toBe('null');
  });

  it('keeps JSON containing nested non-finite numbers as strings', () => {
    expect(parseRuntimeVariableValue('[1e999]')).toBe('[1e999]');
    expect(parseRuntimeVariableValue('{"n":1e999}')).toBe('{"n":1e999}');
  });
});
