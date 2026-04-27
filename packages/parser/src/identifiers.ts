/**
 * Reserved words that cannot be used as named step or substep identifiers.
 *
 * These keywords have special meaning in the Rundown runbook syntax.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
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
  'BREAK',
  'DEFER',
  'FOR',
  'IN',
  'TO',
  'AT',
  'DELEGATE',
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
 */
export const NAMED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Check whether a string is a canonical positive integer.
 *
 * Canonical values have no leading zeroes and contain only decimal digits.
 *
 * @param value - The string to check
 * @returns True if the string is a positive integer in canonical form
 */
export function isCanonicalPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}
