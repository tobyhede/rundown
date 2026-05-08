import { describe, expect, it } from '@jest/globals';
import * as fc from 'fast-check';
import {
  renderArtifactValue,
  renderArtifactPathValue,
  renderArtifactRecordValue,
  type RenderArtifactOptions,
} from '../../src/runbook/renderer/artifact-helper.js';
import type { ArtifactRecord } from '../../src/runbook/artifact-schema.js';

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CONTEXT_ID = 'ctx1';
const OPTIONS: RenderArtifactOptions = {
  cwd: '/tmp/project',
  workPath: '.rundown/work',
  contextId: CONTEXT_ID,
  runId: RUN_ID,
};

const recordArb: fc.Arbitrary<ArtifactRecord> = fc
  .constantFrom('plan.json', 'review.json', 'output.json', 'a-reviews.json')
  .map((key) => ({
    uri: `rd://artifacts/${CONTEXT_ID}/runs/${RUN_ID}/${key}`,
    runId: RUN_ID,
    contextId: CONTEXT_ID,
    runbook: { source: 'project' as const, path: 'planning/write-plan.runbook.md' },
    key,
    timestamp: '2026-05-07T00:00:00.000Z',
  }));

describe('render projector properties', () => {
  it('renderArtifactValue is idempotent for records', () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        expect(renderArtifactValue(record, OPTIONS)).toBe(renderArtifactValue(record, OPTIONS));
      }),
    );
  });

  it('renderArtifactValue array length matches input length', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 20 }), (records) => {
        const rendered = renderArtifactValue(records, OPTIONS);
        const parsed = JSON.parse(rendered) as string[];
        expect(parsed).toHaveLength(records.length);
      }),
    );
  });

  it('all projectors render empty array as "[]"', () => {
    expect(renderArtifactValue([], OPTIONS)).toBe('[]');
    expect(renderArtifactPathValue([], OPTIONS)).toBe('[]');
    expect(renderArtifactRecordValue([], OPTIONS)).toBe('[]');
  });

  it('renderArtifactRecordValue is idempotent for arrays', () => {
    fc.assert(
      fc.property(fc.array(recordArb, { maxLength: 10 }), (records) => {
        expect(renderArtifactRecordValue(records, OPTIONS)).toBe(
          renderArtifactRecordValue(records, OPTIONS),
        );
      }),
    );
  });
});
