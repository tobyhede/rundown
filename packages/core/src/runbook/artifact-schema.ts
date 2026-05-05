import { z } from 'zod';
import { getErrorMessage } from '../errors.js';
import { assertSafeId } from '../paths.js';
import { ARTIFACT_ERROR_TEXT } from './artifact-errors.js';
import { parseExactArtifactUriParts } from './artifact-uri.js';
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
    assertSafeId(value, 'runId');
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
