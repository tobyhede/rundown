import { describe, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  coalesceManifestRecords,
  type ArtifactManifestRecord,
} from '../../src/runbook/artifact-manifest.js';

const recordArb: fc.Arbitrary<ArtifactManifestRecord> = fc.record({
  uri: fc.string({ minLength: 1 }),
  runId: fc.constantFrom(
    'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'rd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ),
  contextId: fc.constantFrom('ctx1', 'ctx2'),
  runbook: fc.record({
    source: fc.constantFrom('project' as const, 'plugin' as const, 'bundled' as const),
    path: fc.constantFrom('a.runbook.md', 'b.runbook.md'),
  }),
  key: fc.constantFrom('plan.json', 'review.json', 'output.json'),
  timestamp: fc.constantFrom(
    '2026-05-07T00:00:00.000Z',
    '2026-05-07T01:00:00.000Z',
    '2026-05-07T02:00:00.000Z',
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
