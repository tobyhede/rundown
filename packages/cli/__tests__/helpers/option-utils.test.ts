import { describe, it, expect, afterEach } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import {
  collect,
  parseArtifactJsonOption,
  parseArtifactOption,
  parseInputOption,
  parseInputJsonOption,
} from '../../src/helpers/option-utils.js';
import { isValidVariableName } from '../../src/services/variable-discovery.js';

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

describe('parseInputOption', () => {
  afterEach(() => {
    // Clean up any env vars set during tests
    delete process.env.TEST_PARSE_VAR_OPTION;
    delete process.env.MY_VAR;
  });

  it('accumulates key=value entries', () => {
    let result: string[] = [];
    result = parseInputOption('foo=bar', result);

    expect(result).toEqual(['foo=bar']);
  });

  it('handles values containing equals signs', () => {
    let result: string[] = [];
    result = parseInputOption('foo=a=b', result);

    expect(result).toEqual(['foo=a=b']);
  });

  it('accumulates multiple entries', () => {
    let result: string[] = [];
    result = parseInputOption('foo=bar', result);
    result = parseInputOption('baz=qux', result);

    expect(result).toEqual(['foo=bar', 'baz=qux']);
  });

  it('throws InvalidArgumentError for key starting with digit', () => {
    expect(() => parseInputOption('1invalid=value', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputOption('1invalid=value', [])).toThrow(/invalid variable/i);
  });

  it('throws InvalidArgumentError for empty key', () => {
    expect(() => parseInputOption('=value', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputOption('=value', [])).toThrow(/invalid variable/i);
  });

  it('inherits value from env var when no = present', () => {
    process.env.MY_VAR = 'env-value';

    const result = parseInputOption('MY_VAR', []);

    expect(result).toEqual(['MY_VAR=env-value']);
  });

  it('throws InvalidArgumentError when env var is not set', () => {
    delete process.env.NONEXISTENT_VAR;

    expect(() => parseInputOption('NONEXISTENT_VAR', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputOption('NONEXISTENT_VAR', [])).toThrow(/not set/i);
  });

  it('throws InvalidArgumentError for invalid identifier without =', () => {
    expect(() => parseInputOption('bad-name', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputOption('bad-name', [])).toThrow(/invalid variable name/i);
  });
});

describe('parseInputJsonOption', () => {
  it('accepts valid JSON array', () => {
    const result = parseInputJsonOption('items=["a","b"]', []);

    expect(result).toEqual(['items=["a","b"]']);
  });

  it('accepts JSON objects (passthrough for downstream routing)', () => {
    const result = parseInputJsonOption('config={"host":"localhost"}', []);
    expect(result).toEqual(['config={"host":"localhost"}']);
  });

  it('accepts valid JSON number', () => {
    const result = parseInputJsonOption('count=42', []);

    expect(result).toEqual(['count=42']);
  });

  it('accepts valid JSON boolean', () => {
    const result = parseInputJsonOption('flag=true', []);

    expect(result).toEqual(['flag=true']);
  });

  it('accepts valid JSON string', () => {
    const result = parseInputJsonOption('name="hello"', []);

    expect(result).toEqual(['name="hello"']);
  });

  it('throws InvalidArgumentError when no = present', () => {
    expect(() => parseInputJsonOption('missing', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputJsonOption('missing', [])).toThrow(/expected key=json format/i);
  });

  it('throws InvalidArgumentError for invalid key', () => {
    expect(() => parseInputJsonOption('1bad=42', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputJsonOption('1bad=42', [])).toThrow(/invalid variable name/i);
  });

  it('throws InvalidArgumentError for invalid JSON', () => {
    expect(() => parseInputJsonOption('items=[broken', [])).toThrow(InvalidArgumentError);
    expect(() => parseInputJsonOption('items=[broken', [])).toThrow(/invalid json/i);
  });

  it('accumulates multiple entries', () => {
    let result: string[] = [];
    result = parseInputJsonOption('a=42', result);
    result = parseInputJsonOption('b=["x"]', result);

    expect(result).toEqual(['a=42', 'b=["x"]']);
  });
});

describe('prototype pollution protection', () => {
  const POISONED_KEYS = ['__proto__', 'constructor', 'prototype'];

  describe('isValidVariableName', () => {
    it.each(POISONED_KEYS)('rejects poisoned key: %s', (key) => {
      expect(isValidVariableName(key)).toBe(false);
    });

    it('accepts normal underscore-prefixed keys', () => {
      expect(isValidVariableName('_normal')).toBe(true);
      expect(isValidVariableName('__double')).toBe(true);
    });
  });

  describe('parseInputOption', () => {
    it.each(POISONED_KEYS)('throws for --input %s=value with reserved message', (key) => {
      expect(() => parseInputOption(`${key}=value`, [])).toThrow(InvalidArgumentError);
      expect(() => parseInputOption(`${key}=value`, [])).toThrow(/reserved variable name/i);
    });

    it.each(
      POISONED_KEYS,
    )('throws for --input %s (env inherit form) with reserved message', (key) => {
      process.env[key] = 'injected';
      try {
        expect(() => parseInputOption(key, [])).toThrow(InvalidArgumentError);
        expect(() => parseInputOption(key, [])).toThrow(/reserved variable name/i);
      } finally {
        delete process.env[key];
      }
    });
  });

  describe('parseInputJsonOption', () => {
    it.each(POISONED_KEYS)('throws for --input-json %s=42 with reserved message', (key) => {
      expect(() => parseInputJsonOption(`${key}=42`, [])).toThrow(InvalidArgumentError);
      expect(() => parseInputJsonOption(`${key}=42`, [])).toThrow(/reserved variable name/i);
    });
  });
});

describe('parseArtifactOption', () => {
  it('accepts KEY=rd://... and accumulates', () => {
    expect(parseArtifactOption('PlanPath=rd://artifacts/c/r/PlanPath', [])).toEqual([
      'PlanPath=rd://artifacts/c/r/PlanPath',
    ]);
  });

  it('rejects the no-= env-inherit form (env arm disabled for artifacts)', () => {
    process.env.PlanPath = 'leak';
    try {
      expect(() => parseArtifactOption('PlanPath', [])).toThrow(/artifact.*KEY=<rd:\/\/ uri>/i);
    } finally {
      delete process.env.PlanPath;
    }
  });

  it('rejects an invalid identifier with the artifact noun', () => {
    expect(() => parseArtifactOption('1bad=rd://x', [])).toThrow(/Invalid artifact/i);
  });
});

describe('parseArtifactJsonOption', () => {
  it('accepts KEY=<json array> and accumulates', () => {
    expect(parseArtifactJsonOption('Plans=["rd://a","rd://b"]', [])).toEqual([
      'Plans=["rd://a","rd://b"]',
    ]);
  });

  it('rejects invalid JSON with the artifact noun', () => {
    expect(() => parseArtifactJsonOption('Plans=not-json', [])).toThrow(/Invalid JSON for "Plans"/);
  });

  it('rejects an invalid identifier key with the artifact noun', () => {
    expect(() => parseArtifactJsonOption('1bad=[]', [])).toThrow(/Invalid artifact name/);
  });

  it('rejects a reserved key with the artifact noun', () => {
    expect(() => parseArtifactJsonOption('__proto__=[]', [])).toThrow(/Reserved artifact name/);
  });

  it('rejects a value with no = as a format error', () => {
    expect(() => parseArtifactJsonOption('Plans', [])).toThrow(/Expected key=json format/);
  });
});
