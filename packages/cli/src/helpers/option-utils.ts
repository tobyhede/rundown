/**
 * Shared Commander option utilities for CLI commands.
 *
 * Provides reusable argParser functions and option helpers used across
 * multiple CLI commands (run, delegate, claim, resolve, echo).
 *
 * @module helpers/option-utils
 */

import { InvalidArgumentError } from 'commander';
import {
  isValidVariableName,
  parseVarFlag,
  VALID_IDENTIFIER,
} from '../services/variable-discovery.js';

/**
 * Collect option values into an array.
 * Used as a Commander argParser for repeatable options.
 *
 * @param value - The new value to add
 * @param previous - Previously collected values
 * @returns Updated array with new value appended
 */
export function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Commander argParser for --var that validates at parse time.
 *
 * Supports two forms:
 * - `key=value`: validates identifier and accumulates
 * - `KEY` (no =): inherits value from process.env[KEY]
 *
 * @param value - The raw flag value
 * @param previous - Previously accumulated values
 * @returns Updated array with new key=value entry
 * @throws {InvalidArgumentError} When identifier is invalid or env var not set
 */
export function parseVarOption(value: string, previous: string[]): string[] {
  const eqIndex = value.indexOf('=');
  if (eqIndex !== -1) {
    const parsed = parseVarFlag(value);
    if (!parsed) {
      const key = value.slice(0, eqIndex);
      const msg = VALID_IDENTIFIER.test(key)
        ? `Reserved variable name: "${key}" — cannot use __proto__, constructor, or prototype`
        : `Invalid variable: "${value}" — key must match [a-zA-Z_][a-zA-Z0-9_]*`;
      throw new InvalidArgumentError(msg);
    }
    return [...previous, value];
  }
  if (!isValidVariableName(value)) {
    const msg = VALID_IDENTIFIER.test(value)
      ? `Reserved variable name: "${value}" — cannot use __proto__, constructor, or prototype`
      : `Invalid variable name: "${value}" — must match [a-zA-Z_][a-zA-Z0-9_]*`;
    throw new InvalidArgumentError(msg);
  }
  const envValue = process.env[value];
  if (envValue === undefined) {
    throw new InvalidArgumentError(
      `Environment variable "${value}" is not set (use --var ${value}=<value>)`,
    );
  }
  return [...previous, `${value}=${envValue}`];
}

/**
 * Commander argParser for --var-json that validates JSON at parse time.
 *
 * @param value - The raw flag value in key=json format
 * @param previous - Previously accumulated values
 * @returns Updated array with new key=json entry
 * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
 */
export function parseVarJsonOption(value: string, previous: string[]): string[] {
  const eqIndex = value.indexOf('=');
  if (eqIndex === -1) {
    throw new InvalidArgumentError('Expected key=json format');
  }
  const key = value.slice(0, eqIndex);
  if (!isValidVariableName(key)) {
    const msg = VALID_IDENTIFIER.test(key)
      ? `Reserved variable name: "${key}" — cannot use __proto__, constructor, or prototype`
      : `Invalid variable name: "${key}" — must match [a-zA-Z_][a-zA-Z0-9_]*`;
    throw new InvalidArgumentError(msg);
  }
  const jsonStr = value.slice(eqIndex + 1);
  try {
    JSON.parse(jsonStr);
  } catch {
    throw new InvalidArgumentError(`Invalid JSON for "${key}": ${jsonStr}`);
  }
  return [...previous, value];
}
