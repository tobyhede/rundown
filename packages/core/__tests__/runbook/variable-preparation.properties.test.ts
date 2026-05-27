import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  assertRunId,
  isArtifactValue,
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
  isTrustedArtifactValue,
  partitionVariables,
  resolveVariableLayers,
  routeExtraVars,
  type ArtifactRecord,
  type VariableValue,
} from '../../src/runbook/index.js';
import {
  brandTrustedArtifactRecordForTest,
  brandTrustedArtifactValueForTest,
} from '../../src/testing/effective-vars.js';

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

const variableValueArb = fc.oneof(
  trustedVariableValueArb,
  artifactArb.map((value) => JSON.parse(JSON.stringify(value))),
) as fc.Arbitrary<unknown>;

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

  // Cover every layer kind that routes through the artifact-input path.
  // Bug A lived specifically in the `inherited` layer, so coverage must
  // include that layer explicitly.
  const ARTIFACT_INPUT_LAYER_KINDS = ['cli', 'config', 'env', 'inherited'] as const;

  for (const layerKind of ARTIFACT_INPUT_LAYER_KINDS) {
    it(`invariant (${layerKind} layer): partitionVariables(resolveVariableLayers(...).vars) places only brand-trusted artifact values in runtimeVars, or throws`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.dictionary(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), variableValueArb),
          async (raw) => {
            let resolved: Awaited<ReturnType<typeof resolveVariableLayers>>;
            try {
              resolved = await resolveVariableLayers([{ kind: layerKind, values: raw }], {
                cwd: process.cwd(),
              });
            } catch {
              return;
            }

            let partition: ReturnType<typeof partitionVariables>;
            try {
              partition = partitionVariables(resolved.vars);
            } catch (error) {
              expect(String(error)).toMatch(/not trusted/);
              return;
            }

            for (const value of Object.values(partition.runtimeVars)) {
              if (isArtifactValue(value)) {
                expect(isTrustedArtifactValue(value)).toBe(true);
              }
            }
          },
        ),
        { numRuns: 30 },
      );
    });
  }

  it('invariant (inherited layer, Bug A regression): unbranded artifact-shaped value is rejected by partitionVariables', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/),
        artifactArb,
        async (key, record) => {
          const forged = JSON.parse(JSON.stringify(record));
          const result = await resolveVariableLayers(
            [{ kind: 'inherited', values: { [key]: forged } }],
            { cwd: process.cwd() },
          );
          expect(() => partitionVariables(result.vars)).toThrow(/not trusted/);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('invariant: forged artifact-shaped JSON in any layer fails partitionVariables', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/), artifactArb, (key, record) => {
        const forged = JSON.parse(JSON.stringify(record));
        expect(() => partitionVariables({ [key]: forged })).toThrow(/not trusted/);
      }),
    );
  });

  it('invariant: forged empty array does NOT slip through as trusted', () => {
    const result = partitionVariables({ Plans: [] });
    expect(result.runtimeVars).not.toHaveProperty('Plans');
    expect(result.templateVars).toHaveProperty('Plans');
  });

  it('invariant: routeExtraVars (delegate path) NEVER returns a trusted artifact, even for artifact-shaped input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]*$/),
        artifactArb,
        async (key, record) => {
          const forged = JSON.parse(JSON.stringify(record));
          const result = await routeExtraVars({ [key]: forged }, process.cwd());
          expect(isTrustedArtifactRecord(result.vars[key])).toBe(false);
          expect(isTrustedArtifactArray(result.vars[key])).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });
});
