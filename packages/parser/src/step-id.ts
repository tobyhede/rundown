import type { StepId } from './schemas.js';

/**
 * Reserved words that cannot be used as named step or substep identifiers.
 *
 * These keywords have special meaning in the Rundown runbook syntax:
 * - Flow control: NEXT, CONTINUE, COMPLETE, STOP, GOTO, RETRY
 * - Conditionals: PASS, FAIL, YES, NO
 * - Aggregation: ALL, ANY
 *
 * Using these as step names would create parsing ambiguity.
 */
export const RESERVED_WORDS = new Set([
  'NEXT',
  'CONTINUE',
  'COMPLETE',
  'STOP',
  'GOTO',
  'RETRY',
  'PASS',
  'FAIL',
  'YES',
  'NO',
  'ALL',
  'ANY',
]);

/**
 * Check if a string is a reserved word.
 *
 * @param word - The string to check against reserved words
 * @returns True if the word is reserved and cannot be used as an identifier
 */
export function isReservedWord(word: string): boolean {
  return RESERVED_WORDS.has(word);
}

/**
 * Valid identifier pattern for named steps and substeps.
 *
 * Matches identifiers that start with a letter or underscore,
 * followed by zero or more letters, digits, or underscores.
 * Examples: "ErrorHandler", "cleanup_task", "_internal", "Step1"
 */
export const NAMED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Options for controlling step ID parsing behavior.
 */
export interface ParseStepIdOptions {
  /** Require a separator after the step ID (space, dash, colon) */
  readonly requireSeparator?: boolean;
}

/**
 * Parse a StepId from a string representation.
 *
 * Supports these formats:
 * - Numeric: "1", "1.2"
 * - Dynamic: "{N}.1", "{N}.{n}", "{N}.Name"
 * - Named: "Cleanup", "ErrorHandler.1", "ErrorHandler.Recover"
 * - Special: "NEXT" (for GOTO NEXT in dynamic contexts)
 *
 * Named steps/substeps must be valid identifiers (no spaces, no quotes).
 * Reserved words (CONTINUE, STOP, etc.) are rejected as identifiers.
 *
 * @param input - The string to parse (e.g., "1.2", "ErrorHandler", "NEXT")
 * @param options - Optional parsing configuration
 * @returns Parsed StepId object, or null if input is not a valid step reference
 */
export function parseStepIdFromString(input: string, options?: ParseStepIdOptions): StepId | null {
  if (!input) return null;

  // Reject quoted strings - names must be identifiers
  if (input.startsWith('"')) {
    return null;
  }

  // Handle NEXT as special GOTO target
  if (input === 'NEXT') {
    return { step: 'NEXT' };
  }

  // Reject NEXT with substep notation (NEXT.1 is invalid)
  if (input.startsWith('NEXT.')) {
    return null;
  }

  const requireSeparator = options?.requireSeparator ?? false;

  // === DYNAMIC STEP HANDLING: {N}.xxx ===
  if (input.startsWith('{N}.')) {
    const rest = input.slice(4); // Everything after "{N}."

    // {N}.{n} - dynamic substep
    if (rest === '{n}') {
      return { step: '{N}', substep: '{n}' };
    }

    // {N}.123 - numeric substep
    if (/^\d+$/.test(rest)) {
      const substepNum = parseInt(rest, 10);
      if (substepNum < 1) return null;
      return { step: '{N}', substep: rest };
    }

    // {N}.Name - named substep (reject reserved words)
    if (NAMED_IDENTIFIER_PATTERN.test(rest)) {
      if (isReservedWord(rest)) {
        return null;
      }
      return { step: '{N}', substep: rest };
    }

    // With separator: {N}.xxx followed by space/dash/colon
    if (requireSeparator) {
      const sepMatch = /^(\d+|\{n\}|[A-Za-z_][A-Za-z0-9_]*)[\s\-:]/.exec(rest);
      if (sepMatch) {
        return { step: '{N}', substep: sepMatch[1] };
      }
    }

    return null;
  }

  // Accept bare {N} as "restart current dynamic instance"
  if (input === '{N}') {
    return { step: '{N}' };
  }

  // Reject malformed {N}xxx (already handled {N}. above)
  if (input.startsWith('{N}')) {
    return null;
  }

  // === NUMERIC STEP HANDLING: 1, 1.2, 1.{n}, 1.Name ===
  const numericPattern = requireSeparator
    ? /^(\d+)(?:\.(\d+|\{n\}|[A-Za-z_][A-Za-z0-9_]*))?[\s\-:]/
    : /^(\d+)(?:\.(\d+|\{n\}|[A-Za-z_][A-Za-z0-9_]*))?$/;

  const numericMatch = input.match(numericPattern);
  if (numericMatch) {
    const stepStr = numericMatch[1];
    const stepNum = parseInt(stepStr, 10);

    // Validate step number is positive
    if (stepNum <= 0) return null;

    const substep = numericMatch[2];

    // Reject reserved words as named substeps (e.g., 1.CONTINUE)
    if (substep && NAMED_IDENTIFIER_PATTERN.test(substep) && isReservedWord(substep)) {
      return null;
    }

    // Validate numeric substep is positive
    if (substep && /^\d+$/.test(substep)) {
      const substepNum = parseInt(substep, 10);
      if (substepNum < 1) return null;
    }

    return { step: stepStr, substep };
  }

  // === NAMED STEP HANDLING: Cleanup, ErrorHandler.1, ErrorHandler.{n}, ErrorHandler.Recover ===
  const namedPattern = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(\d+|\{n\}|[A-Za-z_][A-Za-z0-9_]*))?$/;
  const namedMatch = namedPattern.exec(input);
  if (namedMatch) {
    const stepName = namedMatch[1];
    const substep = namedMatch[2];

    // Reject reserved words as step names (NEXT already handled above)
    if (isReservedWord(stepName)) {
      return null;
    }

    // Reject reserved words as substep names
    if (substep && NAMED_IDENTIFIER_PATTERN.test(substep) && isReservedWord(substep)) {
      return null;
    }

    // Validate numeric substep is positive
    if (substep && /^\d+$/.test(substep)) {
      const substepNum = parseInt(substep, 10);
      if (substepNum < 1) return null;
    }

    return { step: stepName, substep };
  }

  return null;
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
  // step is always string now
  if (stepId.substep) {
    return `${stepId.step}.${stepId.substep}`;
  }
  return stepId.step;
}

/**
 * Compare two StepIds for equality.
 *
 * Two StepIds are equal if both their step and substep components match.
 *
 * @param a - First StepId to compare
 * @param b - Second StepId to compare
 * @returns True if both StepIds reference the same location
 */
export function stepIdEquals(a: StepId, b: StepId): boolean {
  return a.step === b.step && a.substep === b.substep;
}
