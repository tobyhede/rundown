import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { parseRuntimeVariableValue } from '../../src/runbook/runtime-variable-value.js';
import type { JsonObject, JsonValue } from '../../src/runbook/types.js';

const jsonScalarArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);

const jsonObjectArb: fc.Arbitrary<JsonObject> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 12 }),
  jsonScalarArb,
);

describe('parseRuntimeVariableValue properties', () => {
  it('round-trips JSON strings as string runtime values', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(parseRuntimeVariableValue(JSON.stringify(value))).toBe(value);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips finite JSON numbers as number runtime values', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (value) => {
        expect(parseRuntimeVariableValue(JSON.stringify(value))).toBe(value);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips JSON arrays and objects as structured runtime values', () => {
    fc.assert(
      fc.property(
        fc.array(jsonScalarArb, { maxLength: 20 }),
        jsonObjectArb,
        (arrayValue, objectValue) => {
          expect(parseRuntimeVariableValue(JSON.stringify(arrayValue))).toEqual(arrayValue);
          expect(parseRuntimeVariableValue(JSON.stringify(objectValue))).toEqual(objectValue);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('keeps top-level booleans and null as their original strings', () => {
    fc.assert(
      fc.property(fc.constantFrom(true, false, null), (value) => {
        expect(parseRuntimeVariableValue(JSON.stringify(value))).toBe(JSON.stringify(value));
      }),
      { numRuns: 50 },
    );
  });
});
