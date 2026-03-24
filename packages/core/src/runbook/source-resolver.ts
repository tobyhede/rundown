// packages/core/src/runbook/source-resolver.ts

/**
 * Stateless resolver for FOR loop iteration values.
 *
 * Resolves values from the unified variable map based on variable type.
 * For variable-sourced loops, only {@link IterableVarValue} types
 * (JsonArray, JsonArrayStream) are accepted. Range sources are stateless.
 *
 * @module
 */

import { createFileProvider, computeFileSnapshot } from './file-provider.js';

/**
 * Domain error for FOR loop variable resolution failures.
 *
 * Thrown when a variable-sourced FOR loop cannot resolve its iteration value.
 * The `code` discriminant identifies the failure category for structured handling.
 */
export class ForResolutionError extends Error {
  constructor(
    message: string,
    readonly code: 'undefined-variable' | 'type-mismatch' | 'parse-failure',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ForResolutionError';
  }
}
import type {
  ForContext,
  FileSnapshot,
  JsonValue,
  TemplateVarValue,
  JsonArrayStream,
  StreamResolvedForContext,
} from './types.js';
import { isJsonArray, isJsonArrayStream } from './types.js';

/**
 * Discriminated union for the result of resolving a FOR loop iteration value.
 *
 * - `resolved`: The iteration has a value and execution can proceed.
 *   The `context` is guaranteed to have `currentValue` set (not undefined).
 * - `exhausted`: The data source has no more values; `capped` contains
 *    the ForContext with `end` set to the current iteration.
 */
export type ResolvedIteration =
  | {
      readonly kind: 'resolved';
      readonly context: ForContext & { readonly currentValue: JsonValue };
    }
  | { readonly kind: 'exhausted'; readonly capped: ForContext };

/**
 * Resolve the `currentValue` for a FOR loop iteration.
 *
 * This is a stateless, async function that reads the value for the current
 * iteration from the appropriate source. For JsonArrayStream sources it
 * streams lazily and computes a snapshot for resumability.
 *
 * @param fc - The ForContext whose `currentValue` needs resolution
 * @param vars - The unified template variable map for variable source lookups
 * @returns A discriminated result: either the resolved context or an exhaustion signal
 */
export async function resolveForValue(
  fc: ForContext,
  vars?: Readonly<Record<string, TemplateVarValue>>,
): Promise<ResolvedIteration> {
  switch (fc.source.kind) {
    case 'range':
      // Range sources use iteration number as the value
      return {
        kind: 'resolved',
        context: { ...fc, currentValue: String(fc.iteration) },
      };

    case 'variable': {
      // Narrow fc to VariableForContext — TypeScript narrows fc.source but
      // not fc itself in a switch on fc.source.kind.
      const vfc: VariableForContext = fc as VariableForContext;
      const varName = vfc.source.name;
      const value = vars?.[varName];

      if (value === undefined) {
        throw new ForResolutionError(
          `FOR variable "${varName}" is not defined in the template variable map`,
          'undefined-variable',
        );
      }

      if (isJsonArray(value)) {
        return resolveFromJsonArray(vfc, value);
      }

      if (isJsonArrayStream(value)) {
        return resolveFromJsonArrayStream(vfc, value);
      }

      const typeDesc = typeof value === 'object' ? 'JsonObject' : typeof value;
      throw new ForResolutionError(
        `Type error: FOR variable "${varName}" is ${typeDesc}, expected IterableVarValue (JsonArray or JsonArrayStream)`,
        'type-mismatch',
      );
    }
  }
}

/** ForContext narrowed to variable source — used by internal helpers called from the variable branch. */
type VariableForContext = ForContext & {
  readonly source: { readonly kind: 'variable'; readonly name: string };
};

/**
 * Resolve iteration value from an in-memory JsonArray.
 *
 * @param fc - The ForContext whose currentValue needs resolution from the array
 * @param items - The array of JSON values to iterate over
 * @returns A discriminated result: either the resolved context or an exhaustion signal
 */
function resolveFromJsonArray(
  fc: VariableForContext,
  items: readonly JsonValue[],
): ResolvedIteration {
  // Defensive: index access on readonly arrays could theoretically return undefined
  const value = items[fc.iteration - 1];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (value === undefined) {
    return { kind: 'exhausted', capped: { ...fc, end: fc.iteration } };
  }
  return { kind: 'resolved', context: { ...fc, currentValue: value } };
}

/**
 * Resolve iteration value from a file-backed JsonArrayStream (JSONL).
 *
 * @param fc - The ForContext whose currentValue needs resolution from the file stream
 * @param stream - The JsonArrayStream metadata (path and format information)
 * @returns A promise resolving to a discriminated result: either the resolved context (with snapshot) or an exhaustion signal
 */
async function resolveFromJsonArrayStream(
  fc: VariableForContext,
  stream: JsonArrayStream,
): Promise<
  | { readonly kind: 'resolved'; readonly context: StreamResolvedForContext }
  | { readonly kind: 'exhausted'; readonly capped: ForContext }
> {
  const skipLines = fc.iteration - 1;
  const provider = await createFileProvider(stream.path, { skipLines });
  try {
    const { value, done } = await provider.next();
    if (done) {
      return { kind: 'exhausted', capped: { ...fc, end: fc.iteration } };
    }
    // JSONL: parse each line as JSON
    let currentValue: JsonValue;
    try {
      currentValue = JSON.parse(value) as JsonValue;
    } catch (cause) {
      const truncated = value.length > 120 ? `${value.substring(0, 120)}...` : value;
      throw new ForResolutionError(
        `Failed to parse JSONL at ${stream.path} line ${String(fc.iteration)}: ${truncated}`,
        'parse-failure',
        { cause },
      );
    }
    const snapshot: FileSnapshot = await computeFileSnapshot(stream.path, fc.iteration);
    return {
      kind: 'resolved',
      context: {
        ...fc,
        currentValue,
        snapshot,
      },
    };
  } finally {
    provider.close();
  }
}
