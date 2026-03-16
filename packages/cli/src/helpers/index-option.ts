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
      `--index ${indexValue} conflicts with template AT expression "${parsedAt}"`,
      'CONFLICTING_INDEX',
    );
  }

  // Both numeric and they differ → error
  if (typeof parsedAt === 'number' && indexValue !== undefined && parsedAt !== indexValue) {
    throw new IndexOptionError(
      `--index ${indexValue} conflicts with AT ${parsedAt} from step ID`,
      'CONFLICTING_INDEX',
    );
  }

  // Both match → return value (idempotent)
  if (typeof parsedAt === 'number' && indexValue !== undefined && parsedAt === indexValue) {
    return indexValue;
  }

  // Only --index provided
  if (indexValue !== undefined) {
    return indexValue;
  }

  // Only parsedAt provided (number)
  if (typeof parsedAt === 'number') {
    return parsedAt;
  }

  // parsedAt is a template string with no --index → pass through as undefined
  // (the template will be resolved later by the execution engine)
  return undefined;
}

/**
 * Error thrown when `--index` validation fails.
 */
export class IndexOptionError extends Error {
  /** Error code for structured output (e.g., 'INVALID_SYNTAX', 'CONFLICTING_INDEX') */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'IndexOptionError';
    this.code = code;
  }
}
