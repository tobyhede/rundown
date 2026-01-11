import type { StepId } from './schemas.js';

/**
 * Reserved words that cannot be used as named step identifiers
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
 * Check if a string is a reserved word
 */
export function isReservedWord(word: string): boolean {
  return RESERVED_WORDS.has(word);
}

/**
 * Valid identifier pattern for named steps/substeps
 */
export const NAMED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParseStepIdOptions {
  /** Require a separator after the step ID (space, dash, colon) */
  readonly requireSeparator?: boolean;
}

/**
 * Parse StepId from string
 *
 * Supports:
 * - Numeric: "1", "1.2"
 * - Dynamic: "{N}.1", "{N}.{n}", "{N}.Name"
 * - Named: "Cleanup", "ErrorHandler.1", "ErrorHandler.Recover"
 * - Special: "NEXT"
 *
 * Named steps/substeps must be valid identifiers (no spaces, no quotes).
 * Quoted strings are rejected - use identifiers only.
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

  // Reject bare {N} or malformed {N}xxx (already handled {N}. above)
  if (input === '{N}' || input.startsWith('{N}')) {
    return null;
  }

  // === NUMERIC STEP HANDLING: 1, 1.2, 1.Name ===
  const numericPattern = requireSeparator
    ? /^(\d+)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?[\s\-:]/
    : /^(\d+)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?$/;

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

  // === NAMED STEP HANDLING: Cleanup, ErrorHandler.1, ErrorHandler.Recover ===
  const namedPattern = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(\d+|[A-Za-z_][A-Za-z0-9_]*))?$/;
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
 * Serialize StepId to string
 */
export function stepIdToString(stepId: StepId): string {
  // step is always string now
  if (stepId.substep) {
    return `${stepId.step}.${stepId.substep}`;
  }
  return stepId.step;
}

/**
 * Compare two StepIds for equality
 */
export function stepIdEquals(a: StepId, b: StepId): boolean {
  return a.step === b.step && a.substep === b.substep;
}
