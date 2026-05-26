import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  assertRunId,
  isArtifactValue,
  partitionVariables,
  type ArtifactRecord,
  type VariableValue,
} from '../../src/runbook/index.js';

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

const variableValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.array(jsonValueArb).map((value) => value as VariableValue),
  fc.dictionary(fc.string(), jsonValueArb).map((value) => value as VariableValue),
  artifactArb.map((value) => value as VariableValue),
  fc.array(artifactArb, { minLength: 1 }).map((value) => value as VariableValue),
  fc.constant([] as const),
) as fc.Arbitrary<VariableValue>;

describe('variable preparation properties', () => {
  it('preserves all keys across template/runtime partitions', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), variableValueArb),
        (vars) => {
          const result = partitionVariables(vars, { trustAllArtifactValues: true });
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

  it('rejects artifact values unless their exact key is trusted', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/),
        artifactArb,
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/),
        (key, artifact, otherKey) => {
          fc.pre(key !== otherKey);

          expect(() => partitionVariables({ [key]: artifact })).toThrow(/Artifact record input/);
          expect(() =>
            partitionVariables({ [key]: artifact }, { trustedArtifactKeys: new Set([otherKey]) }),
          ).toThrow(/Artifact record input/);

          const result = partitionVariables(
            { [key]: artifact },
            { trustedArtifactKeys: new Set([key]) },
          );
          expect(result.runtimeVars[key]).toEqual(artifact);
          expect(result.templateVars).not.toHaveProperty(key);
        },
      ),
    );
  });

  it('trustAllArtifactValues allows artifact values for any key', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), artifactArb, {
          minKeys: 1,
        }),
        (vars) => {
          const result = partitionVariables(vars, { trustAllArtifactValues: true });

          expect(result.templateVars).toEqual({});
          expect(result.runtimeVars).toEqual(vars);
        },
      ),
    );
  });
});
