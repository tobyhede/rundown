import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  assertRunId,
  isArtifactValue,
  isTrustedArtifactRecord,
  partitionVariables,
  type ArtifactRecord,
  type VariableValue,
} from '../../src/runbook/index.js';
import {
  brandTrustedArtifactRecordForTest,
  brandTrustedArtifactValueForTest,
} from '../helpers/effective-vars.js';

const artifactArb: fc.Arbitrary<ArtifactRecord> = fc.record({
  kind: fc.constant('artifact-record' as const),
  uri: fc.constant('rd://artifacts/ctx/rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/plan.json'),
  runId: fc.constant(assertRunId('rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')),
  contextId: fc.constant('ctx'),
  runbook: fc.constant({ source: 'project' as const, path: 'producer.runbook.md' }),
  key: fc.constant('plan.json'),
  timestamp: fc.constant('2026-05-25T00:00:00.000Z'),
});

const jsonValueArb = fc.jsonValue();

const trustedVariableValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.array(jsonValueArb).map((value) => value as VariableValue),
  fc.dictionary(fc.string(), jsonValueArb).map((value) => value as VariableValue),
  artifactArb.map((value) => brandTrustedArtifactRecordForTest(value) as VariableValue),
  fc
    .array(artifactArb, { minLength: 1 })
    .map((value) => brandTrustedArtifactValueForTest(value) as VariableValue),
  fc.constant([] as const),
) as fc.Arbitrary<VariableValue>;

describe('variable preparation properties (brand-based trust)', () => {
  it('preserves all keys across template/runtime partitions when artifact values are branded', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), trustedVariableValueArb),
        (vars) => {
          const result = partitionVariables(vars);
          expect(
            new Set([...Object.keys(result.templateVars), ...Object.keys(result.runtimeVars)]),
          ).toEqual(new Set(Object.keys(vars)));

          for (const [key, value] of Object.entries(result.runtimeVars)) {
            expect(isArtifactValue(value)).toBe(true);
            expect(result.templateVars).not.toHaveProperty(key);
          }
        },
      ),
    );
  });

  it('rejects forged (unbranded) artifact records regardless of key', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), artifactArb, (key, artifact) => {
        expect(() => partitionVariables({ [key]: artifact })).toThrow(/Artifact record input/);
      }),
    );
  });

  it('accepts branded artifact records for any key', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), artifactArb, {
          minKeys: 1,
        }),
        (vars) => {
          const branded: Record<string, VariableValue> = {};
          for (const [key, value] of Object.entries(vars)) {
            branded[key] = brandTrustedArtifactRecordForTest(value);
          }
          const result = partitionVariables(branded);
          expect(result.templateVars).toEqual({});
          for (const key of Object.keys(branded)) {
            expect(isTrustedArtifactRecord(result.runtimeVars[key])).toBe(true);
          }
        },
      ),
    );
  });
});
