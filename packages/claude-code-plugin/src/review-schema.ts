/**
 * Zod schema and validation for the JSON review format.
 *
 * Defines the canonical structure for review findings. The same schema
 * serves both plan reviews and code reviews — the shape is identical
 * regardless of what was reviewed or whether findings were collated
 * from multiple reviewers.
 *
 * Reviews are authored as JSON and rendered to Markdown by `rdx`.
 *
 * @module review-schema
 */

import { z } from 'zod';
import { locationSchema } from './location-schema.js';

/**
 * A single review finding with structured evidence and location.
 *
 * @example
 * ```json
 * {
 *   "title": "Import path does not resolve",
 *   "severity": "blocking",
 *   "description": "Task 2 references '../services/auth.js' which does not exist.",
 *   "location": {
 *     "path": "src/handlers/login.ts",
 *     "symbol": "authenticateUser",
 *     "kind": "function"
 *   },
 *   "evidence": "No file at src/services/auth.js; nearest match is src/auth/service.ts",
 *   "recommendation": "Update import to '../auth/service.js'"
 * }
 * ```
 */
const Finding = z
  .object({
    title: z.string().min(1).describe('Short label for the finding'),
    severity: z
      .enum(['blocking', 'non_blocking'])
      .describe('blocking = must fix before proceeding, non_blocking = should fix'),
    description: z.string().min(1).describe('What is wrong and why'),
    location: locationSchema.optional(),
    evidence: z.string().min(1).describe('What was observed'),
    recommendation: z.string().min(1).describe('How to fix it'),
  })
  .strict();

/** Document metadata rendered as YAML frontmatter by the generic renderer. */
const Meta = z
  .object({
    version: z.literal('1.0.0'),
  })
  .strict();

/**
 * Schema for a complete review.
 *
 * Validates the JSON structure used by plan and code review workflows.
 * Status is a gate signal: "ok" = proceed, "blocked" = must fix first.
 * Blocking count is derived from findings — not stored as a field.
 *
 * The superRefine layer enforces cross-field invariants:
 * - ok reviews cannot contain blocking findings
 * - blocked reviews must contain at least one blocking finding
 *
 * @example
 * ```json
 * {
 *   "$schema": "https://rundown.org/schemas/review.schema.json",
 *   "meta": { "version": "1.0.0" },
 *   "status": "blocked",
 *   "findings": [...]
 * }
 * ```
 */
export const ReviewSchema = z
  .object({
    $schema: z
      .literal('https://rundown.org/schemas/review.schema.json')
      .optional()
      .describe('Schema URI for editor autocomplete and rdx validation dispatch'),
    meta: Meta,
    status: z
      .enum(['ok', 'blocked'])
      .describe('Review gate: ok = proceed, blocked = must fix blocking findings first'),
    findings: z.array(Finding),
  })
  .strict()
  .superRefine((value, ctx) => {
    const blockingCount = value.findings.filter((f) => f.severity === 'blocking').length;

    if (value.status === 'ok' && blockingCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findings'],
        message: `ok reviews cannot contain blocking findings (found ${String(blockingCount)})`,
      });
    }

    if (value.status === 'blocked' && blockingCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findings'],
        message: 'blocked reviews require at least one blocking finding',
      });
    }
  });

/** Validated review type inferred from ReviewSchema. */
export type Review = z.infer<typeof ReviewSchema>;

/** Validated finding type inferred from Finding schema. */
export type ReviewFinding = z.infer<typeof Finding>;

/** Document metadata type inferred from Meta schema. */
export type ReviewMeta = z.infer<typeof Meta>;

/**
 * Validate unknown data against the review schema.
 *
 * Convention export for generic rdx schema discovery.
 * Schema modules export `validate(data)` so rdx can load them by name.
 *
 * @param data - Unknown data to validate
 * @returns Typed Review object
 * @throws {ZodError} If data does not conform to ReviewSchema
 */
export function validate(data: unknown): Review {
  return ReviewSchema.parse(data);
}
