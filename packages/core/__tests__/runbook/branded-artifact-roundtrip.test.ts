import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import { ArtifactRecordSchema } from '../../src/runbook/artifact-schema.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import { partitionVariables } from '../../src/runbook/index.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../helpers/effective-vars.js';

const artifactArb = fc
  .record({
    kind: fc.constant('artifact-record' as const),
    contextId: fc.constant('ctx'),
    runId: fc.constant(assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
    runbook: fc.constant({ source: 'project' as const, path: 'r.md' }),
    key: fc.stringMatching(/^[a-z]+\.json$/).filter((key) => key.length >= 5 && key.length <= 16),
    timestamp: fc.constant('2026-05-25T00:00:00.000Z'),
  })
  .map((record) =>
    ArtifactRecordSchema.parse({
      ...record,
      uri: `rd://artifacts/ctx/${record.runId}/${record.key}`,
    }),
  );

describe('TrustedArtifactRecord brand serialization invariants', () => {
  it('property: brand IS attached at runtime after producer call', () => {
    fc.assert(
      fc.property(artifactArb, (record) => {
        const branded = brandTrustedArtifactRecordForTest(record);
        expect(isTrustedArtifactRecord(branded)).toBe(true);
      }),
    );
  });

  it('property: branded record round-trips through JSON identically to unbranded', () => {
    fc.assert(
      fc.property(artifactArb, (record) => {
        const branded = brandTrustedArtifactRecordForTest(record);
        expect(JSON.stringify(branded)).toBe(JSON.stringify(record));
      }),
    );
  });

  it('property: JSON.stringify never emits the brand symbol or value', () => {
    fc.assert(
      fc.property(artifactArb, (record) => {
        const branded = brandTrustedArtifactRecordForTest(record);
        const serialized = JSON.stringify(branded);
        expect(serialized).not.toContain('Symbol');
        expect(serialized).not.toContain('__trust');
        expect(serialized).not.toContain('trustedArtifact');
      }),
    );
  });

  it('property: a deserialised plain record never satisfies isTrustedArtifactRecord', () => {
    fc.assert(
      fc.property(artifactArb, (record) => {
        const branded = brandTrustedArtifactRecordForTest(record);
        const roundtripped = JSON.parse(JSON.stringify(branded));
        expect(isTrustedArtifactRecord(roundtripped)).toBe(false);
      }),
    );
  });

  it('property: forged JSON-literal artifact-shaped object never satisfies the guard', () => {
    fc.assert(
      fc.property(artifactArb, (record) => {
        const forged = JSON.parse(JSON.stringify(record));
        expect(isTrustedArtifactRecord(forged)).toBe(false);
      }),
    );
  });

  it('property: array container brand survives the producer but not JSON', () => {
    fc.assert(
      fc.property(fc.array(artifactArb, { minLength: 0, maxLength: 5 }), (records) => {
        const branded = brandTrustedArtifactArrayForTest(records);
        expect(isTrustedArtifactArray(branded)).toBe(true);
        const roundtripped = JSON.parse(JSON.stringify(branded));
        expect(isTrustedArtifactArray(roundtripped)).toBe(false);
      }),
    );
  });

  it('forged empty array does NOT vacuously satisfy isTrustedArtifactArray', () => {
    expect(isTrustedArtifactArray([])).toBe(false);
    expect(isTrustedArtifactArray(brandTrustedArtifactArrayForTest([]))).toBe(true);
  });

  it('empty array: producer mints a branded container that satisfies the guard', () => {
    const branded = brandTrustedArtifactArrayForTest([]);
    expect(isTrustedArtifactArray(branded)).toBe(true);
    expect(branded.length).toBe(0);
  });

  it('empty array: a plain literal [] does NOT satisfy isTrustedArtifactArray', () => {
    expect(isTrustedArtifactArray([])).toBe(false);
    expect(isTrustedArtifactArray(JSON.parse('[]'))).toBe(false);
  });

  it('empty array: partitionVariables accepts a branded empty trusted array in runtimeVars', () => {
    const branded = brandTrustedArtifactArrayForTest([]);
    const result = partitionVariables({ Plans: branded });
    expect(result.runtimeVars).toHaveProperty('Plans');
    expect(result.templateVars).not.toHaveProperty('Plans');
    expect(isTrustedArtifactArray(result.runtimeVars.Plans)).toBe(true);
  });

  it('empty array: JSON round-trip of a branded empty array strips the container brand', () => {
    const branded = brandTrustedArtifactArrayForTest([]);
    const roundtripped = JSON.parse(JSON.stringify(branded));
    expect(isTrustedArtifactArray(roundtripped)).toBe(false);
    expect(JSON.stringify(branded)).toBe('[]');
  });
});
