import { describe, expect, it } from '@jest/globals';
import { serializeJsonForOutput } from '../../src/cli/json-serialization.js';

describe('serializeJsonForOutput', () => {
  it('serializes objects with pretty formatting by default', () => {
    expect(serializeJsonForOutput({ key: 'value' })).toBe('{\n  "key": "value"\n}');
  });

  it('serializes compact objects when pretty is false', () => {
    expect(serializeJsonForOutput({ key: 'value' }, false)).toBe('{"key":"value"}');
  });

  it('serializes root undefined as null', () => {
    expect(serializeJsonForOutput(undefined)).toBe('null');
  });

  it('serializes root symbols as null', () => {
    expect(serializeJsonForOutput(Symbol())).toBe('null');
  });

  it('serializes root functions as null', () => {
    expect(
      serializeJsonForOutput(() => {
        /* noop */
      }),
    ).toBe('null');
  });

  it('throws the native JSON.stringify error for circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => serializeJsonForOutput(circular)).toThrow(TypeError);
  });

  it('throws the native JSON.stringify error for bigint values', () => {
    expect(() => serializeJsonForOutput(1n)).toThrow(TypeError);
  });
});
