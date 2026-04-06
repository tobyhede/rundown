/**
 * Zod schema and validation for the JSON plan format.
 *
 * Defines the canonical structure for implementation plans. Plans are
 * authored as JSON and rendered to Markdown by the generic `rdx` renderer.
 *
 * @module plan-schema
 */

import { z } from 'zod';
import { locationObjectSchema } from './location-schema.js';

/**
 * A file entry describing a file affected by the plan.
 *
 * Extends the shared {@link locationSchema} with plan-specific fields.
 * The `symbol`, `kind`, `line`, and `end_line` fields from the location
 * schema are optional and available for future use. Plan validators
 * reject `line` and `end_line` in plan context.
 */
const FileEntry = locationObjectSchema
  .extend({
    action: z.enum(['create', 'edit', 'delete']),
    notes: z.string().optional(),
  })
  .strict();

/**
 * A fenced code block with language annotation.
 */
const CodeBlock = z
  .object({
    language: z.string().min(1),
    content: z.string(),
  })
  .strict();

/**
 * A subtask within a task. Numbering is derived from ordinal position.
 */
const Subtask = z
  .object({
    name: z.string().min(1),
    description: z.string().describe('What this subtask does and how').optional(),
    code: CodeBlock.optional(),
  })
  .strict();

/**
 * Commit step specifying files to stage and commit message.
 */
const CommitStep = z
  .object({
    files: z.array(z.string().min(1).describe('File path to stage for commit')).min(1),
    message: z.string().min(1),
  })
  .strict();

/**
 * A task grouping related subtasks. Numbering is derived from ordinal position.
 *
 * `files` intentionally allows an empty array — research or config-only tasks
 * may not touch any files directly. `commit.files` independently enforces that
 * commits stage at least one file.
 */
const Task = z
  .object({
    name: z.string().min(1),
    files: z.array(FileEntry),
    subtasks: z.array(Subtask).min(1),
    commit: CommitStep.optional(),
  })
  .strict();

/**
 * Document metadata rendered as YAML frontmatter by the generic renderer.
 * Named `Meta` (not `PlanMeta`) for reuse across document types.
 */
const Meta = z
  .object({
    version: z.literal('1.0.0'),
  })
  .strict();

/**
 * Schema for a complete implementation plan.
 *
 * Validates the JSON structure used by the planning workflow.
 * The `meta` field is rendered as YAML frontmatter by the generic renderer.
 * The `name` field is rendered as the H1 heading.
 */
export const PlanSchema = z
  .object({
    $schema: z.literal('https://rundown.org/schemas/plan.schema.json').optional(),
    name: z.string().min(1),
    meta: Meta,
    goal: z.string().describe('Clear, concise description of the desired outcome'),
    architecture_and_approach: z
      .string()
      .describe('High-level solution design, critical components, data and integrations'),
    constraints_and_assumptions: z.string().describe('Hard constraints and assumptions'),
    dependencies: z
      .string()
      .describe('Required services, frameworks, libraries, or upstream changes')
      .optional(),
    context: z.string().describe('Additional context useful for implementation').optional(),
    files: z.array(FileEntry).min(1),
    tasks: z.array(Task).min(1),
  })
  .strict();

/** Validated plan type inferred from PlanSchema. */
export type Plan = z.infer<typeof PlanSchema>;

/** Validated task type inferred from Task schema. */
export type PlanTask = z.infer<typeof Task>;

/** Validated subtask type inferred from Subtask schema. */
export type PlanSubtask = z.infer<typeof Subtask>;

/** Validated file entry type inferred from FileEntry schema. */
export type PlanFileEntry = z.infer<typeof FileEntry>;

/** Document metadata type inferred from Meta schema. */
export type PlanMeta = z.infer<typeof Meta>;

/**
 * Validate unknown data against the plan schema.
 *
 * Convention export for generic rdx schema discovery.
 * Schema modules export `validate(data)` so rdx can load them by name.
 *
 * @param data - Unknown data to validate
 * @returns Typed Plan object
 * @throws {ZodError} If data does not conform to PlanSchema
 */
export function validate(data: unknown): Plan {
  return PlanSchema.parse(data);
}

/**
 * Alias for {@link validate} — retained for backward compatibility.
 *
 * @param data - Unknown data to validate
 * @returns Typed Plan object
 * @throws {ZodError} If data does not conform to PlanSchema
 */
export const validatePlan = validate;
