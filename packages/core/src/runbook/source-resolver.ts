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

import * as path from 'node:path';
import { createFileProvider, computeFileSnapshot } from './file-provider.js';
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
 * Domain error for FOR loop variable resolution failures.
 *
 * Thrown when a variable-sourced FOR loop cannot resolve its iteration value.
 * The `code` discriminant identifies the failure category for structured handling.
 */
export class ForResolutionError extends Error {
  /**
   * Create a ForResolutionError with a failure category code.
   *
   * @param message - Human-readable description of the resolution failure
   * @param code - Discriminant identifying the failure category
   * @param options - Standard Error options (e.g. cause)
   */
  constructor(
    message: string,
    readonly code: 'undefined-variable' | 'type-mismatch' | 'parse-failure' | 'policy-violation',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ForResolutionError';
  }
}

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
      /** Total item count for finite sources (JsonArray). Undefined for streams. */
      readonly total?: number;
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
 * @param projectRoot - When provided, JsonArrayStream paths are checked to be within this directory
 * @returns A discriminated result: either the resolved context or an exhaustion signal
 * @throws {ForResolutionError} with code `'undefined-variable'` when the FOR variable is not in the template var map
 * @throws {ForResolutionError} with code `'type-mismatch'` when the FOR variable is not an iterable type
 * @throws {ForResolutionError} with code `'parse-failure'` when a JSONL line cannot be parsed as JSON
 * @throws {ForResolutionError} with code `'policy-violation'` if a stream path escapes `projectRoot`
 */
export async function resolveForValue(
  fc: ForContext,
  vars?: Readonly<Record<string, TemplateVarValue>>,
  projectRoot?: string,
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
        return resolveFromJsonArrayStream(vfc, value, projectRoot);
      }

      const typeDesc = typeof value === 'object' ? 'JsonObject' : typeof value;
      throw new ForResolutionError(
        `Type error: FOR variable "${varName}" is ${typeDesc}, expected IterableVarValue (JsonArray or JsonArrayStream)`,
        'type-mismatch',
      );
    }
  }
}

/**
 * ForContext narrowed to variable source.
 *
 * Used by internal helpers called from the `case 'variable':` branch of
 * {@link resolveForValue}, where TypeScript has narrowed `fc.source.kind`
 * but not `fc` itself.
 */
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
  return { kind: 'resolved', context: { ...fc, currentValue: value }, total: items.length };
}

/**
 * Resolve iteration value from a file-backed JsonArrayStream (JSONL).
 *
 * @param fc - The ForContext whose currentValue needs resolution from the file stream
 * @param stream - The JsonArrayStream metadata (path and format information)
 * @param projectRoot - When provided, the stream path must be within this directory
 * @returns A promise resolving to a discriminated result: either the resolved context (with snapshot) or an exhaustion signal
 * @throws {ForResolutionError} with code `'policy-violation'` if stream path escapes projectRoot
 */
async function resolveFromJsonArrayStream(
  fc: VariableForContext,
  stream: JsonArrayStream,
  projectRoot?: string,
): Promise<
  | { readonly kind: 'resolved'; readonly context: StreamResolvedForContext }
  | { readonly kind: 'exhausted'; readonly capped: ForContext }
> {
  if (projectRoot !== undefined) {
    const rel = path.relative(projectRoot, stream.path);
    // path.isAbsolute(rel) is a Windows safety net: on different drives,
    // path.relative() returns an absolute path rather than a dotdot sequence.
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ForResolutionError(
        `JsonArrayStream path "${stream.path}" escapes project root "${projectRoot}"`,
        'policy-violation',
      );
    }
  }
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
