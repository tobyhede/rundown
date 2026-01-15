import {
  ErrorCodes,
  type ErrorCodeDefinition,
  type ErrorCodeKey,
} from './codes.js';

/**
 * Context data for error formatting.
 */
export interface ErrorContext {
  /** File path related to the error */
  file?: string;
  /** Step identifier */
  step?: string;
  /** Substep identifier */
  substep?: string;
  /** Line number in source file */
  line?: number;
  /** Additional detail message (from wrapped errors) */
  message?: string;
  /** Expected value (for validation errors) */
  expected?: string | number;
  /** Found value (for validation errors) */
  found?: string | number;
  /** Invalid value that was provided */
  value?: string;
  /** Argument name (for missing arg errors) */
  argName?: string;
  /** Scenario name */
  scenario?: string;
  /** Child workflow ID */
  childId?: string;
  /** Agent ID */
  agentId?: string;
  /** Additional context-specific data */
  [key: string]: unknown;
}

/**
 * Base error class for all Rundown errors with trackable codes.
 *
 * @example
 * ```ts
 * throw new RundownError('FILE_NOT_FOUND', { file: 'workflow.md' });
 * // Error RD-101: Workflow file not found: workflow.md
 * ```
 */
export class RundownError extends Error {
  /** Error code definition */
  readonly errorCode: ErrorCodeDefinition;
  /** Additional context for error formatting */
  readonly context: ErrorContext;
  /** Original cause if wrapping another error */
  override readonly cause?: Error;

  constructor(codeKey: ErrorCodeKey, context: ErrorContext = {}, cause?: Error) {
    const errorCode = ErrorCodes[codeKey];
    const message = RundownError.formatMessage(errorCode, context);
    super(message);

    this.name = 'RundownError';
    this.errorCode = errorCode;
    this.context = context;
    this.cause = cause;

    // Maintain proper stack trace (V8/Node.js)
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Get the error code string (e.g., 'RD-101').
   */
  get code(): string {
    return this.errorCode.code;
  }

  /**
   * Get documentation URL for this error.
   */
  get docsUrl(): string {
    return `https://rundown.dev/docs/errors/${this.errorCode.docSlug}`;
  }

  /**
   * Format error message with context.
   *
   * Renders context fields in priority order, filtering out undefined values.
   */
  private static formatMessage(
    errorCode: ErrorCodeDefinition,
    context: ErrorContext
  ): string {
    const {
      file,
      step,
      substep,
      line,
      message,
      expected,
      found,
      value,
      scenario,
      argName,
      childId,
      agentId,
    } = context;

    // Primary identifier: first specific identifier wins, else file
    const specificId =
      (value !== undefined ? `"${value}"` : undefined) ??
      scenario ??
      argName ??
      childId ??
      agentId;

    const primaryId = specificId ?? file;
    const stepLocation = step && (substep ? `${step}.${substep}` : step);

    const parts = [
      errorCode.title,
      primaryId && `: ${primaryId}`,
      specificId && file && ` in ${file}`,
      stepLocation && ` at step ${stepLocation}`,
      expected !== undefined && found !== undefined &&
        ` (expected ${String(expected)}, found ${String(found)})`,
      message && ` - ${message}`,
      line && ` (line ${String(line)})`,
    ];

    return parts.filter(Boolean).join('');
  }

  /**
   * Format for CLI display.
   *
   * @param verbose - Include description and docs link
   * @returns Formatted error string
   */
  toCliString(verbose = false): string {
    const lines: string[] = [];

    lines.push(`Error ${this.code}: ${this.message}`);

    if (verbose) {
      lines.push('');
      lines.push(this.errorCode.description);
      lines.push('');
      lines.push(`Documentation: ${this.docsUrl}`);
    }

    return lines.join('\n');
  }

  /**
   * Format for JSON output (--json flag).
   */
  toJSON(): object {
    return {
      code: this.code,
      category: this.errorCode.category,
      title: this.errorCode.title,
      message: this.message,
      context: this.context,
      docsUrl: this.docsUrl,
    };
  }
}
