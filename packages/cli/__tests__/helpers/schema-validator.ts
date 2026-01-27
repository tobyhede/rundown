/**
 * Schema validation helpers for CLI JSON output testing.
 *
 * Uses Zod for runtime validation to ensure CLI output matches the specification.
 * These validators are used in integration tests to verify JSON output format.
 *
 * @module tests/helpers/schema-validator
 */

import { z } from 'zod';

// ============================================================================
// Error Codes
// ============================================================================

const ErrorCodeSchema = z.enum([
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
]);

// ============================================================================
// Shared Types
// ============================================================================

const PositionSchema = z.object({
  current: z.string(),
  total: z.union([z.number(), z.string()]),
  substep: z.string().optional(),
});

const RunbookContextSchema = z.object({
  file: z.string(),
  state: z.string(),
  prompted: z.boolean().optional(),
});

const ErrorDetailsSchema = z.object({
  requested: z.string().optional(),
  available: z.array(z.string()).optional(),
  suggestion: z.string().optional(),
  path: z.string().optional(),
  searchedLocations: z.array(z.string()).optional(),
  line: z.number().optional(),
}).passthrough();

// ============================================================================
// Response Schemas
// ============================================================================

/**
 * Error response schema.
 *
 * All error responses must have result=false and an error message.
 */
export const ErrorResponseSchema = z.object({
  result: z.literal(false),
  error: z.string(),
  code: ErrorCodeSchema.optional(),
  details: ErrorDetailsSchema.optional(),
}).passthrough();

/**
 * Action response schema (pass, fail, goto, stop, complete).
 *
 * Action responses include the action performed and position changes.
 * Uses `result` boolean to indicate action success (PASS = true, FAIL = false).
 */
export const ActionResponseSchema = z.object({
  action: z.string(),
  command: z.string().optional(),
  from: PositionSchema.optional(),
  to: PositionSchema.optional(),
  complete: z.boolean().optional(),
  stopped: z.boolean().optional(),
  runbook: RunbookContextSchema.optional(),
  // Flat format fields
  file: z.string().optional(),
  state: z.string().optional(),
  prompted: z.boolean().optional(),
  result: z.boolean().optional(),
  message: z.string().optional(),
  position: PositionSchema.optional(),
}).passthrough();

/**
 * Status response schema.
 *
 * Uses flat structure per CLI-OUTPUT-SPEC:
 * - `file`/`state`/`prompted` at top level (not nested in `runbook`)
 * - `position` for step position (current/total/substep)
 * - `step` for step details (name/description)
 */
export const StatusResponseSchema = z.object({
  active: z.boolean(),
  stashed: z.boolean(),
  // Flat structure fields
  file: z.string().optional(),
  state: z.string().optional(),
  prompted: z.boolean().optional(),
  position: PositionSchema.optional(),
  step: z.object({
    name: z.string(),
    description: z.string().optional(),
  }).optional(),
  lastAction: z.object({
    action: z.string(),
    result: z.string().optional(),
  }).optional(),
}).passthrough();

/**
 * Active runbook entry (ls output).
 */
export const ActiveRunbookEntrySchema = z.object({
  id: z.string(),
  runbook: z.string(),
  step: z.string(),
  status: z.string().optional(),
});

/**
 * Available runbook entry (ls --all output).
 */
export const AvailableRunbookEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  path: z.string(),
});

/**
 * List of active runbooks.
 */
export const ActiveRunbooksListSchema = z.array(ActiveRunbookEntrySchema);

/**
 * List of available runbooks.
 */
export const AvailableRunbooksListSchema = z.array(AvailableRunbookEntrySchema);

/**
 * Validation error entry.
 */
export const ValidationErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
});

/**
 * Check response schema.
 */
export const CheckResponseSchema = z.object({
  valid: z.boolean(),
  errors: z.array(ValidationErrorSchema),
  stats: z.object({
    steps: z.number(),
    substeps: z.number(),
  }).optional(),
});

/**
 * Scenario entry (scenario ls output).
 */
export const ScenarioEntrySchema = z.object({
  name: z.string(),
  expected: z.string(),
  description: z.string().optional(),
  tags: z.string().optional(),
});

/**
 * Scenario list.
 */
export const ScenarioListSchema = z.array(ScenarioEntrySchema);

/**
 * Scenario run response.
 *
 * Uses `passed` to indicate scenario outcome (not `result` - scenario verification, not workflow).
 */
export const ScenarioRunResponseSchema = z.object({
  scenario: z.string(),
  expected: z.string(),
  actual: z.string(),
  passed: z.boolean(),
  message: z.string().optional(),
});

/**
 * Scenario error response.
 */
export const ScenarioErrorResponseSchema = z.object({
  error: z.literal(true),
  message: z.string(),
  available: z.array(z.string()).optional(),
});

/**
 * Echo response schema.
 *
 * Uses `output` for echoed text and `result` boolean for success status.
 */
export const EchoResponseSchema = z.object({
  result: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().optional(),
});

/**
 * Prompt response schema.
 *
 * Simple output wrapper for prompt command.
 */
export const PromptResponseSchema = z.object({
  output: z.string(),
});

/**
 * Prune entry.
 */
export const PruneEntrySchema = z.object({
  id: z.string(),
  runbook: z.string(),
  reason: z.string(),
});

/**
 * Prune list.
 */
export const PruneListSchema = z.array(PruneEntrySchema);

/**
 * Stash response schema.
 *
 * Uses action='stash' (present tense verb).
 */
export const StashResponseSchema = z.object({
  result: z.boolean(),
  action: z.literal('stash'),
  stashedId: z.string().optional(),
  runbook: RunbookContextSchema.optional(),
  file: z.string().optional(),
  state: z.string().optional(),
  message: z.string().optional(),
  position: PositionSchema.optional(),
}).passthrough();

/**
 * Pop response schema.
 *
 * Uses action='pop'.
 */
export const PopResponseSchema = z.object({
  result: z.boolean(),
  action: z.literal('pop'),
  restoredId: z.string().optional(),
  runbook: RunbookContextSchema.optional(),
  file: z.string().optional(),
  state: z.string().optional(),
  message: z.string().optional(),
  position: PositionSchema.optional(),
  step: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    prompted: z.boolean().optional(),
  }).optional(),
}).passthrough();

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validation result with error details.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate JSON output against a schema.
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @returns Validation result with error details
 */
export function validateSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): ValidationResult {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.errors.map(
      (e) => `${e.path.join('.')}: ${e.message}`
    ),
  };
}

/**
 * Assert that JSON output is valid against a schema.
 *
 * Throws an error with detailed messages if validation fails.
 *
 * @param schema - Zod schema to validate against
 * @param data - Data to validate
 * @param context - Optional context for error message
 */
export function assertValidSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  context?: string
): asserts data is T {
  const result = validateSchema(schema, data);
  if (!result.valid) {
    const prefix = context ? `${context}: ` : '';
    throw new Error(
      `${prefix}Schema validation failed:\n${result.errors.join('\n')}\n\nActual data:\n${JSON.stringify(data, null, 2)}`
    );
  }
}

/**
 * Execution summary schema.
 *
 * Output from commands that use JSONSubscriber.getSummary() like goto.
 */
export const ExecutionSummarySchema = z.object({
  runbookId: z.string().optional(),
  runbook: z.string().optional(),
  status: z.enum(['complete', 'stopped', 'running']),
  stepsExecuted: z.number(),
  commandsRun: z.number(),
  commandsFailed: z.number(),
  finalPosition: z.object({
    current: z.string(),
    total: z.union([z.number(), z.string()]),
    substep: z.string().optional(),
  }).optional(),
  message: z.string().optional(),
  events: z.array(z.object({
    type: z.string(),
    timestamp: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

// ============================================================================
// Command-specific Validators
// ============================================================================

/**
 * Validate pass/fail/goto command JSON output.
 */
export function validateActionOutput(data: unknown): ValidationResult {
  return validateSchema(ActionResponseSchema, data);
}

/**
 * Validate execution summary JSON output (used by goto and other execution commands).
 */
export function validateExecutionSummary(data: unknown): ValidationResult {
  return validateSchema(ExecutionSummarySchema, data);
}

/**
 * Validate status command JSON output.
 */
export function validateStatusOutput(data: unknown): ValidationResult {
  return validateSchema(StatusResponseSchema, data);
}

/**
 * Validate ls command JSON output.
 */
export function validateLsOutput(data: unknown): ValidationResult {
  if (!Array.isArray(data)) {
    return { valid: false, errors: ['Expected array output'] };
  }
  if (data.length === 0) {
    return { valid: true, errors: [] };
  }
  // Check if it's active runbooks (has 'id') or available runbooks (has 'name')
  if ('id' in data[0]) {
    return validateSchema(ActiveRunbooksListSchema, data);
  }
  return validateSchema(AvailableRunbooksListSchema, data);
}

/**
 * Validate check command JSON output.
 */
export function validateCheckOutput(data: unknown): ValidationResult {
  return validateSchema(CheckResponseSchema, data);
}

/**
 * Validate scenario ls command JSON output.
 */
export function validateScenarioLsOutput(data: unknown): ValidationResult {
  return validateSchema(ScenarioListSchema, data);
}

/**
 * Validate scenario show command JSON output.
 */
export function validateScenarioShowOutput(data: unknown): ValidationResult {
  // Could be error or success
  if (typeof data === 'object' && data !== null && 'error' in data) {
    return validateSchema(ScenarioErrorResponseSchema, data);
  }
  // For show, we expect scenario detail (entry + commands)
  return validateSchema(
    ScenarioEntrySchema.extend({
      commands: z.array(z.string()).optional(),
    }),
    data
  );
}

/**
 * Validate scenario run command JSON output.
 */
export function validateScenarioRunOutput(data: unknown): ValidationResult {
  return validateSchema(ScenarioRunResponseSchema, data);
}

/**
 * Validate echo command JSON output.
 */
export function validateEchoOutput(data: unknown): ValidationResult {
  return validateSchema(EchoResponseSchema, data);
}

/**
 * Validate prompt command JSON output.
 */
export function validatePromptOutput(data: unknown): ValidationResult {
  return validateSchema(PromptResponseSchema, data);
}

/**
 * Validate prune command JSON output.
 */
export function validatePruneOutput(data: unknown): ValidationResult {
  return validateSchema(PruneListSchema, data);
}

/**
 * Validate stash command JSON output.
 */
export function validateStashOutput(data: unknown): ValidationResult {
  return validateSchema(StashResponseSchema, data);
}

/**
 * Validate pop command JSON output.
 */
export function validatePopOutput(data: unknown): ValidationResult {
  return validateSchema(PopResponseSchema, data);
}

/**
 * Validate error response JSON output.
 */
export function validateErrorOutput(data: unknown): ValidationResult {
  return validateSchema(ErrorResponseSchema, data);
}

// ============================================================================
// Jest Matchers
// ============================================================================

/**
 * Custom Jest matcher for schema validation.
 *
 * Usage:
 * ```typescript
 * expect(output).toMatchSchema(ActionResponseSchema);
 * ```
 */
export function toMatchSchema<T>(
  received: unknown,
  schema: z.ZodSchema<T>
): { pass: boolean; message: () => string } {
  const result = validateSchema(schema, received);
  if (result.valid) {
    return {
      pass: true,
      message: () => 'Expected value not to match schema',
    };
  }
  return {
    pass: false,
    message: () =>
      `Expected value to match schema:\n${result.errors.join('\n')}\n\nReceived:\n${JSON.stringify(received, null, 2)}`,
  };
}

// Export schemas for direct use
export {
  PositionSchema,
  RunbookContextSchema,
  ErrorDetailsSchema,
};
