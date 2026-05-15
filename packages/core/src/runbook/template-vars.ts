/**
 * Shared boundary between `OutputVars` (context-side, `JsonValue` entries —
 * permits `boolean | null`) and `TemplateVarValue` (state-side — forbids
 * `boolean | null`).
 *
 * Two call sites narrow at the same boundary: the parent-aggregation retry
 * hook and the machine-owned delegation issuance leaf inside the compiler.
 * Centralizing the narrowing keeps the upstream invariant documented in one
 * place and prevents the call sites from drifting onto unsafe casts.
 *
 * @module
 */

import { logger } from '../logger.js';
import type { OutputVars } from './output-evaluator.js';
import type { TemplateVarValue } from './types.js';

/**
 * Narrow `OutputVars` (context-side map, `JsonValue` entries — permits
 * `boolean | null`) to a `TemplateVarValue` map (state-side map — forbids
 * `boolean | null`).
 *
 * The `flattenTemplateVars` pipeline upstream guarantees this narrowing is
 * safe: booleans are stringified at routing time, nulls never enter the
 * template-var channel. This helper documents the invariant at the boundary
 * and filters (with a warning) any rogue values that slip through from
 * untyped callers — preferable to a blanket cast that would let a `null` or
 * `boolean` reach a state-machine consumer unchecked.
 *
 * @param vars - Output-evaluator frame with `JsonValue` entries
 * @returns Map restricted to `TemplateVarValue` — unsafe values dropped
 */
export function asTemplateVars(vars: OutputVars): Readonly<Record<string, TemplateVarValue>> {
  const result: Record<string, TemplateVarValue> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (value === null || typeof value === 'boolean') {
      void logger.warn('asTemplateVars: dropping unsupported value at boundary', {
        name: key,
        kind: value === null ? 'null' : 'boolean',
      });
      continue;
    }
    // string | number | JsonArray | JsonObject — all valid TemplateVarValue
    // subtypes. (TemplateVarValue also permits JsonArrayStream, which cannot
    // appear here: OutputVars is already a flattened output frame.)
    result[key] = value;
  }
  return result;
}
