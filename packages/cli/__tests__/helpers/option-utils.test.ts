import { describe, it, expect, afterEach } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import { collect, parseVarOption, parseVarJsonOption } from '../../src/helpers/option-utils.js';

describe('collect', () => {
  it('accumulates values into array', () => {
    let result: string[] = [];
    result = collect('first', result);
    result = collect('second', result);
    result = collect('third', result);

    expect(result).toEqual(['first', 'second', 'third']);
  });

  it('starts with empty array default', () => {
    const result = collect('value', []);

    expect(result).toEqual(['value']);
  });
});

describe('parseVarOption', () => {
  afterEach(() => {
    // Clean up any env vars set during tests
    delete process.env.TEST_PARSE_VAR_OPTION;
    delete process.env.MY_VAR;
  });

  it('accumulates key=value entries', () => {
    let result: string[] = [];
    result = parseVarOption('foo=bar', result);

    expect(result).toEqual(['foo=bar']);
  });

  it('handles values containing equals signs', () => {
    let result: string[] = [];
    result = parseVarOption('foo=a=b', result);

    expect(result).toEqual(['foo=a=b']);
  });

  it('accumulates multiple entries', () => {
    let result: string[] = [];
    result = parseVarOption('foo=bar', result);
    result = parseVarOption('baz=qux', result);

    expect(result).toEqual(['foo=bar', 'baz=qux']);
  });

  it('throws InvalidArgumentError for key starting with digit', () => {
    expect(() => parseVarOption('1invalid=value', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarOption('1invalid=value', [])).toThrow(/invalid variable/i);
  });

  it('throws InvalidArgumentError for empty key', () => {
    expect(() => parseVarOption('=value', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarOption('=value', [])).toThrow(/invalid variable/i);
  });

  it('inherits value from env var when no = present', () => {
    process.env.MY_VAR = 'env-value';

    const result = parseVarOption('MY_VAR', []);

    expect(result).toEqual(['MY_VAR=env-value']);
  });

  it('throws InvalidArgumentError when env var is not set', () => {
    delete process.env.NONEXISTENT_VAR;

    expect(() => parseVarOption('NONEXISTENT_VAR', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarOption('NONEXISTENT_VAR', [])).toThrow(/not set/i);
  });

  it('throws InvalidArgumentError for invalid identifier without =', () => {
    expect(() => parseVarOption('bad-name', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarOption('bad-name', [])).toThrow(/invalid variable name/i);
  });
});

describe('parseVarJsonOption', () => {
  it('accepts valid JSON array', () => {
    const result = parseVarJsonOption('items=["a","b"]', []);

    expect(result).toEqual(['items=["a","b"]']);
  });

  it('throws InvalidArgumentError for JSON objects', () => {
    expect(() => parseVarJsonOption('config={"host":"localhost"}', [])).toThrow(
      InvalidArgumentError,
    );
    expect(() => parseVarJsonOption('config={"host":"localhost"}', [])).toThrow(
      /must be scalars or arrays, not objects/,
    );
  });

  it('accepts valid JSON number', () => {
    const result = parseVarJsonOption('count=42', []);

    expect(result).toEqual(['count=42']);
  });

  it('accepts valid JSON boolean', () => {
    const result = parseVarJsonOption('flag=true', []);

    expect(result).toEqual(['flag=true']);
  });

  it('accepts valid JSON string', () => {
    const result = parseVarJsonOption('name="hello"', []);

    expect(result).toEqual(['name="hello"']);
  });

  it('throws InvalidArgumentError when no = present', () => {
    expect(() => parseVarJsonOption('missing', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarJsonOption('missing', [])).toThrow(/expected key=json format/i);
  });

  it('throws InvalidArgumentError for invalid key', () => {
    expect(() => parseVarJsonOption('1bad=42', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarJsonOption('1bad=42', [])).toThrow(/invalid variable name/i);
  });

  it('throws InvalidArgumentError for invalid JSON', () => {
    expect(() => parseVarJsonOption('items=[broken', [])).toThrow(InvalidArgumentError);
    expect(() => parseVarJsonOption('items=[broken', [])).toThrow(/invalid json/i);
  });

  it('accumulates multiple entries', () => {
    let result: string[] = [];
    result = parseVarJsonOption('a=42', result);
    result = parseVarJsonOption('b=["x"]', result);

    expect(result).toEqual(['a=42', 'b=["x"]']);
  });
});
