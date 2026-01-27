/**
 * CLI output schemas using Zod.
 *
 * Defines the canonical JSON schema definitions for all CLI command outputs.
 * These schemas serve as the single source of truth for:
 * - Runtime validation in tests
 * - JSON Schema generation via `--schema` flag
 *
 * @module schemas/output-schemas
 */

import { z } from 'zod';

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodeSchema = z.enum([
  'NO_ACTIVE_RUNBOOK',
  'RUNBOOK_NOT_FOUND',
  'STEP_NOT_FOUND',
  'INVALID_SYNTAX',
  'VALIDATION_ERROR',
  'NO_STASHED_RUNBOOK',
  'AGENT_BINDING_ERROR',
  'SCENARIO_NOT_FOUND',
  'FILE_ERROR',
  'UNKNOWN_ERROR',
]).describe('Error code identifying the type of error that occurred');

// ============================================================================
// Shared Types
// ============================================================================

export const PositionSchema = z.object({
  current: z.string().describe('Current step number or identifier'),
  total: z.union([z.number(), z.string()]).describe('Total number of steps or status indicator'),
  substep: z.string().optional().describe('Optional substep identifier'),
}).describe('Current position within the runbook execution');

export const RunbookContextSchema = z.object({
  file: z.string().describe('Path to the runbook file'),
  state: z.string().describe('Current runbook state or status'),
  prompted: z.boolean().optional().describe('Whether the runbook is awaiting user input'),
}).describe('Context information about the active runbook');

export const ErrorDetailsSchema = z
  .object({
    requested: z.string().optional().describe('The item or resource that was requested'),
    available: z.array(z.string()).optional().describe('List of available options'),
    suggestion: z.string().optional().describe('Suggested resolution or alternative'),
    path: z.string().optional().describe('File path related to the error'),
    searchedLocations: z.array(z.string()).optional().describe('Locations that were searched'),
    line: z.number().optional().describe('Line number where the error occurred'),
  })
  .describe('Additional details about an error')
  .passthrough();

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Error response schema.
 *
 * All error responses must have result=false and an error message.
 */
export const ErrorResponseSchema = z
  .object({
    result: z.literal(false).describe('Always false for error responses'),
    error: z.string().describe('Error message describing what went wrong'),
    code: ErrorCodeSchema.optional().describe('Error code for programmatic handling'),
    details: ErrorDetailsSchema.optional().describe('Additional error context'),
  })
  .describe('Error response indicating command execution failure')
  .passthrough();

/**
 * Action response schema (pass, fail, goto, stop, complete).
 *
 * Action responses include the action performed and position changes.
 * Uses `result` boolean to indicate action success (PASS = true, FAIL = false).
 */
export const ActionResponseSchema = z
  .object({
    action: z.string().describe('Type of action performed'),
    command: z.string().optional().describe('Command executed for this action'),
    from: PositionSchema.optional().describe('Starting position before action'),
    to: PositionSchema.optional().describe('Position after action execution'),
    complete: z.boolean().optional().describe('Whether the runbook completed'),
    stopped: z.boolean().optional().describe('Whether the runbook was stopped'),
    runbook: RunbookContextSchema.optional().describe('Runbook context information'),
    // Flat format fields
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state after action'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
    result: z.boolean().optional().describe('Whether the action succeeded'),
    message: z.string().optional().describe('Status message from the action'),
    position: PositionSchema.optional().describe('Current position after action'),
  })
  .describe('Response from a step action command')
  .passthrough();

/**
 * Status response schema.
 *
 * Uses flat structure per CLI-OUTPUT-SPEC:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
 */
export const StatusResponseSchema = z
  .object({
    active: z.boolean().describe('Whether a runbook is currently active'),
    stashed: z.boolean().describe('Whether a runbook is stashed'),
    // Flat structure fields
    file: z.string().optional().describe('Path to the active runbook file'),
    state: z.string().optional().describe('Current runbook execution state'),
    prompted: z.boolean().optional().describe('Whether awaiting user input'),
    position: PositionSchema.optional().describe('Current step position'),
    step: z
      .object({
        name: z.string().describe('Step name or identifier'),
        description: z.string().optional().describe('Step description'),
      })
      .optional()
      .describe('Current step details'),
    lastAction: z
      .object({
        action: z.string().describe('Last action performed'),
        result: z.string().optional().describe('Result of the last action'),
      })
      .optional()
      .describe('Last action information'),
  })
  .describe('Response from the status command')
  .passthrough();

/**
 * Runbook schema - unified schema for ls and prune output.
 *
 * Both commands list runbook entries with common fields:
 * - id: state file identifier
 * - runbook: runbook filename
 * - status: state status (active, stashed, completed, stale, orphaned)
 *
 * Optional fields vary by command:
 * - step/total: position info (ls shows current position)
 * - title: when available from runbook metadata
 */
export const RunbookSchema = z.object({
  id: z.string().describe('Unique state file identifier'),
  runbook: z.string().describe('Runbook filename'),
  status: z.string().describe('Runbook status (active, stashed, completed, stale, or orphaned)'),
  step: z.string().optional().describe('Current step number'),
  total: z.number().optional().describe('Total number of steps'),
  title: z.string().optional().describe('Runbook title from metadata'),
}).describe('Runbook state entry');

/**
 * Available runbook entry (ls --all output).
 *
 * Different from RunbookStateEntry - this lists runbook files,
 * not active state entries.
 */
export const AvailableRunbookEntrySchema = z.object({
  name: z.string().describe('Runbook name from metadata or filename'),
  description: z.string().optional().describe('Runbook description from metadata'),
  path: z.string().describe('File path to the runbook'),
}).describe('Available runbook file entry');

/**
 * List of runbooks (ls or prune output).
 */
export const RunbookListSchema = z.array(RunbookSchema).describe('List of runbook state entries');

/**
 * List of available runbooks (ls --all output).
 */
export const AvailableRunbooksListSchema = z.array(AvailableRunbookEntrySchema).describe('List of available runbook files');

/**
 * Validation error entry.
 */
export const ValidationErrorSchema = z.object({
  message: z.string().describe('Error message'),
  line: z.number().optional().describe('Line number where error occurred'),
}).describe('Validation error entry');

/**
 * Check response schema.
 */
export const CheckResponseSchema = z.object({
  valid: z.boolean().describe('Whether the runbook is valid'),
  errors: z.array(ValidationErrorSchema).describe('List of validation errors'),
  stats: z
    .object({
      steps: z.number().describe('Total number of steps'),
      substeps: z.number().describe('Total number of substeps'),
    })
    .optional()
    .describe('Runbook statistics'),
}).describe('Response from the check command');

/**
 * Scenario schema (scenario ls output).
 */
export const ScenarioSchema = z.object({
  name: z.string().describe('Scenario name'),
  expected: z.string().describe('Expected scenario outcome'),
  description: z.string().optional().describe('Scenario description'),
  tags: z.string().optional().describe('Comma-separated scenario tags'),
}).describe('Scenario definition');

/**
 * Scenario list.
 */
export const ScenarioListSchema = z.array(ScenarioSchema).describe('List of scenarios in a runbook');

/**
 * Scenario show response (extends schema with commands).
 */
export const ScenarioShowResponseSchema = ScenarioSchema.extend({
  commands: z.array(z.string()).optional().describe('List of commands in the scenario'),
}).describe('Response from scenario show command');

/**
 * Scenario run response.
 *
 * Uses `passed` to indicate scenario outcome (not `result` - scenario verification, not workflow).
 */
export const ScenarioRunResponseSchema = z.object({
  scenario: z.string().describe('Scenario name'),
  expected: z.string().describe('Expected outcome'),
  actual: z.string().describe('Actual outcome'),
  passed: z.boolean().describe('Whether the scenario passed'),
  message: z.string().optional().describe('Additional status message'),
}).describe('Response from scenario run command');

/**
 * Scenario error response.
 */
export const ScenarioErrorResponseSchema = z.object({
  error: z.literal(true).describe('Always true for error responses'),
  message: z.string().describe('Error message'),
  available: z.array(z.string()).optional().describe('Available scenarios'),
}).describe('Scenario error response');

/**
 * Echo response schema.
 *
 * Uses `output` for echoed text and `result` boolean for success status.
 */
export const EchoResponseSchema = z.object({
  result: z.boolean().describe('Whether the echo command succeeded'),
  output: z.string().optional().describe('Echoed output text'),
  error: z.string().optional().describe('Error message if command failed'),
  exitCode: z.number().optional().describe('Exit code of the echo command'),
}).describe('Response from the echo command');

/**
 * Prompt response schema.
 *
 * Simple output wrapper for prompt command.
 */
export const PromptResponseSchema = z.object({
  output: z.string().describe('Prompt output text'),
}).describe('Response from the prompt command');

/**
 * Stash response schema.
 *
 * Uses action='stash' (present tense verb).
 */
export const StashResponseSchema = z
  .object({
    result: z.boolean().describe('Whether the stash operation succeeded'),
    action: z.literal('stash').describe('Action type'),
    stashedId: z.string().optional().describe('ID of the stashed runbook'),
    runbook: RunbookContextSchema.optional().describe('Runbook context'),
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state'),
    message: z.string().optional().describe('Status message'),
    position: PositionSchema.optional().describe('Position when stashed'),
  })
  .describe('Response from the stash command')
  .passthrough();

/**
 * Pop response schema.
 *
 * Uses action='pop'.
 */
export const PopResponseSchema = z
  .object({
    result: z.boolean().describe('Whether the pop operation succeeded'),
    action: z.literal('pop').describe('Action type'),
    restoredId: z.string().optional().describe('ID of the restored runbook'),
    runbook: RunbookContextSchema.optional().describe('Runbook context'),
    file: z.string().optional().describe('Path to the runbook file'),
    state: z.string().optional().describe('Runbook state'),
    message: z.string().optional().describe('Status message'),
    position: PositionSchema.optional().describe('Position when restored'),
    step: z
      .object({
        name: z.string().optional().describe('Step name'),
        description: z.string().optional().describe('Step description'),
        prompted: z.boolean().optional().describe('Whether waiting for input'),
      })
      .optional()
      .describe('Current step details'),
  })
  .describe('Response from the pop command')
  .passthrough();

/**
 * Execution summary schema.
 *
 * Output from commands that use JSONSubscriber.getSummary() like goto.
 */
export const ExecutionSummarySchema = z
  .object({
    runbookId: z.string().optional().describe('Runbook state identifier'),
    runbook: z.string().optional().describe('Runbook filename'),
    status: z.enum(['complete', 'stopped', 'running']).describe('Execution status'),
    stepsExecuted: z.number().describe('Number of steps executed'),
    commandsRun: z.number().describe('Number of commands run'),
    commandsFailed: z.number().describe('Number of commands that failed'),
    finalPosition: z
      .object({
        current: z.string().describe('Final step number'),
        total: z.union([z.number(), z.string()]).describe('Total steps'),
        substep: z.string().optional().describe('Final substep'),
      })
      .optional()
      .describe('Final execution position'),
    message: z.string().optional().describe('Execution message'),
    events: z
      .array(
        z
          .object({
            type: z.string().describe('Event type'),
            timestamp: z.string().optional().describe('Event timestamp'),
          })
          .describe('Execution event')
          .passthrough()
      )
      .optional()
      .describe('Execution events'),
  })
  .describe('Response from commands with execution summary')
  .passthrough();

// ============================================================================
// Command to Schema Mapping
// ============================================================================

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
  run: ExecutionSummarySchema,
  ls: z.union([RunbookListSchema, AvailableRunbooksListSchema]),
  prune: RunbookListSchema,
  'scenario ls': ScenarioListSchema,
  'scenario show': ScenarioShowResponseSchema,
  'scenario run': ScenarioRunResponseSchema,
};
