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
 * Assert and brand a canonical Rundown run id.
 *
 * @param value - String to validate
 * @returns Branded run id
 * @throws {Error} If the string is not a canonical run id
 */
export function assertRunId(value: string): RunId {
  if (!isRunId(value)) {
    throw new Error('Invalid run id: expected rd_<32 lowercase hex chars>');
  }
  return value;
}
