export declare const runIdBrand: unique symbol;

/** Canonical persisted Rundown run identifier. */
export type RunId = string & { readonly [runIdBrand]: true };

/** Prefix for every generated run id. */
export const RUN_ID_PREFIX = 'rd_';

/** Canonical concrete run id pattern. */
export const RUN_ID_PATTERN = /^rd_[a-f0-9]{32}$/;

/**
 * Return true when value is a canonical Rundown run id.
 *
 * @param value - Value to test
 * @returns Whether the value is a branded run id string
 */
export function isRunId(value: unknown): value is RunId {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/**
 * Thrown when a string that must be a canonical Rundown run id is not one.
 *
 * A dedicated class rather than a bare `Error` because consumers have to
 * classify this failure, and a bare `Error` leaves them only its message text to
 * classify it by. `rdpath` — a Claude Code hook binary — reads the session stack
 * on a best-effort path and must skip an unreadable run id rather than exit
 * non-zero on an invocation whose base directory was already supplied; before
 * this class existed it did that by matching the fragment `'Invalid run id'`,
 * which is precisely the string-discriminant smell CLAUDE.md § Design Principles
 * forbids. Reword the message and the guard silently becomes dead code.
 *
 * Purely additive: it extends `Error`, so every existing `catch` that narrows
 * with `instanceof Error` (or `isError`) is unaffected.
 */
export class InvalidRunIdError extends Error {
  /**
   * The value that failed the run-id contract, verbatim.
   *
   * Carried as data so a caller can name the offending row — which stack entry,
   * which stash slot — without re-parsing the message. The message embeds it
   * too, for surfaces that render only `error.message`.
   */
  readonly value: string;

  /**
   * Create a new InvalidRunIdError.
   *
   * @param value - The string that is not a canonical run id.
   */
  constructor(value: string) {
    super(`Invalid run id: expected rd_<32 lowercase hex chars>, got ${JSON.stringify(value)}`);
    this.name = 'InvalidRunIdError';
    this.value = value;
  }
}

/**
 * Assert and brand a canonical Rundown run id.
 *
 * @param value - String to validate
 * @returns Branded run id
 * @throws {InvalidRunIdError} If the string is not a canonical run id
 */
export function assertRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new InvalidRunIdError(value);
  }
  return value;
}
