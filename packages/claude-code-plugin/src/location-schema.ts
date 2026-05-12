/**
 * Shared location schema for referencing code in plans and reviews.
 *
 * Inspired by SARIF v2.1.0's dual physical+logical location model,
 * simplified for Rundown's needs. Physical location uses file path
 * and optional line range. Logical location uses symbol name and kind.
 *
 * Plans and reviews both compose this type. Plan validators reject
 * line numbers in plan context; review validators allow them freely.
 *
 * @module location-schema
 */

import { z } from 'zod';

/**
 * Relative path validation pattern.
 *
 * Rejects absolute paths, drive-letter prefixes, directory traversal,
 * and backslashes. Shared with plan schema's FileEntry path validation.
 */
const PATH_PATTERN = /^(?!\/)(?![A-Za-z]:[/\\])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)/;

/**
 * A code location combining physical (file + line) and logical (symbol + kind) references.
 *
 * Modeled after SARIF's location type but without regions, byte offsets,
 * or context snippets. The `path` field uses the same validation as plan
 * schema's FileEntry to ensure consistent file references across schemas.
 *
 * @example
 * ```json
 * {
 *   "path": "src/handlers/login.ts",
 *   "line": 42,
 *   "end_line": 45,
 *   "symbol": "authenticateUser",
 *   "kind": "function"
 * }
 * ```
 */
/**
 * Base location object schema (extensible via `.extend()`).
 *
 * Use this when composing location fields into a larger schema (e.g., plan FileEntry).
 * For standalone validation, use {@link locationSchema} which adds cross-field refinements.
 */
export const locationObjectSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .regex(PATH_PATTERN, 'Must be a relative path without traversal or backslashes')
      .describe('Relative file path from project root'),
    line: z.number().int().min(1).describe('Start line number (1-based)').optional(),
    end_line: z.number().int().min(1).describe('End line number for ranges (1-based)').optional(),
    symbol: z.string().min(1).describe('Logical location name (function, class, type)').optional(),
    kind: z
      .string()
      .min(1)
      .describe(
        'Construct type: function, type, class, module, method, member, variable, namespace',
      )
      .optional(),
  })
  .strict();

/**
 * Location schema with cross-field validation.
 *
 * Wraps {@link locationObjectSchema} with a refinement that rejects
 * reversed line ranges (`end_line < line`).
 */
export const locationSchema = locationObjectSchema.superRefine((value, ctx) => {
  if (value.line !== undefined && value.end_line !== undefined && value.end_line < value.line) {
    ctx.addIssue({
      code: 'custom',
      path: ['end_line'],
      message: 'end_line must be >= line',
    });
  }
});

/** Validated location type inferred from locationSchema. */
export type Location = z.infer<typeof locationSchema>;
