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
  StashResponseSchema,
  PopResponseSchema,
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
  // Delegation schemas
  DelegationStatusEntrySchema,
  // Abort schema
  AbortResponseSchema,
  // Suite schemas
  ScenarioSuiteCaseEntrySchema,
  ScenarioSuiteListSchema,
  ScenarioSuiteCaseDetailSchema,
  ScenarioSuiteRunResponseSchema,
  // Delegate/Claim schemas
  DelegateResponseSchema,
  ClaimResponseSchema,
  // Prune schema (same format as ls output)
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

const CollectAlreadyAggregatedResponseSchema = z.object({
  /** Response type discriminant */
  kind: z.literal('collect').describe('Response type discriminant'),
  /** Command action that was performed */
  action: z.literal('collect').describe('Command action that was performed'),
  /** Collection status */
  status: z.literal('already-aggregated').describe('Collection status'),
  /** DELEGATE step scope that was collected */
  step: z.string().describe('DELEGATE step scope'),
  /** Parent runbook state identifier */
  parentRunId: z.string().describe('Parent runbook state identifier'),
});

const CollectNotActiveResponseSchema = z.object({
  /** Response type discriminant */
  kind: z.literal('collect').describe('Response type discriminant'),
  /** Command action that was performed */
  action: z.literal('collect').describe('Command action that was performed'),
  /** Collection status */
  status: z.literal('not-active').describe('Collection status'),
  /** DELEGATE step scope that was collected */
  step: z.string().describe('DELEGATE step scope'),
  /** Parent runbook state identifier */
  parentRunId: z.string().describe('Parent runbook state identifier'),
  /** Requested DELEGATE frame key */
  frameKey: z.string().describe('Requested DELEGATE frame key'),
  /** Currently active parent frame key */
  activeFrameKey: z.string().describe('Currently active parent frame key'),
  /** Number of unresolved substeps */
  unresolved: z.number().int().nonnegative().describe('Number of unresolved substeps'),
});

/**
 * Collect response schema.
 *
 * Covers the explicit JSON objects emitted by `rd collect` when delegation
 * completions have already been aggregated or the requested frame is inactive.
 */
export const CollectResponseSchema = z
  .discriminatedUnion('status', [
    CollectAlreadyAggregatedResponseSchema,
    CollectNotActiveResponseSchema,
  ])
  .describe('Response from the collect command');

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
  ActionResponseSchema,
  WarningResponseSchema,
  CheckResponseSchema,
  ResolveResponseSchema,
  EchoResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  ScenarioListSchema,
  ScenarioDetailSchema,
  ScenarioRunResponseSchema,
  ScenarioSuiteListSchema,
  ScenarioSuiteCaseDetailSchema,
  ScenarioSuiteRunResponseSchema,
  ExecutionSummarySchema,
  RunCommandResponseSchema,
  AvailableRunbooksListSchema,
  AbortResponseSchema,
  DelegateResponseSchema,
  ClaimResponseSchema,
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
  status: StatusResponseSchema,
  pass: ActionOrWarningResponseSchema,
  fail: ActionOrWarningResponseSchema,
  goto: withWarningResponse(ExecutionSummarySchema),
  complete: ActionOrWarningResponseSchema,
  stop: ActionOrWarningResponseSchema,
  stash: withWarningResponse(StashResponseSchema),
  pop: PopResponseSchema,
  check: CheckResponseSchema,
  resolve: ResolveResponseSchema,
  echo: EchoResponseSchema,
  prompt: PromptResponseSchema,
  run: RunCommandResponseSchema,
  'artifact ls': ArtifactLsResponseSchema,
  'artifact path': ArtifactPathResponseSchema,
  'artifact uri': ArtifactUriResponseSchema,
  'artifact inspect': ArtifactInspectResponseSchema,
  ls: z.union([RunbookListSchema, AvailableRunbooksListSchema]),
  prune: RunbookListSchema,
  collect: withWarningResponse(CollectResponseSchema),
  'scenario ls': ScenarioListSchema,
  'scenario show': ScenarioDetailSchema,
  'scenario run': ScenarioRunResponseSchema,
  abort: AbortResponseSchema,
  'scenario-suite ls': ScenarioSuiteListSchema,
  'scenario-suite show': ScenarioSuiteCaseDetailSchema,
  // A single `scenario-suite run <case>` emits a per-case `scenario_run`
  // result; `--all` emits the aggregate `scenario_suite_run` result.
  'scenario-suite run': z.union([ScenarioRunResponseSchema, ScenarioSuiteRunResponseSchema]),
  delegate: withWarningResponse(DelegateResponseSchema),
  claim: ClaimResponseSchema,
};
