// packages/core/src/runbook/source-resolver.ts

/**
 * Stateless resolver for FOR loop iteration values.
 *
 * Unifies value resolution across all source types (range, array, file)
 * so the XState machine and CLI share a single code path.
 *
 * @module
 */

import { createFileProvider, computeFileSnapshot } from './file-provider.js';
import type { ForContext, FileSnapshot, JsonValue } from './types.js';

/**
 * Discriminated union for the result of resolving a FOR loop iteration value.
 *
 * - `resolved`: The iteration has a value and execution can proceed.
 * - `exhausted`: The data source has no more values; `capped` contains
 *    the ForContext with `end` set to the current iteration.
 */
export type ResolvedIteration =
  | { readonly kind: 'resolved'; readonly context: ForContext }
  | { readonly kind: 'exhausted'; readonly capped: ForContext };

/**
 * Resolve the `currentValue` for a FOR loop iteration.
 *
 * This is a stateless, async function that reads the value for the current
 * iteration from the appropriate source. For file sources it streams lazily
 * and computes a snapshot for resumability.
 *
 * @param fc - The ForContext whose `currentValue` needs resolution
 * @returns A discriminated result: either the resolved context or an exhaustion signal
 */
export async function resolveForValue(fc: ForContext): Promise<ResolvedIteration> {
  switch (fc.source.kind) {
    case 'range':
      // Range sources use iteration number as the value
      return {
        kind: 'resolved',
        context: { ...fc, currentValue: String(fc.iteration) },
      };

    case 'array': {
      // Array sources index into items (1-based); out-of-bounds returns undefined
      const value = fc.source.items[fc.iteration - 1];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (value === undefined) {
        return { kind: 'exhausted', capped: { ...fc, end: fc.iteration } };
      }
      return { kind: 'resolved', context: { ...fc, currentValue: value } };
    }

    case 'file': {
      // File sources read lazily via streaming FileProvider
      const skipLines = fc.iteration - 1;
      const provider = await createFileProvider(fc.source.path, fc.source.format, { skipLines });
      try {
        const { value, done } = await provider.next();
        if (done) {
          return { kind: 'exhausted', capped: { ...fc, end: fc.iteration } };
        }
        // Parse value based on format
        let currentValue: JsonValue = value;
        if (fc.source.format === 'jsonl') {
          try {
            currentValue = JSON.parse(value) as JsonValue;
          } catch (cause) {
            const truncated = value.length > 120 ? `${value.substring(0, 120)}...` : value;
            throw new Error(
              `Failed to parse JSONL at ${fc.source.path} line ${String(fc.iteration)}: ${truncated}`,
              { cause },
            );
          }
        }
        const snapshot: FileSnapshot = await computeFileSnapshot(fc.source.path, fc.iteration);
        return {
          kind: 'resolved',
          context: {
            ...fc,
            currentValue,
            source: { ...fc.source, snapshot },
          },
        };
      } finally {
        provider.close();
      }
    }
  }
}
