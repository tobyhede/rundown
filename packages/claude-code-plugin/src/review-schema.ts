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
import { locationSchema } from './location-schema.js';

/**
 * A single review item with structured location and optional recommendation.
 *
 * @example
 * ```json
 * {
 *   "title": "Import path does not resolve",
 *   "level": "error",
 *   "description": "Task 2 references '../services/auth.js' which does not exist. No file at src/services/auth.js; nearest match is src/auth/service.ts.",
 *   "location": {
 *     "path": "src/handlers/login.ts",
 *     "symbol": "authenticateUser",
 *     "kind": "function"
 *   },
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
    location: locationSchema.optional(),
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
