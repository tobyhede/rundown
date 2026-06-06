import { describe, expect, it } from '@jest/globals';
import {
  ArtifactAliasArrayEntrySchema,
  ArtifactAliasEntrySchema,
  ArtifactInspectResponseSchema,
  ArtifactLsResponseSchema,
  ArtifactPathResponseSchema,
  ArtifactUriResponseSchema,
  StatusResponseSchema,
} from '../../src/output/zod-schemas.js';

const RUN_ID = 'rd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Valid public managed artifact record (uri identity matches contextId/runId/key). */
const managed = {
  kind: 'artifact-record',
  uri: `rd://artifacts/ctx1/${RUN_ID}/plan.json`,
  runId: RUN_ID,
  contextId: 'ctx1',
  runbook: { source: 'project', path: 'workflow.runbook.md' },
  key: 'plan.json',
  timestamp: '2026-06-05T00:00:00.000Z',
  path: `/tmp/project/.rundown/work/.rd-ctx1/${RUN_ID}/plan.json`,
};

const aliasEntry = { ...managed, alias: 'PlanPath' };
const arrayEntry = { kind: 'artifact-array', alias: 'Reviews', items: [managed] };

describe('artifact response schemas', () => {
  describe('ArtifactAliasEntrySchema', () => {
    it('accepts a public record carrying an alias', () => {
      expect(ArtifactAliasEntrySchema.safeParse(aliasEntry).success).toBe(true);
    });

    it('rejects a record missing its alias', () => {
      expect(ArtifactAliasEntrySchema.safeParse(managed).success).toBe(false);
    });

    it('rejects a record missing its projected path', () => {
      const { path: _omitted, ...withoutPath } = aliasEntry;
      expect(ArtifactAliasEntrySchema.safeParse(withoutPath).success).toBe(false);
    });
  });

  describe('ArtifactAliasArrayEntrySchema', () => {
    it('accepts an alias bound to projected items', () => {
      expect(ArtifactAliasArrayEntrySchema.safeParse(arrayEntry).success).toBe(true);
    });

    it('rejects items that are not public records', () => {
      expect(
        ArtifactAliasArrayEntrySchema.safeParse({
          kind: 'artifact-array',
          alias: 'Reviews',
          items: [{ alias: 'x' }],
        }).success,
      ).toBe(false);
    });

    it('rejects an array entry missing the kind discriminant', () => {
      const { kind: _omitted, ...withoutKind } = arrayEntry;
      expect(ArtifactAliasArrayEntrySchema.safeParse(withoutKind).success).toBe(false);
    });

    it('rejects an array entry with wrong kind value', () => {
      expect(
        ArtifactAliasArrayEntrySchema.safeParse({
          ...arrayEntry,
          kind: 'artifact-record',
        }).success,
      ).toBe(false);
    });

    it('rejects an array entry with kind: file-artifact-record', () => {
      expect(
        ArtifactAliasArrayEntrySchema.safeParse({
          ...arrayEntry,
          kind: 'file-artifact-record',
        }).success,
      ).toBe(false);
    });

    it('accepts an entry with an empty items array', () => {
      expect(
        ArtifactAliasArrayEntrySchema.safeParse({
          kind: 'artifact-array',
          alias: 'Empty',
          items: [],
        }).success,
      ).toBe(true);
    });

    it('accepts an entry with multiple valid items', () => {
      expect(
        ArtifactAliasArrayEntrySchema.safeParse({
          kind: 'artifact-array',
          alias: 'Reviews',
          items: [
            managed,
            { ...managed, key: 'review.json', uri: `rd://artifacts/ctx1/${RUN_ID}/review.json` },
          ],
        }).success,
      ).toBe(true);
    });

    it('rejects an entry missing the alias field', () => {
      const { alias: _omitted, ...withoutAlias } = arrayEntry;
      expect(ArtifactAliasArrayEntrySchema.safeParse(withoutAlias).success).toBe(false);
    });

    it('rejects an entry missing the items field', () => {
      const { items: _omitted, ...withoutItems } = arrayEntry;
      expect(ArtifactAliasArrayEntrySchema.safeParse(withoutItems).success).toBe(false);
    });
  });

  describe('ArtifactLsResponseSchema', () => {
    it('accepts a mixed list of scalar and array alias entries', () => {
      expect(ArtifactLsResponseSchema.safeParse([aliasEntry, arrayEntry]).success).toBe(true);
    });

    it('rejects a non-array payload', () => {
      expect(ArtifactLsResponseSchema.safeParse(aliasEntry).success).toBe(false);
    });

    it('accepts an empty list', () => {
      expect(ArtifactLsResponseSchema.safeParse([]).success).toBe(true);
    });

    it('accepts a scalar-only list', () => {
      expect(ArtifactLsResponseSchema.safeParse([aliasEntry]).success).toBe(true);
    });

    it('accepts an array-only list', () => {
      expect(ArtifactLsResponseSchema.safeParse([arrayEntry]).success).toBe(true);
    });

    it('rejects a list containing a bare record without alias', () => {
      expect(ArtifactLsResponseSchema.safeParse([managed]).success).toBe(false);
    });

    it('rejects a list containing an array entry missing kind', () => {
      const { kind: _omitted, ...withoutKind } = arrayEntry;
      expect(ArtifactLsResponseSchema.safeParse([withoutKind]).success).toBe(false);
    });
  });

  describe('ArtifactPathResponseSchema / ArtifactInspectResponseSchema', () => {
    it('accept a bare public record, an alias entry, and an array entry', () => {
      for (const schema of [ArtifactPathResponseSchema, ArtifactInspectResponseSchema]) {
        expect(schema.safeParse(managed).success).toBe(true);
        expect(schema.safeParse(aliasEntry).success).toBe(true);
        expect(schema.safeParse(arrayEntry).success).toBe(true);
      }
    });

    it('reject a record missing kind', () => {
      const { kind: _omitted, ...withoutKind } = managed;
      expect(ArtifactPathResponseSchema.safeParse(withoutKind).success).toBe(false);
    });

    it('accept an array entry and preserve its kind: artifact-array discriminant', () => {
      for (const schema of [ArtifactPathResponseSchema, ArtifactInspectResponseSchema]) {
        const result = schema.safeParse(arrayEntry);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toHaveProperty('kind', 'artifact-array');
        }
      }
    });

    it('accept a scalar alias entry with its record kind preserved', () => {
      for (const schema of [ArtifactPathResponseSchema, ArtifactInspectResponseSchema]) {
        const result = schema.safeParse(aliasEntry);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toHaveProperty('kind', 'artifact-record');
        }
      }
    });

    it('ArtifactInspectResponseSchema rejects an array entry missing kind', () => {
      const { kind: _omitted, ...withoutKind } = arrayEntry;
      expect(ArtifactInspectResponseSchema.safeParse(withoutKind).success).toBe(false);
    });
  });

  describe('ArtifactUriResponseSchema', () => {
    it('accepts alias and array entries', () => {
      expect(ArtifactUriResponseSchema.safeParse(aliasEntry).success).toBe(true);
      expect(ArtifactUriResponseSchema.safeParse(arrayEntry).success).toBe(true);
    });

    it('rejects a bare record without an alias', () => {
      expect(ArtifactUriResponseSchema.safeParse(managed).success).toBe(false);
    });

    it('accepts an array entry and its kind discriminant is artifact-array', () => {
      const result = ArtifactUriResponseSchema.safeParse(arrayEntry);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('kind', 'artifact-array');
      }
    });

    it('rejects an array entry missing its kind discriminant', () => {
      const { kind: _omitted, ...withoutKind } = arrayEntry;
      expect(ArtifactUriResponseSchema.safeParse(withoutKind).success).toBe(false);
    });
  });

  describe('StatusResponseSchema.artifacts', () => {
    it('round-trips scalar and array artifact projections', () => {
      const result = StatusResponseSchema.safeParse({
        kind: 'status',
        active: true,
        stashed: false,
        artifacts: { PlanPath: managed, Reviews: [managed] },
      });
      expect(result.success).toBe(true);
    });
  });
});
