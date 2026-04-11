/**
 * Zod schema and validation for the JSON review format.
 *
 * Defines the canonical structure for review items. The same schema
 * serves both plan reviews and code reviews — the shape is identical
 * regardless of what was reviewed or whether items were collated
 * from multiple reviewers.
 *
 * Reviews are authored as JSON and rendered to Markdown by `rdx`.
 *
 * @module review-schema
 */

import { z } from 'zod';

/**
 * A reference to a code location, document, or external resource.
 *
 * Uses `uri` as the universal identifier — relative file paths, absolute
 * file paths, and absolute URIs are all valid. Inspired by SARIF's
 * `artifactLocation.uri`.
 * Optional detail fields (`line`, `symbol`, `kind`) are present when they
 * make sense and absent when they don't.
 *
 * @example
 * ```json
 * { "uri": "src/handler.ts", "line": 42, "symbol": "processRequest" }
 * ```
 *
 * @example
 * ```json
 * { "uri": "https://docs.example.com/error-policy" }
 * ```
 */
const Reference = z
  .object({
    uri: z.string().min(1).describe('File path (relative or absolute) or absolute URI'),
    line: z.number().int().min(1).describe('Start line number (1-based)').optional(),
    end_line: z
      .number()
      .int()
      .min(1)
      .describe('End line number for ranges (1-based, must be >= line)')
      .optional(),
    symbol: z.string().min(1).describe('Logical location name (function, class, type)').optional(),
    kind: z
      .string()
      .min(1)
      .describe(
        'Construct type: function, type, class, module, method, member, variable, namespace',
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.end_line !== undefined && value.line === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['line'],
        message: 'line is required when end_line is provided',
      });
    }
    if (value.line !== undefined && value.end_line !== undefined && value.end_line < value.line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_line'],
        message: 'end_line must be >= line',
      });
    }
  });

/**
 * A single review item with optional references and recommendation.
 *
 * @example
 * ```json
 * {
 *   "title": "Import path does not resolve",
 *   "level": "error",
 *   "description": "Task 2 references '../services/auth.js' which does not exist. No file at src/services/auth.js; nearest match is src/auth/service.ts.",
 *   "references": [
 *     { "uri": "src/handlers/login.ts", "symbol": "authenticateUser", "kind": "function" }
 *   ],
 *   "recommendation": "Update import to '../auth/service.js'"
 * }
 * ```
 */
const Item = z
  .object({
    title: z.string().min(1).describe('Short label for the item'),
    level: z
      .enum(['error', 'warning', 'note'])
      .describe('error = must fix before proceeding, warning = should fix, note = informational'),
    description: z.string().min(1).describe('What is wrong and why'),
    references: z.array(Reference).optional(),
    recommendation: z.string().min(1).describe('How to fix it').optional(),
  })
  .strict();

/** Document metadata rendered as YAML frontmatter by the generic renderer. */
const Meta = z
  .object({
    version: z.literal('2.0.0'),
  })
  .strict();

/**
 * Schema for a complete review.
 *
 * Validates the JSON structure used by plan and code review workflows.
 * Whether a review is blocking is derived from items:
 * `items.some(i => i.level === 'error')`.
 *
 * @example
 * ```json
 * {
 *   "$schema": "https://rundown.org/schemas/review.schema.json",
 *   "meta": { "version": "2.0.0" },
 *   "items": [...]
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
    items: z.array(Item),
  })
  .strict();

/** Validated review type inferred from ReviewSchema. */
export type Review = z.infer<typeof ReviewSchema>;

/** Validated item type inferred from Item schema. */
export type ReviewItem = z.infer<typeof Item>;

/** Validated reference type inferred from Reference schema. */
export type ReviewReference = z.infer<typeof Reference>;

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
