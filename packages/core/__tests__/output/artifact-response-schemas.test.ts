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
  });

  describe('ArtifactLsResponseSchema', () => {
    it('accepts a mixed list of scalar and array alias entries', () => {
      expect(ArtifactLsResponseSchema.safeParse([aliasEntry, arrayEntry]).success).toBe(true);
    });

    it('rejects a non-array payload', () => {
      expect(ArtifactLsResponseSchema.safeParse(aliasEntry).success).toBe(false);
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
  });

  describe('ArtifactUriResponseSchema', () => {
    it('accepts alias and array entries', () => {
      expect(ArtifactUriResponseSchema.safeParse(aliasEntry).success).toBe(true);
      expect(ArtifactUriResponseSchema.safeParse(arrayEntry).success).toBe(true);
    });

    it('rejects a bare record without an alias', () => {
      expect(ArtifactUriResponseSchema.safeParse(managed).success).toBe(false);
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
