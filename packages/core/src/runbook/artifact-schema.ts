import { z } from 'zod';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getErrorMessage } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT } from './artifact-errors.js';
import {
  assertConcreteRunId,
  buildArtifactUri,
  parseExactArtifactUriParts,
} from './artifact-uri.js';
import { RunbookRefSchema } from './runbook-ref.js';

/**
 * Zod schema for artifact keys stored as safe filename segments.
 */
export const ArtifactKeySchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeId(value, 'ArtifactKey');
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: getErrorMessage(error),
    });
  }
});

const ContextIdSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeId(value, 'contextId');
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: getErrorMessage(error),
    });
  }
});

const RunIdSchema = z.string().superRefine((value, ctx) => {
  try {
    assertConcreteRunId(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: getErrorMessage(error),
    });
  }
});

/**
 * Artifact key validated as a safe filename segment.
 */
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

/**
 * Zod schema for artifact metadata shared by all manifest records and event payloads.
 */
const ArtifactRecordBaseSchema = z.object({
  runId: RunIdSchema,
  contextId: ContextIdSchema,
  runbook: RunbookRefSchema,
  key: z.string().min(1),
  timestamp: z.iso.datetime(),
});

/**
 * Zod schema for managed artifact metadata.
 */
export const ArtifactMetadataSchema = ArtifactRecordBaseSchema.extend({
  key: ArtifactKeySchema,
});

/**
 * Artifact metadata without the canonical URI field.
 */
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

type ArtifactRecordIdentity = ArtifactMetadata & {
  readonly uri: string;
};

function validateArtifactRecordIdentity(
  record: ArtifactRecordIdentity,
  ctx: z.RefinementCtx,
): void {
  const identity = parseExactArtifactUriParts(record.uri);
  if (identity === null) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT,
      path: ['uri'],
    });
    return;
  }

  if (record.uri !== buildArtifactUri(identity)) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT,
      path: ['uri'],
    });
    return;
  }

  if (identity.contextId !== record.contextId) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_ERROR_TEXT.URI_CONTEXT_MISMATCH,
      path: ['uri'],
    });
  }
  if (identity.runId !== record.runId) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_ERROR_TEXT.URI_RUN_ID_MISMATCH,
      path: ['uri'],
    });
  }
  if (identity.key !== record.key) {
    ctx.addIssue({
      code: 'custom',
      message: ARTIFACT_ERROR_TEXT.URI_KEY_MISMATCH,
      path: ['uri'],
    });
  }
}

const FileUriSchema = z.string().superRefine((value, ctx) => {
  try {
    const path = fileURLToPath(value);
    if (pathToFileURL(path).href !== value) {
      ctx.addIssue({
        code: 'custom',
        message: 'file artifact record uri must be a canonical file URI',
        path: ['uri'],
      });
    }
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'file artifact record uri must be a valid file URI',
      path: ['uri'],
    });
  }
});

/**
 * Zod schema for one exact artifact manifest row.
 *
 * Manifest JSONL is the documented six-field shape and does not carry the
 * state-only `kind` discriminator.
 */
export const ManagedArtifactManifestRecordSchema = ArtifactMetadataSchema.extend({
  uri: z.string(),
}).superRefine(validateArtifactRecordIdentity);

/**
 * Managed artifact manifest row — the six-field shape persisted on disk for
 * managed (`rd://`) artifacts, with no `kind` discriminator.
 *
 * State records add the `kind: 'artifact-record'` tag; manifest rows do not.
 * Use this type at the boundary between manifest IO and state record
 * construction (see {@link toStateArtifactRecord}).
 */
export type ManagedArtifactManifestRecord = z.infer<typeof ManagedArtifactManifestRecordSchema>;

/**
 * Zod schema for one file reference artifact record.
 *
 * **`key` is a declaration token, not selector-addressable.** Unlike managed
 * `ArtifactRecord.key`, the `key` field on a file artifact record stores the
 * original raw token used in the `ARTIFACTS` declaration (e.g.
 * `"schemas/review.schema.json"`). It is NOT a content-addressable identifier
 * and MUST NOT be matched against selector patterns — file rows are skipped
 * by selector matching paths (`resolveSelector`, `findArtifactMatches`) for
 * exactly this reason.
 */
export const FileArtifactRecordSchema = ArtifactRecordBaseSchema.extend({
  kind: z.literal('file-artifact-record'),
  uri: FileUriSchema,
});

/**
 * File reference artifact record with a canonical `file:///...` URI.
 *
 * `key` is the original declaration token (may contain `/` and other
 * path-shaped characters). See {@link FileArtifactRecordSchema} for the
 * selector-exclusion contract.
 */
export type FileArtifactRecord = z.infer<typeof FileArtifactRecordSchema>;

/**
 * Zod schema for one exact artifact manifest row.
 *
 * Existing managed-artifact rows are the documented six-field shape and do not
 * carry the state-only `kind` discriminator. File-reference rows carry their
 * `kind` because the URI scheme disambiguates path rendering and validation.
 */
export const ArtifactManifestRecordSchema = z.union([
  ManagedArtifactManifestRecordSchema,
  FileArtifactRecordSchema,
]);

/**
 * Exact artifact manifest row with canonical URI and metadata.
 */
export type ArtifactManifestRecord = z.infer<typeof ArtifactManifestRecordSchema>;

/**
 * Zod schema for one exact artifact record persisted in runbook state.
 */
export const ManagedArtifactRecordSchema = ArtifactMetadataSchema.extend({
  kind: z.literal('artifact-record'),
  uri: z.string(),
}).superRefine(validateArtifactRecordIdentity);

/**
 * Zod schema for one artifact record persisted in runbook state.
 */
export const ArtifactRecordSchema = z.discriminatedUnion('kind', [
  ManagedArtifactRecordSchema,
  FileArtifactRecordSchema,
]);

/**
 * Exact artifact state record with canonical URI, metadata, and discriminator.
 */
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

/** Public ArtifactRecord shape exposed in events and CLI output. */
export type PublicArtifactRecord = ArtifactManifestRecord;

/** Public artifact value shape exposed in events and CLI output. */
export type PublicArtifactVarValue = PublicArtifactRecord | readonly PublicArtifactRecord[];

/**
 * Type guard for {@link ArtifactRecord}.
 *
 * @param value - Value to test
 * @returns `true` when the value validates as a state artifact record
 */
export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  return ArtifactRecordSchema.safeParse(value).success;
}

/**
 * Type guard for `ArtifactRecord | readonly ArtifactRecord[]`.
 *
 * Tag-narrows via {@link isArtifactRecord}. Empty arrays return `false` —
 * the wildcard "no matches" case is preserved separately by the resolver.
 *
 * @param value - The value to inspect
 * @returns Type predicate narrowing to artifact-shaped values
 */
export function isArtifactValue(
  value: unknown,
): value is ArtifactRecord | readonly ArtifactRecord[] {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isArtifactRecord);
  }
  return isArtifactRecord(value);
}

/**
 * Project an internal state artifact record to the public six-field shape.
 *
 * @param record - Internal tagged artifact record
 * @returns Public artifact record without internal discriminator fields
 * @throws {z.ZodError} When `record` fails {@link ArtifactManifestRecordSchema} validation
 */
export function toPublicArtifactRecord(record: ArtifactRecord): PublicArtifactRecord {
  return ArtifactManifestRecordSchema.parse(record);
}

/**
 * Project an internal artifact variable value to the public event/output shape.
 *
 * @param value - Internal artifact variable value
 * @returns Public artifact variable value
 * @throws {z.ZodError} When `value` (or any element of an array `value`) fails
 *   {@link ArtifactManifestRecordSchema} validation
 */
export function toPublicArtifactVarValue(
  value: ArtifactRecord | readonly ArtifactRecord[],
): PublicArtifactVarValue {
  if (Array.isArray(value)) {
    return (value as readonly ArtifactRecord[]).map(toPublicArtifactRecord);
  }
  return toPublicArtifactRecord(value as ArtifactRecord);
}

/**
 * Project an internal artifact working set to public event/output values.
 *
 * @param artifacts - Internal ARTIFACTS working set
 * @returns Public ARTIFACTS working set
 * @throws {z.ZodError} When any entry in `artifacts` fails
 *   {@link ArtifactManifestRecordSchema} validation
 */
export function toPublicArtifactMap(
  artifacts: Readonly<Record<string, ArtifactRecord | readonly ArtifactRecord[]>>,
): Readonly<Record<string, PublicArtifactVarValue>> {
  return Object.fromEntries(
    Object.entries(artifacts).map(([name, value]) => [name, toPublicArtifactVarValue(value)]),
  );
}
