/**
 * Schema validation helpers for CLI JSON output testing.
 *
 * Re-exports schemas from production code and provides validation utilities.
 * These validators are used in integration tests to verify JSON output format.
 *
 * @module tests/helpers/schema-validator
 */

import type { z } from 'zod';

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
  WarningResponseSchema,
  ActionResponseSchema,
  StatusResponseSchema,
  RunbookSchema,
  AvailableRunbookEntrySchema,
  RunbookListSchema,
  AvailableRunbooksListSchema,
  CollectResponseSchema,
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
  RunCommandResponseSchema,
  // Command mapping
  COMMAND_SCHEMAS,
} from '../../src/schemas/output-schemas.js';

// Import for use in local validation functions
import {
  ActionResponseSchema,
  StatusResponseSchema,
  RunbookListSchema,
  AvailableRunbooksListSchema,
  CollectResponseSchema,
  CheckResponseSchema,
  ScenarioListSchema,
  ScenarioShowResponseSchema,
  ScenarioErrorResponseSchema,
  ScenarioRunResponseSchema,
  EchoResponseSchema,
  PromptResponseSchema,
  StashResponseSchema,
  PopResponseSchema,
  ErrorResponseSchema,
  WarningResponseSchema,
  ExecutionSummarySchema,
  COMMAND_SCHEMAS,
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
export function validateSchema<T>(schema: z.ZodType<T>, data: unknown): ValidationResult {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, errors: [] };
  }
  return {
    valid: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
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
  schema: z.ZodType<T>,
  data: unknown,
  context?: string,
): asserts data is T {
  const result = validateSchema(schema, data);
  if (!result.valid) {
    const prefix = context ? `${context}: ` : '';
    throw new Error(
      `${prefix}Schema validation failed:\n${result.errors.join('\n')}\n\nActual data:\n${JSON.stringify(data, null, 2)}`,
    );
  }
}

// ============================================================================
// Published-contract Validator
// ============================================================================

/**
 * Validate a command's emitted JSON output against its published contract in
 * `COMMAND_SCHEMAS` (the exact schema consumers receive from the `--schema`
 * flag, including any warning-response wrapping).
 *
 * This is the canonical way to assert emitted-output conformance: it validates
 * against the registered schema rather than a hand-picked bare schema, so it
 * catches the output-contract drift class (e.g. an emitted `action`/`code`
 * literal the published schema does not accept).
 *
 * @param command - Command key as registered in `COMMAND_SCHEMAS` (compound
 *   commands use space-separated keys, e.g. `'scenario ls'`).
 * @param data - Parsed command JSON output to validate.
 * @returns Validation result with schema errors, if any. Reports an error when
 *   the command has no registered schema (so the guard surfaces gaps).
 */
export function validateCommandOutput(command: string, data: unknown): ValidationResult {
  // `COMMAND_SCHEMAS` is typed as a total record, but an unknown command name
  // resolves to undefined at runtime — narrow so the guard below is meaningful.
  const schema = COMMAND_SCHEMAS[command] as z.ZodType | undefined;
  if (!schema) {
    return { valid: false, errors: [`No schema registered in COMMAND_SCHEMAS for "${command}"`] };
  }
  return validateSchema(schema, data);
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
 * Validate collect command JSON output.
 *
 * @param data - Parsed collect command JSON output to validate
 * @returns Validation result with schema errors, if any
 */
export function validateCollectOutput(data: unknown): ValidationResult {
  return validateSchema(CollectResponseSchema, data);
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
  return validateSchema(ScenarioShowResponseSchema, data);
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

/**
 * Validate warning response JSON output.
 */
export function validateWarningOutput(data: unknown): ValidationResult {
  return validateSchema(WarningResponseSchema, data);
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
  schema: z.ZodType<T>,
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
