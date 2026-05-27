import { describe, expect, it } from '@jest/globals';
import type { ArtifactResolveOutput } from '../../src/runbook/actors/artifact-resolve-actor.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';
import { ArtifactRecordSchema } from '../../src/runbook/artifact-schema.js';
import { isTrustedArtifactRecord } from '../../src/runbook/effective-vars.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { brandTrustedArtifactRecordForTest } from '../../src/testing/effective-vars.js';

const RUN_ID = assertRunId(`rd_${'a'.repeat(32)}`);
function makeRecord(): ArtifactRecord {
  return ArtifactRecordSchema.parse({
    kind: 'artifact-record',
    uri: `rd://artifacts/ctx/${RUN_ID}/plan.json`,
    runId: RUN_ID,
    contextId: 'ctx',
    runbook: { source: 'project' as const, path: 'p.md' },
    key: 'plan.json',
    timestamp: '2026-05-25T00:00:00.000Z',
  });
}

describe('artifactResolveActor output is typed as TrustedArtifactValue', () => {
  it('runtime: a branded value flows through the Output type without losing the brand', () => {
    const branded = brandTrustedArtifactRecordForTest(makeRecord());
    const output: ArtifactResolveOutput = { variables: { Plan: branded } };

    expect(isTrustedArtifactRecord(output.variables.Plan)).toBe(true);
  });

  it('type-level: an unbranded ArtifactRecord cannot be assigned to ArtifactResolveOutput.variables', () => {
    // Scope: actor-Output union is trust-only because it excludes
    // TemplateVarValue. This does NOT generalize to VariableValue, where
    // JsonObject fallthrough admits unbranded records.
    const plain = makeRecord();
    // @ts-expect-error: unbranded ArtifactRecord must not be assignable to
    // the trusted-only Output type.
    const output: ArtifactResolveOutput = { variables: { Plan: plain } };

    expect(isTrustedArtifactRecord(output.variables.Plan)).toBe(false);
  });
});
