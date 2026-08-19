import { ErrorCodes, type ErrorCodeDefinition, type ErrorCodeKey } from './codes.js';

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
  /** Child runbook ID */
  childId?: string;
  /** Agent ID */
  agentId?: string;
  /** Additional context-specific data */
  [key: string]: unknown;
}

/**
 * Why one run's persisted state was refused (RD-309).
 *
 * A closed union rather than free text: it is the machine-readable half of a
 * refusal whose prose a consumer would otherwise have to pattern-match. Every
 * member names exactly one refusal site in `RunbookStateManager.load`,
 * `applyRunbookStateUpdate`, `readPersistedReEntryFrontier`, or
 * `validateReason` — and only sites whose refusal can actually escape to the
 * CLI wrapper. A throw that is caught and downgraded in the same call (the
 * not-in-recovery-state check inside `ExecutionRecoveryService.recover`) has no
 * member here, because a reason it could never surface would be dead data.
 */
export type InvalidRunStateReason =
  /** `state_json` is not parseable JSON. */
  | 'unparseable_json'
  /** The row claims a `schemaVersion` other than the current one. */
  | 'invalid_schema_version'
  /** A current-schema row is missing the required `templateVars` field. */
  | 'missing_template_vars'
  /** The row parsed as JSON but failed the `RunbookState` schema. */
  | 'schema_validation_failed'
  /** The deprecated dynamic-step snapshot shape (`GOTO_NEXT` or `instance`). */
  | 'legacy_dynamic_step_snapshot'
  /** The persisted snapshot's `delegateFrontier` is not a valid entry array. */
  | 'malformed_delegate_frontier'
  /** A persisted `execution_attempts.reason` is not a recognized reason. */
  | 'unrecognized_recovery_reason'
  /** The run carries no `ContextId` / `WorkPath` to render its frame against. */
  | 'missing_render_context'
  /** The persisted `snapshot.value` is not a shape this build can read. */
  | 'unsupported_snapshot_state_value'
  /** The persisted `snapshot.value` names a step the parsed runbook does not declare. */
  | 'snapshot_step_not_in_runbook'
  /** A current-schema row is missing the required `frontmatterOutputs` field. */
  | 'missing_frontmatter_outputs';

/**
 * Structured facts about one run's refused persisted state (RD-309).
 *
 * RD-309 is the only `3xx` STATE error scoped to a single run, so `runId` is
 * the field a consumer needs and the one the prose used to hide: before this
 * existed the error's `context` held nothing but `message`, which names the run
 * only inside English text and does not carry the found schema version at all.
 * These fields are lifted from the throw site and ride in
 * {@link RundownError.context}, so nothing has to be parsed back out of the
 * message.
 *
 * Discriminated on `reason` rather than flat with an optional `schemaVersion`,
 * because the version is meaningful for exactly one refusal. Optional permitted
 * both mistakes this shape exists to prevent: an `invalid_schema_version`
 * defect omitting the found version — the one fact that refusal carries and its
 * message never states — and any other reason claiming a version it never read.
 * `rundown-error.test.ts` pins both rejections at the type level.
 */
export type InvalidRunStateDefect =
  | {
      /** The run whose persisted state was refused. */
      readonly runId: string;
      /** Which refusal fired. */
      readonly reason: 'invalid_schema_version';
      /**
       * The schema version the row claims, exactly as persisted.
       *
       * Deliberately `unknown` rather than `number`: the value comes from
       * untrusted persisted JSON, and refusing to narrow it is the point — a
       * row claiming `"2"` or `null` is exactly the case worth reporting.
       * Required here, so the refusal that turns on the version can never drop
       * it.
       */
      readonly schemaVersion: unknown;
    }
  | {
      /** The run whose persisted state was refused. */
      readonly runId: string;
      /** Which refusal fired. */
      readonly reason: Exclude<InvalidRunStateReason, 'invalid_schema_version'>;
      /**
       * Never present: these refusals never read a schema version.
       *
       * Declared as absent-by-type rather than simply omitted so the key stays
       * readable on the union without narrowing — the RD-309 factory tests
       * `schemaVersion === undefined` to decide whether to emit it — while any
       * value assigned to it is still a type error.
       */
      readonly schemaVersion?: never;
    };

/**
 * Base error class for all Rundown errors with trackable codes.
 *
 * @example
 * ```ts
 * throw new RundownError('FILE_NOT_FOUND', { file: 'runbook.md' });
 * // Error RD-101: Runbook file not found: runbook.md
 * ```
 */
export class RundownError extends Error {
  /** Error code definition */
  readonly errorCode: ErrorCodeDefinition;
  /** Additional context for error formatting */
  readonly context: ErrorContext;
  /** Original cause if wrapping another error */
  override readonly cause?: Error;

  /**
   * Create a new RundownError from an error code key.
   *
   * @param codeKey - The error code key (e.g., 'FILE_NOT_FOUND')
   * @param context - Additional context for error message formatting
   * @param cause - Original error if wrapping another error
   */
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
   *
   * @returns The formatted error code string
   */
  get code(): string {
    return this.errorCode.code;
  }

  /**
   * Format error message with context.
   *
   * Renders context fields in priority order, filtering out undefined values.
   * @param errorCode - The error code definition with title and description
   * @param context - Context data for message interpolation
   * @returns Formatted error message string
   */
  private static formatMessage(errorCode: ErrorCodeDefinition, context: ErrorContext): string {
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
      (value !== undefined ? `"${value}"` : undefined) ?? scenario ?? argName ?? childId ?? agentId;

    const primaryId = specificId ?? file;
    const stepLocation = step && (substep ? `${step}.${substep}` : step);

    const parts = [
      errorCode.title,
      primaryId && `: ${primaryId}`,
      specificId && file && ` in ${file}`,
      stepLocation && ` at step ${stepLocation}`,
      expected !== undefined &&
        found !== undefined &&
        ` (expected ${String(expected)}, found ${String(found)})`,
      message && ` - ${message}`,
      line && ` (line ${String(line)})`,
    ];

    return parts.filter(Boolean).join('');
  }

  /**
   * Format for CLI display.
   *
   * Verbose appends the registered `description` and nothing else. No
   * documentation link is emitted — see {@link ErrorCodeDefinition.docSlug} for
   * why the slug survives with no URL consumer.
   *
   * @param verbose - Append the registered description
   * @returns Formatted error string
   */
  toCliString(verbose = false): string {
    const lines: string[] = [];

    lines.push(`Error ${this.code}: ${this.message}`);

    if (verbose) {
      lines.push('');
      lines.push(this.errorCode.description);
    }

    return lines.join('\n');
  }

  /**
   * Format for JSON output (--json flag).
   *
   * @returns Plain object with error details for serialization
   */
  toJSON(): object {
    return {
      code: this.code,
      category: this.errorCode.category,
      title: this.errorCode.title,
      message: this.message,
      context: this.context,
    };
  }
}
