import { describe, expect, it } from '@jest/globals';
import * as os from 'node:os';
import { ContextSnapshotSchema, makeRunbookStateSchema } from '../../src/schemas.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { brandTrustedArtifactRecordForTest } from '../../src/testing/effective-vars.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';

const RUN_ID = assertRunId(`rd_${'a'.repeat(32)}`);
const CTX = 'context-a';
const KEY = 'plan.json';
const URI = `rd://artifacts/${CTX}/${RUN_ID}/${KEY}`;

const PLAIN_ARTIFACT = {
  kind: 'artifact-record',
  uri: URI,
  runId: RUN_ID,
  contextId: CTX,
  runbook: { source: 'project' as const, path: 'producer.runbook.md' },
  key: KEY,
  timestamp: '2026-05-25T00:00:00.000Z',
};

function validStateWithVariables(variables: Record<string, unknown>): Record<string, unknown> {
  return {
    id: RUN_ID,
    runbook: { source: 'project', path: 'r.md' },
    runbookPath: 'r.md',
    title: 'r',
    step: '1',
    stepName: 's',
    retryCount: 0,
    variables,
    steps: [{ id: '1', status: 'running' }],
    resolvedCompletions: {},
    frameEntries: {},
    startedAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    frontmatterOutputs: [],
    lifecycle: 'running',
    schemaVersion: 1,
  };
}

describe('schema parse seam re-mints TrustedArtifactRecord brand', () => {
  it('brands artifact values in RunbookState.variables', () => {
    const schema = makeRunbookStateSchema(os.tmpdir());
    const parsed = schema.parse(validStateWithVariables({ Plan: PLAIN_ARTIFACT })) as {
      variables: Record<string, unknown>;
    };

    expect(isTrustedArtifactRecord(parsed.variables.Plan)).toBe(true);
  });

  it('brands artifact values in ContextSnapshot.vars', () => {
    const parsed = ContextSnapshotSchema.parse({
      vars: { Plan: PLAIN_ARTIFACT },
      ancestors: [],
    }) as { vars: Record<string, unknown> };

    expect(isTrustedArtifactRecord(parsed.vars.Plan)).toBe(true);
  });

  it('brands artifact-record arrays in RunbookState.variables with a container brand', () => {
    const schema = makeRunbookStateSchema(os.tmpdir());
    const parsed = schema.parse(validStateWithVariables({ Plans: [PLAIN_ARTIFACT] })) as {
      variables: Record<string, unknown>;
    };

    expect(isTrustedArtifactArray(parsed.variables.Plans)).toBe(true);
  });

  it('re-mints the brand across a JSON serialize/deserialize round trip', () => {
    // Pins the actual disk-load contract: state is persisted as JSON, the
    // non-enumerable brand symbol does not survive the round trip, and the
    // schema parse seam must re-mint it on load.
    const branded = brandTrustedArtifactRecordForTest(PLAIN_ARTIFACT as ArtifactRecord);
    expect(isTrustedArtifactRecord(branded)).toBe(true);

    const stripped = JSON.parse(JSON.stringify(branded)) as unknown;
    expect(isTrustedArtifactRecord(stripped)).toBe(false);

    const schema = makeRunbookStateSchema(os.tmpdir());
    const reparsed = schema.parse(validStateWithVariables({ Plan: stripped })) as {
      variables: Record<string, unknown>;
    };
    expect(isTrustedArtifactRecord(reparsed.variables.Plan)).toBe(true);
  });
});
