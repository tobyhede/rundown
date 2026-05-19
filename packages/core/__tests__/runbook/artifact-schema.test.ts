import { describe, expect, it } from '@jest/globals';
import { ARTIFACT_ERROR_TEXT } from '../../src/runbook/artifact-errors.js';
import { z } from 'zod';
import {
  ArtifactKeySchema,
  ArtifactManifestRecordSchema,
  ArtifactMetadataSchema,
  ArtifactRecordSchema,
  FileArtifactRecordSchema,
  isArtifactRecord,
  toPublicArtifactMap,
  toPublicArtifactRecord,
  toPublicArtifactVarValue,
  type ArtifactRecord,
} from '../../src/runbook/artifact-schema.js';
import { RUNBOOK_REF_ERROR_TEXT, RunbookRefSchema } from '../../src/runbook/runbook-ref.js';

const RUN_ID = 'rd_0123456789abcdef0123456789abcdef';
const URI = `rd://artifacts/ctx1/${RUN_ID}/review.json`;
const VALID_RECORD = {
  kind: 'artifact-record',
  uri: URI,
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: {
    source: 'plugin',
    path: 'planning/review/review-plan-risk-safety.runbook.md',
  },
  key: 'review.json',
  timestamp: '2026-05-05T00:00:00.000Z',
} as const;

describe('artifact schemas', () => {
  it('validates artifact keys with safe filename rules', () => {
    expect(ArtifactKeySchema.parse('review.json')).toBe('review.json');
    expect(() => ArtifactKeySchema.parse('../review.json')).toThrow(/Invalid ArtifactKey/);
    expect(() => ArtifactKeySchema.parse('nested/review.json')).toThrow(/Invalid ArtifactKey/);
  });

  it('validates an exact artifact record', () => {
    expect(ArtifactRecordSchema.parse(VALID_RECORD)).toEqual(VALID_RECORD);
  });

  it('validates a file artifact record with declaration key and resolved file URI', () => {
    const record = {
      kind: 'file-artifact-record',
      uri: 'file:///tmp/rundown-project/schemas/review.schema.json',
      runId: RUN_ID,
      contextId: 'ctx1',
      runbook: {
        source: 'plugin',
        path: 'planning/review/review-plan-risk-safety.runbook.md',
      },
      key: 'schemas/review.schema.json',
      timestamp: '2026-05-05T00:00:00.000Z',
    } as const;

    expect(FileArtifactRecordSchema.parse(record)).toEqual(record);
    expect(ArtifactRecordSchema.parse(record)).toEqual(record);
    expect(ArtifactManifestRecordSchema.parse(record)).toEqual(record);
    expect(isArtifactRecord(record)).toBe(true);
  });

  it('rejects file artifact records with non-file URIs', () => {
    expect(() =>
      FileArtifactRecordSchema.parse({
        ...VALID_RECORD,
        kind: 'file-artifact-record',
      }),
    ).toThrow(/file URI/i);
  });

  it('does not narrow arbitrary tagged objects as artifact records', () => {
    expect(isArtifactRecord({ kind: 'artifact-record' })).toBe(false);
  });

  it('validates plugin and project source-root-relative runbook paths', () => {
    expect(
      RunbookRefSchema.parse({
        source: 'plugin',
        path: 'planning/review/review-plan-risk-safety.runbook.md',
      }),
    ).toEqual({
      source: 'plugin',
      path: 'planning/review/review-plan-risk-safety.runbook.md',
    });
    expect(
      RunbookRefSchema.parse({
        source: 'project',
        path: 'ops/deploy.runbook.md',
      }),
    ).toEqual({
      source: 'project',
      path: 'ops/deploy.runbook.md',
    });
  });

  it.each([
    'planning/review.runbook.md',
    { source: 'plugin', path: 'planning/review plan.runbook.md' },
    { source: 'plugin', path: 'planning/review' },
    { source: 'plugin', path: '../review.runbook.md' },
    { source: 'external', path: 'planning/review.runbook.md' },
  ])('rejects non-canonical runbook values %#', (runbook) => {
    expect(() => ArtifactRecordSchema.parse({ ...VALID_RECORD, runbook })).toThrow(
      RUNBOOK_REF_ERROR_TEXT.INVALID_RUNBOOK_REF,
    );
  });

  it('rejects unsafe context ids before artifact path usage', () => {
    expect(() => ArtifactRecordSchema.parse({ ...VALID_RECORD, contextId: '../escape' })).toThrow(
      /Invalid contextId/,
    );
  });

  it('rejects non-concrete top-level run ids in metadata and records', () => {
    const invalidMetadata = { ...VALID_RECORD, runId: 'plain_id' };

    expect(() => ArtifactMetadataSchema.parse(invalidMetadata)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_RUN_ID,
    );
    expect(() => ArtifactRecordSchema.parse(invalidMetadata)).toThrow(
      ARTIFACT_ERROR_TEXT.INVALID_RUN_ID,
    );
  });

  it('rejects identity-equivalent non-canonical URI spelling', () => {
    expect(() =>
      ArtifactRecordSchema.parse({
        ...VALID_RECORD,
        uri: `rd://artifacts/%63tx1/${RUN_ID}/review.json`,
      }),
    ).toThrow(ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT);
  });

  describe('public projection helpers @throws contract', () => {
    const INVALID_RECORD = {
      kind: 'artifact-record',
      uri: 'not-a-valid-uri',
      runId: 'plain_id',
      contextId: '../escape',
      runbook: { source: 'external', path: 'x.md' },
      key: '../bad',
      timestamp: 'not-a-timestamp',
    } as unknown as ArtifactRecord;

    it('toPublicArtifactRecord throws ZodError on invalid input', () => {
      expect(() => toPublicArtifactRecord(INVALID_RECORD)).toThrow(z.ZodError);
    });

    it('toPublicArtifactVarValue throws ZodError on invalid scalar', () => {
      expect(() => toPublicArtifactVarValue(INVALID_RECORD)).toThrow(z.ZodError);
    });

    it('toPublicArtifactVarValue throws ZodError on invalid element in array', () => {
      expect(() => toPublicArtifactVarValue([INVALID_RECORD])).toThrow(z.ZodError);
    });

    it('toPublicArtifactMap throws ZodError when any entry is invalid', () => {
      expect(() => toPublicArtifactMap({ Plan: INVALID_RECORD })).toThrow(z.ZodError);
    });
  });

  it('rejects uri/top-level field mismatches', () => {
    expect(() => ArtifactRecordSchema.parse({ ...VALID_RECORD, contextId: 'ctx2' })).toThrow(
      ARTIFACT_ERROR_TEXT.URI_CONTEXT_MISMATCH,
    );
    expect(() =>
      ArtifactRecordSchema.parse({
        ...VALID_RECORD,
        runId: 'rd_ffffffffffffffffffffffffffffffff',
      }),
    ).toThrow(ARTIFACT_ERROR_TEXT.URI_RUN_ID_MISMATCH);
    expect(() => ArtifactRecordSchema.parse({ ...VALID_RECORD, key: 'other.json' })).toThrow(
      ARTIFACT_ERROR_TEXT.URI_KEY_MISMATCH,
    );
  });
});
