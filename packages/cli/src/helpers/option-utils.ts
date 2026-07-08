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

/** Channel label + env-inherit policy for the shared var-flag parsers. */
interface VarFlagParseOptions {
  /** Error noun used in diagnostics ("variable" or "artifact"). */
  readonly label: 'variable' | 'artifact';
  /** When false, the no-`=` env-inherit form is rejected. */
  readonly allowEnvInherit: boolean;
  /**
   * Value shape shown in the bare-`KEY` rejection when env-inherit is disabled.
   * Keeps the diagnostic channel-specific (e.g. `<rd:// uri>` for artifacts)
   * without hardcoding one channel's wording into this generic parser. Defaults
   * to `<value>`.
   */
  readonly valueHint?: string;
}

/**
 * Reject a variable/artifact name shaped like a CLI flag (leading `-`).
 *
 * A flag-shaped name — `--claim-id`, `--run`, `--step`, … — is never a
 * legitimate variable or artifact name; it can only arise when a CLI flag token
 * lands in a `key=value` slot. That is precisely the option-injection shape a
 * subprocess front end would use to smuggle authority (`--claim-id`) or a target
 * selector through an artifact/input value slot, so reject it explicitly with a
 * security-clear message rather than letting the generic identifier check
 * swallow it. The subprocess mutation boundary (`subprocess-mutation-boundary`)
 * is the primary defence against that smuggle; this is defence in depth at the
 * value-parsing seam and applies to every channel that shares this parser.
 *
 * @param key - Candidate variable/artifact name (the part before `=`).
 * @param label - Channel label ("variable" or "artifact") for diagnostics.
 * @throws {InvalidArgumentError} When the name is shaped like a CLI flag.
 */
function rejectFlagShapedName(key: string, label: 'variable' | 'artifact'): void {
  if (key.startsWith('-')) {
    throw new InvalidArgumentError(
      `Invalid ${label} name: "${key}" — names must not be CLI flags or internal identifiers ` +
        `(a flag such as --claim-id sitting in a value slot is an injection attempt).`,
    );
  }
}

/**
 * Shared `key=value` flag parser for the variable and artifact channels.
 *
 * @param value - Raw flag value (`key=value` or, when allowed, a bare `KEY`)
 * @param previous - Previously accumulated entries
 * @param opts - Channel label and env-inherit policy
 * @returns Updated array with the new `key=value` entry
 * @throws {InvalidArgumentError} On invalid identifier, a flag-shaped name, or a bare `KEY` when env-inherit is disabled
 */
function parseVarFlagOption(
  value: string,
  previous: string[],
  opts: VarFlagParseOptions,
): string[] {
  const eqIndex = value.indexOf('=');
  if (eqIndex !== -1) {
    rejectFlagShapedName(value.slice(0, eqIndex), opts.label);
    const parsed = parseVarFlag(value);
    if (!parsed) {
      const key = value.slice(0, eqIndex);
      const msg = VALID_IDENTIFIER.test(key)
        ? `Reserved ${opts.label} name: "${key}" — cannot use __proto__, constructor, or prototype`
        : `Invalid ${opts.label}: "${value}" — key must match [a-zA-Z_][a-zA-Z0-9_]*`;
      throw new InvalidArgumentError(msg);
    }
    return [...previous, value];
  }
  if (!opts.allowEnvInherit) {
    throw new InvalidArgumentError(
      `Invalid ${opts.label}: "${value}" — the ${opts.label} channel requires KEY=${opts.valueHint ?? '<value>'}`,
    );
  }
  rejectFlagShapedName(value, opts.label);
  if (!isValidVariableName(value)) {
    const msg = VALID_IDENTIFIER.test(value)
      ? `Reserved ${opts.label} name: "${value}" — cannot use __proto__, constructor, or prototype`
      : `Invalid ${opts.label} name: "${value}" — must match [a-zA-Z_][a-zA-Z0-9_]*`;
    throw new InvalidArgumentError(msg);
  }
  const envValue = process.env[value];
  if (envValue === undefined) {
    throw new InvalidArgumentError(
      `Environment variable "${value}" is not set (use --input ${value}=<value>)`,
    );
  }
  return [...previous, `${value}=${envValue}`];
}

/**
 * Shared `key=json` flag parser for the variable and artifact channels.
 *
 * @param value - Raw flag value in `key=json` format
 * @param previous - Previously accumulated entries
 * @param label - Channel label ("variable" or "artifact") used in diagnostics
 * @returns Updated array with the new `key=json` entry
 * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
 */
function parseVarJsonOption(
  value: string,
  previous: string[],
  label: 'variable' | 'artifact',
): string[] {
  const eqIndex = value.indexOf('=');
  if (eqIndex === -1) {
    throw new InvalidArgumentError('Expected key=json format');
  }
  const key = value.slice(0, eqIndex);
  rejectFlagShapedName(key, label);
  if (!isValidVariableName(key)) {
    const msg = VALID_IDENTIFIER.test(key)
      ? `Reserved ${label} name: "${key}" — cannot use __proto__, constructor, or prototype`
      : `Invalid ${label} name: "${key}" — must match [a-zA-Z_][a-zA-Z0-9_]*`;
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

/**
 * Commander argParser for `--input` (env-inherit allowed).
 *
 * Supports two forms:
 * - `key=value`: validates identifier and accumulates
 * - `KEY` (no =): inherits value from process.env[KEY]
 *
 * @param value - Raw `key=value` or bare `KEY` (env-inherit) flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new entry
 * @throws {InvalidArgumentError} On invalid identifier or unset inherited env var
 * @see parseVarFlagOption
 */
export function parseInputOption(value: string, previous: string[]): string[] {
  return parseVarFlagOption(value, previous, { label: 'variable', allowEnvInherit: true });
}

/**
 * Commander argParser for `--artifacts` (env-inherit disabled).
 *
 * Values must be `key=<rd:// uri>`. The no-`=` env-inherit form is rejected:
 * the artifact channel never inherits an env value (the `RD_ARTIFACT_*` bridge
 * is deferred). Shape validation only — core resolves and rehydrates `rd://`.
 *
 * @param value - Raw `key=<rd:// uri>` flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new entry
 * @throws {InvalidArgumentError} On invalid identifier or a bare `KEY` (env-inherit is rejected for artifacts)
 * @see parseVarFlagOption
 */
export function parseArtifactOption(value: string, previous: string[]): string[] {
  return parseVarFlagOption(value, previous, {
    label: 'artifact',
    allowEnvInherit: false,
    valueHint: '<rd:// uri>',
  });
}

/**
 * Commander argParser for `--input-json` that validates JSON at parse time.
 *
 * @param value - Raw `key=json` flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new `key=json` entry
 * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
 * @see parseVarJsonOption
 */
export function parseInputJsonOption(value: string, previous: string[]): string[] {
  return parseVarJsonOption(value, previous, 'variable');
}

/**
 * Commander argParser for `--artifacts-json` that validates JSON at parse time.
 *
 * The JSON should be an array of `rd://` URIs; core validates and rehydrates.
 *
 * @param value - Raw `key=json` flag value
 * @param previous - Previously accumulated entries
 * @returns Updated array including the new `key=json` entry
 * @throws {InvalidArgumentError} When key is invalid, format wrong, or JSON invalid
 * @see parseVarJsonOption
 */
export function parseArtifactJsonOption(value: string, previous: string[]): string[] {
  return parseVarJsonOption(value, previous, 'artifact');
}
