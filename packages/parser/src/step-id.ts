import type { StepId } from './schemas.js';
import {
  isCanonicalPositiveInteger,
  isReservedWord,
  NAMED_IDENTIFIER_PATTERN,
} from './identifiers.js';

export { RESERVED_WORDS, isReservedWord, NAMED_IDENTIFIER_PATTERN } from './identifiers.js';

/**
 * Options for controlling step ID parsing behavior.
 */
export interface ParseStepIdOptions {
  /** Require a separator after the step ID (space, dash, colon) */
  readonly requireSeparator?: boolean;
}

/**
 * Validate a substep identifier: reject reserved words and non-positive numeric values.
 *
 * @param substep - The substep string to validate
 * @returns True if the substep is valid, false if it should be rejected
 */
function isValidSubstepInStepId(substep: string): boolean {
  if (NAMED_IDENTIFIER_PATTERN.test(substep) && isReservedWord(substep)) {
    return false;
  }
  if (/^\d+$/.test(substep)) {
    if (!isCanonicalPositiveInteger(substep)) return false;
  }
  return true;
}

/**
 * Parse the AT suffix from a step ID string.
 *
 * @param input - The full input string potentially containing " AT value"
 * @returns Parsed AT value and remaining step input, or null if AT value is invalid
 */
function parseAtSuffix(input: string): { atValue: StepId['at']; stepInput: string } | null {
  const atIndex = input.indexOf(' AT ');
  if (atIndex === -1) return { atValue: undefined, stepInput: input };

  const atStr = input.slice(atIndex + 4).trim();
  const stepInput = input.slice(0, atIndex).trim();

  // Parse AT value as positive integer or template variable
  const num = parseInt(atStr, 10);
  if (!Number.isNaN(num) && String(num) === atStr && num > 0) {
    return { atValue: num, stepInput };
  }
  if (/^\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}$/.test(atStr)) {
    return { atValue: atStr, stepInput };
  }
  return null; // Invalid AT value
}

/**
 * Parse three-level numeric format: 1.2.1, 1.2.Cleanup (step.iteration.substep).
 *
 * @param stepInput - The step input string (AT suffix already removed)
 * @param atValue - Parsed AT value (must be undefined for three-level — contradictory otherwise)
 * @param requireSeparator - Whether a trailing separator is required
 * @returns Parsed StepId or null if not matching
 */
function parseThreeLevelNumeric(
  stepInput: string,
  atValue: StepId['at'],
  requireSeparator: boolean,
): StepId | null {
  const pattern = requireSeparator
    ? /^(\d+)\.(\d+)\.(\d+|[A-Za-z_][A-Za-z0-9_]*)[\s\-:]/
    : /^(\d+)\.(\d+)\.(\d+|[A-Za-z_][A-Za-z0-9_]*)$/;

  const match = stepInput.match(pattern);
  if (!match) return null;

  // Three-level with explicit AT suffix is contradictory — reject
  if (atValue !== undefined) return null;

  const stepStr = match[1];
  const iterationStr = match[2];
  const substep = match[3];

  const stepNum = parseInt(stepStr, 10);
  if (!isCanonicalPositiveInteger(stepStr) || stepNum <= 0) return null;

  const iterationNum = parseInt(iterationStr, 10);
  if (!isCanonicalPositiveInteger(iterationStr) || iterationNum < 1) return null;

  if (substep && !isValidSubstepInStepId(substep)) return null;

  return { step: stepStr, substep, at: iterationNum };
}

/**
 * Parse two-level numeric format: 1, 1.2, 1.Name.
 *
 * @param stepInput - The step input string (AT suffix already removed)
 * @param atValue - Parsed AT value to attach if present
 * @param requireSeparator - Whether a trailing separator is required
 * @returns Parsed StepId or null if not matching
 */
function parseTwoLevelNumeric(
  stepInput: string,
  atValue: StepId['at'],
  requireSeparator: boolean,
): StepId | null {
  const pattern = requireSeparator
    ? /^(\d+)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?[\s\-:]/
    : /^(\d+)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?$/;

  const match = stepInput.match(pattern);
  if (!match) return null;

  const stepStr = match[1];
  const stepNum = parseInt(stepStr, 10);

  // Validate step number is positive
  if (!isCanonicalPositiveInteger(stepStr) || stepNum <= 0) return null;

  const substep = match[2];

  if (substep && !isValidSubstepInStepId(substep)) return null;

  return { step: stepStr, substep, ...(atValue !== undefined ? { at: atValue } : {}) };
}

/**
 * Parse named step format: Cleanup, ErrorHandler.1, ErrorHandler.Recover.
 *
 * @param stepInput - The step input string (AT suffix already removed)
 * @param atValue - Parsed AT value to attach if present
 * @returns Parsed StepId or null if not matching
 */
function parseNamedStep(stepInput: string, atValue: StepId['at']): StepId | null {
  const pattern = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?$/;
  const match = pattern.exec(stepInput);
  if (!match) return null;

  const stepName = match[1];
  const substep = match[2];

  // Reject reserved words as step names (NEXT already handled in caller)
  if (isReservedWord(stepName)) return null;

  if (substep && !isValidSubstepInStepId(substep)) return null;

  return { step: stepName, substep, ...(atValue !== undefined ? { at: atValue } : {}) };
}

/**
 * Parse a StepId from a string representation.
 *
 * Supports these formats:
 * - Numeric: "1", "1.2"
 * - Named: "Cleanup", "ErrorHandler.1", "ErrorHandler.Recover"
 *
 * Named steps/substeps must be valid identifiers (no spaces, no quotes).
 * Reserved words (CONTINUE, STOP, etc.) are rejected as identifiers.
 *
 * @param input - The string to parse (e.g., "1.2", "ErrorHandler")
 * @param options - Optional parsing configuration
 * @returns Parsed StepId object, or null if input is not a valid step reference
 */
export function parseStepIdFromString(input: string, options?: ParseStepIdOptions): StepId | null {
  if (!input) return null;

  // Reject quoted strings - names must be identifiers
  if (input.startsWith('"')) return null;

  const requireSeparator = options?.requireSeparator ?? false;

  const atResult = parseAtSuffix(input);
  if (!atResult) return null;
  const { atValue, stepInput } = atResult;

  // Reject dynamic format placeholders {N}, {n}, and NEXT
  if (
    stepInput === '{N}' ||
    stepInput.startsWith('{N}.') ||
    stepInput === 'NEXT' ||
    stepInput.startsWith('NEXT.') ||
    stepInput.includes('{n}')
  ) {
    return null;
  }

  return (
    parseThreeLevelNumeric(stepInput, atValue, requireSeparator) ??
    parseTwoLevelNumeric(stepInput, atValue, requireSeparator) ??
    parseNamedStep(stepInput, atValue)
  );
}

/**
 * Serialize a StepId to its canonical string representation.
 *
 * Formats the step ID as "step" or "step.substep" depending on
 * whether a substep is specified.
 *
 * @param stepId - The StepId object to serialize
 * @returns String representation (e.g., "1", "1.2", "ErrorHandler.Recover")
 */
export function stepIdToString(stepId: StepId): string {
  let result = stepId.step;
  if (stepId.substep) {
    result = `${result}.${stepId.substep}`;
  }
  if (stepId.at !== undefined) {
    result = `${result} AT ${String(stepId.at)}`;
  }
  return result;
}

/**
 * Compare two StepIds for equality.
 *
 * Two StepIds are equal if their step, substep, and at components all match.
 *
 * @param a - First StepId to compare
 * @param b - Second StepId to compare
 * @returns True if both StepIds reference the same location
 */
export function stepIdEquals(a: StepId, b: StepId): boolean {
  return a.step === b.step && a.substep === b.substep && a.at === b.at;
}
