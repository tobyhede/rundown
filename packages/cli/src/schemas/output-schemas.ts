/**
 * CLI output schemas using Zod.
 *
 * Re-exports schemas from @rundown-org/core (single source of truth) and
 * defines CLI-specific schemas and command mappings.
 *
 * @module schemas/output-schemas
 */

import { z } from 'zod';

// ============================================================================
// Re-export from Core (Single Source of Truth)
// ============================================================================

export {
  // Error codes
  ErrorCodeSchema,
  // Shared schemas
  PositionSchema,
  RunbookContextSchema,
  ErrorDetailsSchema,
  // Response schemas
  ErrorResponseSchema,
  ActionResponseSchema,
  StatusResponseSchema,
  CheckResponseSchema,
  EchoResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  // List schemas
  ActiveRunbookEntrySchema,
  AvailableRunbookEntrySchema,
  ActiveRunbookListSchema,
  AvailableRunbooksListSchema,
  // Check schemas
  CheckValidationErrorSchema,
  RunbookStatsSchema,
  // Scenario schemas
  ScenarioEntrySchema,
  ScenarioDetailSchema,
  ScenarioListSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  // Delegation schemas
  DelegationStatusEntrySchema,
  // Prune schema (same format as ls output)
  PruneResponseSchema,
  // Execution schemas
  ExecutionSummarySchema,
  StepQueuedResponseSchema,
  AgentBoundResponseSchema,
  RunCommandResponseSchema,
} from '@rundown-org/core';

// ============================================================================
// CLI-Specific Schemas
// ============================================================================

/**
 * Prompt response schema.
 *
 * Simple output wrapper for prompt command (CLI-only, not in core).
 */
export const PromptResponseSchema = z
  .object({
    output: z.string().describe('Prompt output text'),
  })
  .describe('Response from the prompt command');

/**
 * Runbook schema - unified schema for ls output with status field.
 *
 * This is a CLI-specific variant that includes status field for display.
 * Maps to ActiveRunbookEntrySchema from core but with status required.
 */
export const RunbookSchema = z
  .object({
    id: z.string().describe('Unique state file identifier'),
    runbook: z.string().describe('Runbook filename'),
    status: z.string().describe('Runbook status (active, stashed, completed, stale, or orphaned)'),
    step: z.string().optional().describe('Current step number'),
    total: z.number().optional().describe('Total number of steps'),
    title: z.string().optional().describe('Runbook title from metadata'),
  })
  .describe('Runbook state entry');

/**
 * List of runbooks (ls output with status).
 */
export const RunbookListSchema = z.array(RunbookSchema).describe('List of runbook state entries');

/**
 * Validation error entry (alias for consistency with CLI naming).
 */
export { CheckValidationErrorSchema as ValidationErrorSchema } from '@rundown-org/core';

/**
 * Scenario schema (alias for CLI naming consistency).
 */
export { ScenarioEntrySchema as ScenarioSchema } from '@rundown-org/core';

/**
 * Scenario show response (alias for CLI naming consistency).
 */
export { ScenarioDetailSchema as ScenarioShowResponseSchema } from '@rundown-org/core';

/**
 * Abort response schema.
 *
 * Output from `rd abort <token>` command.
 */
export const AbortResponseSchema = z
  .object({
    /** Action performed */
    action: z.literal('abort').describe('Action type'),
    /** Abort result status */
    status: z.enum(['cancelled', 'already_cancelled']).describe('Abort result status'),
    /** Truncated token hint */
    token: z.string().describe('Truncated delegation token hint'),
    /** Substep ID owning the delegation */
    substep: z.string().describe('Substep ID'),
    /** Child runbook path */
    runbook: z.string().describe('Child runbook path'),
    /** Parent run ID */
    parentRunId: z.string().describe('Parent run ID'),
    /** Whether --force was used */
    force: z.boolean().optional().describe('Whether force mode was used'),
    /** Child run ID (when force-cancelling claimed delegation) */
    childRunId: z.string().optional().describe('Child run ID when force-cancelling'),
  })
  .describe('Response from the abort command');

// ============================================================================
// Command to Schema Mapping
// ============================================================================

import {
  StatusResponseSchema,
  ActionResponseSchema,
  CheckResponseSchema,
  EchoResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  ScenarioListSchema,
  ScenarioDetailSchema,
  ScenarioRunResponseSchema,
  ExecutionSummarySchema,
  RunCommandResponseSchema,
  AvailableRunbooksListSchema,
} from '@rundown-org/core';

/**
 * Maps CLI command names to their output schemas.
 *
 * Used by the `--schema` flag to output JSON Schema for a command's JSON output.
 * Compound commands (like "scenario ls") use space-separated keys.
 */
export const COMMAND_SCHEMAS: Record<string, z.ZodSchema> = {
  status: StatusResponseSchema,
  pass: ActionResponseSchema,
  fail: ActionResponseSchema,
  goto: ExecutionSummarySchema,
  complete: ActionResponseSchema,
  stop: ActionResponseSchema,
  stash: StashResponseSchema,
  pop: PopResponseSchema,
  check: CheckResponseSchema,
  echo: EchoResponseSchema,
  prompt: PromptResponseSchema,
  run: RunCommandResponseSchema,
  ls: z.union([RunbookListSchema, AvailableRunbooksListSchema]),
  prune: RunbookListSchema,
  'scenario ls': ScenarioListSchema,
  'scenario show': ScenarioDetailSchema,
  'scenario run': ScenarioRunResponseSchema,
  abort: AbortResponseSchema,
};
