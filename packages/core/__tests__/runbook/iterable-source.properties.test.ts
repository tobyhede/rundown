import { describe, expect, it } from '@jest/globals';
import fc from 'fast-check';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import {
  createJsonArrayStream,
  toIterableSource,
  type JsonValue,
} from '../../src/runbook/types.js';

const runId = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const jsonScalarArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.string(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
);

const artifactRecordArb: fc.Arbitrary<ArtifactRecord> = fc
  .record({
    key: fc.constantFrom('a.json', 'b.json', 'c-plan.json'),
    contextId: fc.constantFrom('ctx1', 'ctx2'),
    timestamp: fc.constantFrom('2026-05-15T00:00:00.000Z', '2026-05-16T00:00:00.000Z'),
    runbook: fc.record({
      source: fc.constantFrom('project' as const, 'plugin' as const, 'bundled' as const),
      path: fc.constantFrom('producer.runbook.md', 'nested/producer.runbook.md'),
    }),
  })
  .map(({ key, contextId, timestamp, runbook }) => ({
    kind: 'artifact-record' as const,
    uri: `rd://artifacts/${contextId}/${runId}/${key}`,
    runId,
    contextId,
    runbook,
    key,
    timestamp,
  }));

describe('toIterableSource properties', () => {
  it('classifies JSON arrays as json-array sources', () => {
    fc.assert(
      fc.property(fc.array(jsonScalarArb, { maxLength: 20 }), (items) => {
        expect(toIterableSource(items)).toEqual({ kind: 'json-array', items });
      }),
      { numRuns: 200 },
    );
  });

  it('classifies non-empty artifact record arrays as artifact-set sources', () => {
    fc.assert(
      fc.property(fc.array(artifactRecordArb, { minLength: 1, maxLength: 20 }), (records) => {
        expect(toIterableSource(records)).toEqual({ kind: 'artifact-set', records });
      }),
      { numRuns: 100 },
    );
  });

  it('classifies JsonArrayStream values as json-array-stream sources', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (name) => {
        const stream = createJsonArrayStream(`/project/${name}.jsonl`);
        expect(toIterableSource(stream)).toEqual({ kind: 'json-array-stream', stream });
      }),
      { numRuns: 100 },
    );
  });

  it('does not classify exact artifact records or plain JSON objects as iterable', () => {
    fc.assert(
      fc.property(
        artifactRecordArb,
        fc.dictionary(fc.string({ minLength: 1 }), jsonScalarArb),
        (record, objectValue) => {
          expect(toIterableSource(record)).toBeNull();
          expect(toIterableSource(objectValue)).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
