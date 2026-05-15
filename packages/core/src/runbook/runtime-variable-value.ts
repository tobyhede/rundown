import type { VariableValue } from './effective-vars.js';
import { isJsonValue } from './types.js';

/**
 * Parse a captured runtime variable string into the richest representable
 * {@link VariableValue}.
 *
 * OUTPUT channel files are textual, but their contents may be JSON produced
 * by agents. Arrays, objects, numbers, and quoted strings are preserved as
 * typed runtime values. Top-level booleans and null remain strings because
 * the public template variable model does not admit those as top-level
 * values; they remain valid inside arrays and objects.
 *
 * @param raw - Trimmed UTF-8 value read from an OUTPUTS channel or expression
 * @returns Typed runtime variable value
 */
export function parseRuntimeVariableValue(raw: string): VariableValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (typeof parsed === 'string') {
    return parsed;
  }

  if (typeof parsed === 'number' && Number.isFinite(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed) && parsed.every(isJsonValue)) {
    return parsed;
  }

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    isJsonValue(parsed)
  ) {
    return parsed;
  }

  return raw;
}
