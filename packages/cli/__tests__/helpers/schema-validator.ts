/**
 * Schema validation helpers for CLI JSON output testing.
 *
 * Re-exports schemas from production code and provides validation utilities.
 * These validators are used in integration tests to verify JSON output format.
 *
 * @module tests/helpers/schema-validator
 */

import { z } from 'zod';

// Re-export all schemas from production code
export {
  // Error codes
  ErrorCodeSchema,
  // Shared types
  PositionSchema,
  RunbookContextSchema,
  ErrorDetailsSchema,
  // Response schemas
  ErrorResponseSchema,
  ActionResponseSchema,
  StatusResponseSchema,
  RunbookSchema,
  AvailableRunbookEntrySchema,
  RunbookListSchema,
  AvailableRunbooksListSchema,
  ValidationErrorSchema,
  CheckResponseSchema,
  ScenarioSchema,
  ScenarioListSchema,
  ScenarioShowResponseSchema,
  ScenarioRunResponseSchema,
  ScenarioErrorResponseSchema,
  EchoResponseSchema,
  PromptResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  ExecutionSummarySchema,
  // Command mapping
  COMMAND_SCHEMAS,
} from '../../src/schemas/output-schemas.js';

// Import for use in local validation functions
import {
  ActionResponseSchema,
  StatusResponseSchema,
  RunbookListSchema,
  AvailableRunbooksListSchema,
  CheckResponseSchema,
  ScenarioListSchema,
  ScenarioSchema,
  ScenarioErrorResponseSchema,
  ScenarioRunResponseSchema,
  EchoResponseSchema,
  PromptResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  ErrorResponseSchema,
  ExecutionSummarySchema,
} from '../../src/schemas/output-schemas.js';

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
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
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
  // Check if it's state entries (has 'id') or available runbooks (has 'name')
  if ('id' in data[0]) {
    return validateSchema(RunbookListSchema, data);
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
    ScenarioSchema.extend({
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
  return validateSchema(RunbookListSchema, data);
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
