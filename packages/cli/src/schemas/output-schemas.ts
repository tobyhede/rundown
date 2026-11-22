/**
 * CLI output schemas using Zod.
 *
 * Re-exports schemas from `@rundown-org/core` (single source of truth) and
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
  WarningResponseSchema,
  ActionResponseSchema,
  StatusResponseSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
  EchoResponseSchema,
  ArtifactAliasEntrySchema,
  ArtifactAliasArrayEntrySchema,
  ArtifactLsResponseSchema,
  ArtifactPathResponseSchema,
  ArtifactUriResponseSchema,
  ArtifactInspectResponseSchema,
  // List schemas
  ActiveRunbookEntrySchema,
  AvailableRunbookEntrySchema,
  ActiveRunbookListSchema,
  AvailableRunbooksListSchema,
  // Check schemas
  CheckValidationErrorSchema,
  RunbookStatsSchema,
  // Scenario schemas
  StepAssertionInputSchema,
  CapturedTransitionSchema,
  ScenarioStepAssertionResultSchema,
  ScenarioEntrySchema,
  ScenarioDetailSchema,
  ScenarioListSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  // Suite schemas
  ScenarioSuiteCaseEntrySchema,
  ScenarioSuiteListSchema,
  ScenarioSuiteCaseDetailSchema,
  ScenarioSuiteRunResponseSchema,
  // Prune schema (ls entry shape plus `retained`)
  PruneResponseSchema,
  // Execution schemas
  ExecutionSummarySchema,
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
    /** Response type discriminant */
    kind: z.literal('prompt').describe('Response type discriminant'),
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
    id: z.string().describe('Unique run identifier'),
    runbook: z.string().describe('Runbook filename'),
    status: z.string().describe('Run lifecycle (running, complete, stopped, or abandoned)'),
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

// ============================================================================
// Command to Schema Mapping
// ============================================================================

import {
  StatusResponseSchema,
  ClaimedDelegationsResponseSchema,
  PruneResponseSchema,
  ActionResponseSchema,
  WarningResponseSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
  EchoResponseSchema,
  ScenarioListSchema,
  ScenarioDetailSchema,
  ScenarioRunResponseSchema,
  ScenarioSuiteListSchema,
  ScenarioSuiteCaseDetailSchema,
  ScenarioSuiteRunResponseSchema,
  ExecutionSummarySchema,
  RunCommandResponseSchema,
  AvailableRunbooksListSchema,
  ArtifactLsResponseSchema,
  ArtifactPathResponseSchema,
  ArtifactUriResponseSchema,
  ArtifactInspectResponseSchema,
} from '@rundown-org/core';

const withWarningResponse = <Schema extends z.ZodType>(
  schema: Schema,
): z.ZodUnion<[Schema, typeof WarningResponseSchema]> => z.union([schema, WarningResponseSchema]);

const ActionOrWarningResponseSchema = withWarningResponse(ActionResponseSchema);

/**
 * Maps CLI command names to their output schemas.
 *
 * Used by the `--schema` flag to output JSON Schema for a command's JSON output.
 * Compound commands (like "scenario ls") use space-separated keys.
 */
export const COMMAND_SCHEMAS: Record<string, z.ZodType> = {
  // `status --claimed-by` (#907) answers with the Delegations holding an agent.
  status: z.union([StatusResponseSchema, ClaimedDelegationsResponseSchema]),
  pass: ActionOrWarningResponseSchema,
  fail: ActionOrWarningResponseSchema,
  goto: withWarningResponse(ExecutionSummarySchema),
  complete: ActionOrWarningResponseSchema,
  stop: ActionOrWarningResponseSchema,
  check: CheckResponseSchema,
  resolve: ResolveResponseSchema,
  echo: EchoResponseSchema,
  prompt: PromptResponseSchema,
  run: RunCommandResponseSchema,
  // All four artifact subcommands emit a no-active-runbook warning envelope
  // (artifact.ts runArtifactAction → output.noActiveRunbook), so each schema
  // must accept the warning arm alongside its success shape.
  'artifact ls': withWarningResponse(ArtifactLsResponseSchema),
  'artifact path': withWarningResponse(ArtifactPathResponseSchema),
  'artifact uri': withWarningResponse(ArtifactUriResponseSchema),
  'artifact inspect': withWarningResponse(ArtifactInspectResponseSchema),
  ls: z.union([RunbookListSchema, AvailableRunbooksListSchema]),
  prune: PruneResponseSchema,
  'scenario ls': ScenarioListSchema,
  'scenario show': ScenarioDetailSchema,
  'scenario run': ScenarioRunResponseSchema,
  'scenario-suite ls': ScenarioSuiteListSchema,
  'scenario-suite show': ScenarioSuiteCaseDetailSchema,
  // A single `scenario-suite run <case>` emits a per-case `scenario_run`
  // result; `--all` emits the aggregate `scenario_suite_run` result.
  'scenario-suite run': z.union([ScenarioRunResponseSchema, ScenarioSuiteRunResponseSchema]),
};
