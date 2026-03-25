/**
 * Zod schema and validation for the JSON plan format.
 *
 * Defines the canonical structure for implementation plans. Plans are
 * authored as JSON and rendered to Markdown by the generic `rdx` renderer.
 *
 * @module plan-schema
 */

import { z } from 'zod';

/**
 * String field that may contain markdown content.
 *
 * @returns Zod string schema with 'markdown' description
 */
const markdown = (): z.ZodString => z.string().describe('markdown');

/**
 * String field representing a file path.
 *
 * @returns Zod string schema with min(1) and 'filepath' description
 */
const filepath = (): z.ZodString => z.string().min(1).describe('filepath');

/**
 * A file entry describing a file affected by the plan.
 */
const FileEntry = z.object({
  path: filepath(),
  action: z.enum(['create', 'edit', 'delete']),
  notes: z.string().optional(),
});

/**
 * A fenced code block with language annotation.
 */
const CodeBlock = z.object({
  language: z.string(),
  content: z.string(),
});

/**
 * A subtask within a task. Numbering is derived from ordinal position.
 */
const Subtask = z.object({
  name: z.string().min(1),
  description: markdown().nullable(),
  code: CodeBlock.nullable().optional(),
});

/**
 * Commit step specifying files to stage and commit message.
 */
const CommitStep = z.object({
  files: z.array(filepath()),
  message: z.string().min(1),
});

/**
 * A task grouping related subtasks. Numbering is derived from ordinal position.
 */
const Task = z.object({
  name: z.string().min(1),
  files: z.array(FileEntry),
  subtasks: z.array(Subtask).min(1),
  commit: CommitStep,
});

/**
 * Document metadata rendered as YAML frontmatter by the generic renderer.
 * Named `Meta` (not `PlanMeta`) for reuse across document types.
 */
const Meta = z.object({
  version: z.literal('1.0.0'),
});

/**
 * Schema for a complete implementation plan.
 *
 * Validates the JSON structure used by the planning workflow.
 * The `meta` field is rendered as YAML frontmatter by the generic renderer.
 * The `name` field is rendered as the H1 heading.
 */
export const PlanSchema = z.object({
  name: z.string().min(1),
  meta: Meta,
  goal: markdown(),
  architecture_and_approach: markdown(),
  constraints_and_assumptions: markdown(),
  dependencies: markdown().nullable(),
  context: markdown().nullable(),
  scope_assessment: z.string().optional(),
  files: z.array(FileEntry).min(1),
  tasks: z.array(Task).min(1),
});

/** Validated plan type inferred from PlanSchema. */
export type Plan = z.infer<typeof PlanSchema>;

/** Validated task type inferred from Task schema. */
export type PlanTask = z.infer<typeof Task>;

/** Validated subtask type inferred from Subtask schema. */
export type PlanSubtask = z.infer<typeof Subtask>;

/** Validated file entry type inferred from FileEntry schema. */
export type PlanFileEntry = z.infer<typeof FileEntry>;

/** Document metadata type inferred from Meta schema. */
export type Meta = z.infer<typeof Meta>;

/**
 * Validate unknown data against the plan schema.
 *
 * @param data - Unknown data to validate
 * @returns Typed Plan object
 * @throws {ZodError} If data does not conform to PlanSchema
 */
export function validatePlan(data: unknown): Plan {
  return PlanSchema.parse(data);
}
