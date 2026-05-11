import { describe, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  coalesceManifestRecords,
  type ArtifactManifestRecord,
} from '../../src/runbook/artifact-manifest.js';

const recordArb: fc.Arbitrary<ArtifactManifestRecord> = fc.record({
  kind: fc.constant('artifact-record' as const),
  uri: fc.string({ minLength: 1 }),
  runId: fc.constantFrom(
    'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'rd_cccccccccccccccccccccccccccccccc',
  ),
  contextId: fc.constantFrom('ctx1', 'ctx2'),
  runbook: fc.record({
    source: fc.constantFrom('project' as const, 'plugin' as const, 'bundled' as const),
    path: fc.constantFrom(
      'a.runbook.md',
      'b.runbook.md',
      'c.runbook.md',
      'planning/write-plan.runbook.md',
      'planning/review.runbook.md',
    ),
  }),
  key: fc.constantFrom(
    'plan.json',
    'review.json',
    'output.json',
    'review-plan-a.json',
    'review-plan-b.json',
    'config.yaml',
  ),
  timestamp: fc.constantFrom(
    '2026-05-07T00:00:00.000Z',
    '2026-05-07T01:00:00.000Z',
    '2026-05-07T02:00:00.000Z',
    '2026-05-07T03:00:00.000Z',
    '2026-05-07T04:00:00.000Z',
  ),
});

function identityKey(record: ArtifactManifestRecord): string {
  return [
    record.contextId,
    record.runId,
    record.runbook.source,
    record.runbook.path,
    record.key,
  ].join('\0');
}

describe('coalesceManifestRecords properties', () => {
  it('is idempotent: coalesce(coalesce(rs)) deep-equals coalesce(rs)', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 50 }), (records) => {
        const once = coalesceManifestRecords(records);
        const twice = coalesceManifestRecords(once);
        expect(twice).toEqual(once);
      }),
    );
  });

  it('preserves the identity set: identities(coalesce(rs)) === identities(rs)', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 50 }), (records) => {
        const inputIdentities = new Set(records.map(identityKey));
        const outputIdentities = new Set(coalesceManifestRecords(records).map(identityKey));
        expect(outputIdentities).toEqual(inputIdentities);
      }),
    );
  });

  it('newest timestamp wins per identity', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 50 }), (records) => {
        const coalesced = coalesceManifestRecords(records);
        // For each identity in the coalesced output, the timestamp must equal
        // the maximum timestamp of all input rows sharing that identity.
        for (const row of coalesced) {
          const id = identityKey(row);
          const maxInputTs = records
            .filter((r) => identityKey(r) === id)
            .map((r) => r.timestamp)
            .reduce((a, b) => (a > b ? a : b));
          expect(row.timestamp).toBe(maxInputTs);
        }
      }),
    );
  });

  it('on equal timestamps, the later input row wins', () => {
    fc.assert(
      fc.property(
        recordArb,
        recordArb.map((record) => ({
          ...record,
          timestamp: '2026-05-07T00:00:00.000Z',
        })),
        (left, right) => {
          const sameIdentity = {
            ...right,
            contextId: left.contextId,
            runId: left.runId,
            runbook: left.runbook,
            key: left.key,
            timestamp: left.timestamp,
          };
          const result = coalesceManifestRecords([left, sameIdentity]);
          expect(result).toEqual([sameIdentity]);
          expect(result[0]).toBe(sameIdentity);
        },
      ),
    );
  });
});
