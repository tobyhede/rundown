import { describe, it, expect } from '@jest/globals';
import * as os from 'node:os';
import {
  brandTrustedArtifactArrayForTest,
  brandTrustedArtifactRecordForTest,
} from '../../src/testing/effective-vars.js';
import {
  isTrustedArtifactArray,
  isTrustedArtifactRecord,
} from '../../src/runbook/effective-vars.js';
import { ArtifactRecordSchema } from '../../src/runbook/artifact-schema.js';
import { assertRunId } from '../../src/runbook/run-id.js';
import { makeRunbookStateSchema } from '../../src/schemas.js';

const RUN_ID = assertRunId(`rd_${'a'.repeat(32)}`);
const CTX = 'ctx';
const URI = `rd://artifacts/${CTX}/${RUN_ID}/plan.json`;
const RECORD = ArtifactRecordSchema.parse({
  kind: 'artifact-record',
  uri: URI,
  runId: RUN_ID,
  contextId: CTX,
  runbook: { source: 'project' as const, path: 'p.md' },
  key: 'plan.json',
  timestamp: '2026-05-25T00:00:00.000Z',
});

describe('TrustedArtifactRecord brand under XState/persistence operations', () => {
  it('outer spread preserves trust on existing references (compiler-action pattern)', () => {
    // `{ ...context.variables, foo: existingTrustedRecord }` spreads the
    // OUTER map. Property values are copied by reference, so the brand on
    // the INNER record survives intact.
    const branded = brandTrustedArtifactRecordForTest(RECORD);
    const contextVariables = { Plan: branded } as Record<string, unknown>;
    const newVar = brandTrustedArtifactRecordForTest({ ...RECORD, key: 'other.json' });
    const merged: Record<string, unknown> = { ...contextVariables, Other: newVar };

    expect(isTrustedArtifactRecord(merged.Plan)).toBe(true);
    expect(isTrustedArtifactRecord(merged.Other)).toBe(true);
    expect(merged.Plan).toBe(branded);
  });

  it('inner spread of the record itself strips the brand (failure mode pinned)', () => {
    // `{ ...trustedRecord }` builds a new object by copying ENUMERABLE own
    // properties. Non-enumerable symbol properties (our brand) are NOT
    // copied, so the new object lacks the brand. This is the behaviour
    // toPublicArtifactRecord relies on, and what the compiler actions
    // must not do.
    const branded = brandTrustedArtifactRecordForTest(RECORD);
    const reSpread = { ...branded };
    expect(isTrustedArtifactRecord(reSpread)).toBe(false);
  });

  it('Object.assign({}, trustedRecord) also strips the brand', () => {
    // Same rule: Object.assign copies own enumerable properties only.
    const branded = brandTrustedArtifactRecordForTest(RECORD);
    const copy = Object.assign({}, branded);
    expect(isTrustedArtifactRecord(copy)).toBe(false);
  });

  it('JSON.parse(JSON.stringify(trustedRecord)) strips the brand', () => {
    // Symbol keys never serialize. Non-enumerable properties never
    // serialize. Both lines of defense converge, so the disk shape is
    // always brand-free by construction.
    const branded = brandTrustedArtifactRecordForTest(RECORD);
    const roundTripped = JSON.parse(JSON.stringify(branded));
    expect(isTrustedArtifactRecord(roundTripped)).toBe(false);
  });

  it('Array container brand survives outer spread of the array reference', () => {
    // Storing a trusted array in a context map and copying the map
    // preserves the container brand on the array (same reference).
    const arr = brandTrustedArtifactArrayForTest([RECORD]);
    const contextVariables = { Plans: arr } as Record<string, unknown>;
    const merged = { ...contextVariables };
    expect(isTrustedArtifactArray(merged.Plans)).toBe(true);
    expect(merged.Plans).toBe(arr);
  });

  it('Array container brand is stripped by [...arr] (inner spread)', () => {
    // Spreading the array itself produces a new array without the brand.
    const arr = brandTrustedArtifactArrayForTest([RECORD]);
    const reSpread = [...arr];
    expect(isTrustedArtifactArray(reSpread)).toBe(false);
  });

  it('state parse seam re-mints the brand on disk load (full lifecycle)', () => {
    const schema = makeRunbookStateSchema(os.tmpdir());
    const stateRecord = {
      id: RUN_ID,
      runbook: { source: 'project' as const, path: 'p.md' },
      runbookPath: 'p.md',
      title: 't',
      step: '1',
      stepName: 's',
      retryCount: 0,
      variables: { Plan: RECORD },
      steps: [{ id: '1', status: 'running' }],
      resolvedCompletions: {},
      frameEntries: {},
      startedAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:00.000Z',
      frontmatterOutputs: [],
      lifecycle: 'running',
      schemaVersion: 1,
    };
    const persisted = JSON.parse(JSON.stringify(stateRecord));
    const reloaded = schema.parse(persisted) as { variables: Record<string, unknown> };
    expect(isTrustedArtifactRecord(reloaded.variables.Plan)).toBe(true);
  });
});
