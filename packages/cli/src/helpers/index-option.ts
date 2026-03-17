/**
 * Shared validation for the `--index` CLI option.
 *
 * Parses and validates `--index <number>` against any existing AT value
 * from step ID parsing, ensuring consistent iteration targeting across
 * all step-targeting commands.
 *
 * @module helpers/index-option
 */

/**
 * Resolve `--index` flag against a parsed AT value from step ID syntax.
 *
 * Validates that the index is a positive integer and checks for conflicts
 * with any AT value already parsed from the step ID string (e.g., "3 AT 2"
 * or three-level "1.2.1").
 *
 * @param indexFlag - Raw `--index` value from CLI (string or undefined)
 * @param parsedAt - AT value from `parseStepIdFromString` (number, template string, or undefined)
 * @returns Resolved iteration index, or undefined if neither input is provided
 * @throws {IndexOptionError} on invalid input or conflicting values
 */
export function resolveIndexOption(
  indexFlag: string | undefined,
  parsedAt: number | string | undefined,
): number | undefined {
  if (indexFlag === undefined && parsedAt === undefined) {
    return undefined;
  }

  // Parse --index flag
  let indexValue: number | undefined;
  if (indexFlag !== undefined) {
    const num = parseInt(indexFlag, 10);
    if (Number.isNaN(num) || String(num) !== indexFlag || num < 1) {
      throw new IndexOptionError(
        `Invalid --index value: "${indexFlag}". Must be a positive integer (>= 1).`,
        'INVALID_SYNTAX',
      );
    }
    indexValue = num;
  }

  // Template variable AT (string) + numeric --index → error
  if (typeof parsedAt === 'string' && indexValue !== undefined) {
    throw new IndexOptionError(
      `--index ${String(indexValue)} conflicts with template AT expression "${parsedAt}"`,
      'CONFLICTING_INDEX',
    );
  }

  // Both numeric and they differ → error
  if (typeof parsedAt === 'number' && indexValue !== undefined && parsedAt !== indexValue) {
    throw new IndexOptionError(
      `--index ${String(indexValue)} conflicts with AT ${String(parsedAt)} from step ID`,
      'CONFLICTING_INDEX',
    );
  }

  // At this point: no conflicts. Return whichever numeric value is available.
  // Template-string AT with no --index yields undefined (resolved later by execution engine).
  return indexValue ?? (typeof parsedAt === 'number' ? parsedAt : undefined);
}

/**
 * Validate that `--index` is only used with `--step`.
 *
 * Returns an error message string if validation fails, or `undefined` if valid.
 * Callers are responsible for emitting the error and exiting.
 *
 * @param index - Raw `--index` value from CLI
 * @param step - Raw `--step` value from CLI
 * @returns Error message if invalid, undefined if valid
 */
export function validateIndexRequiresStep(
  index: string | undefined,
  step: string | undefined,
): string | undefined {
  if (index && !step) {
    return '--index requires --step';
  }
  return undefined;
}

/** Machine-readable error codes for IndexOptionError. */
export type IndexOptionErrorCode = 'INVALID_SYNTAX' | 'CONFLICTING_INDEX';

/**
 * Error thrown when `--index` validation fails.
 */
export class IndexOptionError extends Error {
  /** Error code for structured output. */
  readonly code: IndexOptionErrorCode;

  /**
   * Create a new IndexOptionError.
   *
   * @param message - Human-readable error description
   * @param code - Machine-readable error code
   */
  constructor(message: string, code: IndexOptionErrorCode) {
    super(message);
    this.name = 'IndexOptionError';
    this.code = code;
  }
}
