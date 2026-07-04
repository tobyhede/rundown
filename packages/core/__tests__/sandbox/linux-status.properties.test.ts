import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import { parseStatus } from '../../src/sandbox/linux.js';

/**
 * `parseStatus`'s return type, narrowed from its `HelperStatus | null`
 * signature (the `HelperStatus` union itself is module-private).
 */
type ParsedStatus = NonNullable<ReturnType<typeof parseStatus>>;

/**
 * JSON-stringify a value for feeding to `parseStatus`, falling back to a
 * benign literal instead of throwing or producing `undefined` (e.g. for a
 * top-level `undefined` sample, or a value `JSON.stringify` cannot handle).
 */
function toJsonText(value: unknown): string {
  try {
    // `JSON.stringify`'s lib.es5.d.ts return type is `string`, but it actually
    // returns `undefined` at runtime for inputs like a bare `undefined` or a
    // function — reachable here since `value` comes from `fc.anything()`.
    const text = JSON.stringify(value) as string | undefined;
    return text ?? 'null';
  } catch {
    return 'null';
  }
}

// Deliberately probes every field of every HelperStatus variant with
// correct-typed, wrong-typed, and absent values, so the schema-validity
// property below actually exercises `parseStatus`'s validation branches
// instead of relying on fully-random JSON to stumble onto the right shape.
const numberIshArb = fc.oneof(
  fc.integer(),
  fc.float(),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.string(),
  fc.boolean(),
  fc.constant(undefined),
);
const boolIshArb = fc.oneof(fc.boolean(), fc.string(), fc.integer(), fc.constant(undefined));
const stringIshArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(undefined));
const networkIshArb = fc.oneof(
  fc.constantFrom('deny', 'allow'),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(undefined),
);
const statusKindArb = fc.constantFrom('applied', 'denied', 'error', 'other', undefined);

const nearValidStatusArb = fc
  .record(
    {
      status: statusKindArb,
      abi: numberIshArb,
      downgraded: boolIshArb,
      network: networkIshArb,
      missing: stringIshArb,
      message: stringIshArb,
    },
    { requiredKeys: [] },
  )
  .map(toJsonText);

/** Assert a non-null `parseStatus` result matches its variant's schema. */
function expectSchemaValid(result: ParsedStatus): void {
  switch (result.status) {
    case 'applied':
      expect(typeof result.abi).toBe('number');
      expect(Number.isFinite(result.abi)).toBe(true);
      expect(result.abi).toBeGreaterThanOrEqual(1);
      expect(typeof result.downgraded).toBe('boolean');
      {
        const network: unknown = result.network;
        expect(['deny', 'allow']).toContain(network);
      }
      break;
    case 'denied':
      expect(typeof result.abi).toBe('number');
      expect(Number.isFinite(result.abi)).toBe(true);
      expect(typeof result.missing).toBe('string');
      break;
    case 'error':
      expect(typeof result.message).toBe('string');
      break;
  }
}

describe('parseStatus properties', () => {
  it('never throws for arbitrary string input, and returns a status or null', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        expect(() => parseStatus(line)).not.toThrow();
        const result = parseStatus(line);
        expect(result === null || typeof result === 'object').toBe(true);
      }),
    );
  });

  it('never throws for arbitrary JSON text', () => {
    fc.assert(
      fc.property(fc.json(), (line) => {
        expect(() => parseStatus(line)).not.toThrow();
      }),
    );
  });

  it('never throws for arbitrary JSON-serializable values', () => {
    fc.assert(
      fc.property(
        fc.anything().map((v) => toJsonText(v)),
        (line) => {
          expect(() => parseStatus(line)).not.toThrow();
        },
      ),
    );
  });

  it('never throws for near-valid status-shaped payloads', () => {
    fc.assert(
      fc.property(nearValidStatusArb, (line) => {
        expect(() => parseStatus(line)).not.toThrow();
      }),
    );
  });

  it('never emits a malformed "valid" status: a non-null result is always schema-valid', () => {
    fc.assert(
      fc.property(nearValidStatusArb, (line) => {
        const result = parseStatus(line);
        if (result !== null) expectSchemaValid(result);
      }),
    );
  });

  it('schema validity also holds for fully-random JSON-serializable input', () => {
    fc.assert(
      fc.property(
        fc.anything().map((v) => toJsonText(v)),
        (line) => {
          const result = parseStatus(line);
          if (result !== null) expectSchemaValid(result);
        },
      ),
    );
  });
});
