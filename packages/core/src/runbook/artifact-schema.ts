import { z } from 'zod';
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
      code: z.ZodIssueCode.custom,
      message: getErrorMessage(error),
    });
  }
});

const ContextIdSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeId(value, 'contextId');
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getErrorMessage(error),
    });
  }
});

const RunIdSchema = z.string().superRefine((value, ctx) => {
  try {
    assertConcreteRunId(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getErrorMessage(error),
    });
  }
});

/**
 * Artifact key validated as a safe filename segment.
 */
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

/**
 * Zod schema for artifact metadata shared by manifest records and event payloads.
 */
export const ArtifactMetadataSchema = z.object({
  runId: RunIdSchema,
  contextId: ContextIdSchema,
  runbook: RunbookRefSchema,
  key: ArtifactKeySchema,
  timestamp: z.string().datetime(),
});

/**
 * Artifact metadata without the canonical URI field.
 */
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

/**
 * Zod schema for one exact artifact manifest record.
 */
export const ArtifactRecordSchema = ArtifactMetadataSchema.extend({
  uri: z.string(),
}).superRefine((record, ctx) => {
  const identity = parseExactArtifactUriParts(record.uri);
  if (identity === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT,
      path: ['uri'],
    });
    return;
  }

  if (record.uri !== buildArtifactUri(identity)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ARTIFACT_ERROR_TEXT.URI_MUST_BE_EXACT,
      path: ['uri'],
    });
    return;
  }

  if (identity.contextId !== record.contextId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ARTIFACT_ERROR_TEXT.URI_CONTEXT_MISMATCH,
      path: ['uri'],
    });
  }
  if (identity.runId !== record.runId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ARTIFACT_ERROR_TEXT.URI_RUN_ID_MISMATCH,
      path: ['uri'],
    });
  }
  if (identity.key !== record.key) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: ARTIFACT_ERROR_TEXT.URI_KEY_MISMATCH,
      path: ['uri'],
    });
  }
});

/**
 * Exact artifact manifest record with canonical URI and metadata.
 */
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

/**
 * Structural type guard for an `ArtifactRecord`.
 *
 * Defensive: callers may pass arbitrary `unknown` values from the variable
 * map. A record matches when it has well-formed string fields `uri`,
 * `runId`, `contextId`, `key`, `timestamp`, and a `runbook` object with
 * string `source` and `path`. The `uri` is additionally validated via
 * `parseExactArtifactUriParts` so a malformed URI is rejected at the
 * structural-detection layer rather than later inside `artifactUriToPath`.
 *
 * @param value - Value to test
 * @returns `true` when the value matches the `ArtifactRecord` structural shape
 */
export function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ArtifactRecord>;
  return (
    typeof record.uri === 'string' &&
    parseExactArtifactUriParts(record.uri) !== null &&
    typeof record.runId === 'string' &&
    typeof record.contextId === 'string' &&
    typeof record.key === 'string' &&
    typeof record.timestamp === 'string' &&
    typeof record.runbook === 'object' &&
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- load-bearing: typeof null === 'object', so the next access would throw on null despite the declared `runbook: RunbookRef` type
    record.runbook !== null &&
    typeof record.runbook.source === 'string' &&
    typeof record.runbook.path === 'string'
  );
}

/**
 * Type guard: does a stored variable value carry an artifact reference?
 *
 * Returns true for both exact (`ArtifactRecord`) and wildcard
 * (`readonly ArtifactRecord[]`) forms. Detection is structural — presence
 * of well-formed `uri`, `runId`, `contextId`, `key`, `timestamp`, and
 * `runbook` fields.
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
