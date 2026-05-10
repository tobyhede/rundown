// src/runbook/state-update-ops.ts
import type { VariableValue } from './effective-vars.js';
import type { FrameKey } from './targeting.js';
import type { ResolvedCompletion, TemplateVarValue } from './types.js';

/**
 * Shallow-merge the payload into the existing record. Caller-supplied keys
 * overlay existing values; keys not mentioned are preserved.
 */
export interface MergeOp<V> {
  readonly op: 'merge';
  readonly value: Readonly<Record<string, V>>;
}

/**
 * Replace the field wholesale. The value passes through verbatim.
 */
export interface ReplaceOp<V> {
  readonly op: 'replace';
  readonly value: V;
}

/**
 * Construct a {@link MergeOp} that shallow-merges the given map into the
 * existing field. Use at call sites where the new entries should add to or
 * overlay existing keys without wiping the rest.
 *
 * @template V - Value type of the record entries
 * @param value - Partial record whose entries are merged onto the existing field
 * @returns Tagged merge operation consumed by {@link RunbookStateManager.update}
 */
export function merge<V>(value: Readonly<Record<string, V>>): MergeOp<V> {
  return { op: 'merge', value };
}

/**
 * Construct a {@link ReplaceOp} that wholesale-replaces the field. Use at call
 * sites where the caller owns the full set, e.g. mirroring an XState context
 * that is the source of truth for the field.
 *
 * @template V - Type of the value being replaced
 * @param value - The full replacement value
 * @returns Tagged replace operation consumed by {@link RunbookStateManager.update}
 */
export function replace<V>(value: V): ReplaceOp<V> {
  return { op: 'replace', value };
}

/**
 * Op shape accepted for `RunbookState.variables`. Merge-only because the
 * actor reducer always emits the full live OUTPUTS map; merging it onto the
 * persisted view is idempotent and the only correct semantic.
 *
 * Values may be `string` (OUTPUTS evaluation), `ArtifactRecord` (exact
 * `ARTIFACT - Name "key"`), or `readonly ArtifactRecord[]` (wildcard
 * `ARTIFACT - Name "*.json"`). Last-write-wins on key collisions: if an
 * OUTPUTS step emits a name matching a previously-resolved ARTIFACT (or
 * vice versa) the shallow-merge in {@link applyOp} silently replaces the
 * prior value. This is the intended semantic under the unified-vars model.
 */
export type VariablesOp = MergeOp<VariableValue>;

/**
 * Op shape accepted for `RunbookState.templateVars`. Replace-only because
 * template inputs are seeded once at run creation and only re-written
 * wholesale (e.g. by delegation snapshot writes carrying the full inherited
 * map). There is no partial-patch call site.
 */
export type TemplateVarsOp = ReplaceOp<Readonly<Record<string, TemplateVarValue>>>;

/**
 * Op shape accepted for `RunbookState.resolvedCompletions`. `recordCompletion`
 * adds one entry (merge); `consumeResolvedCompletion` removes a key, which is
 * a wholesale replace at the field level.
 */
export type ResolvedCompletionsOp =
  | MergeOp<ResolvedCompletion>
  | ReplaceOp<Readonly<Record<string, ResolvedCompletion>>>;

/**
 * Op shape accepted for `RunbookState.frameEntries`. Replace-only — the only
 * caller (`ensureActiveEntry`) constructs the full updated map externally
 * before passing it through.
 */
export type FrameEntriesOp = ReplaceOp<Readonly<Record<FrameKey, number>>>;

/**
 * Internal dispatcher: apply a {@link MergeOp} or {@link ReplaceOp} against an
 * existing record-shaped field value. Returns the new field value.
 *
 * The exhaustive `op.op` check guards both constructor tags. A mutant that
 * silently changes either `'merge'` or `'replace'` would route through the
 * unknown-tag branch and trip the throw at runtime, surfacing in tests.
 *
 * @template V - Value type of the record entries
 * @param existing - The currently-persisted field value (may be undefined)
 * @param op - The tagged operation
 * @returns The post-op record value
 * @throws {Error} If `op.op` is neither `'merge'` nor `'replace'` (impossible
 *   through the public API; load-bearing for mutation testing)
 */
export function applyOp<V>(
  existing: Readonly<Record<string, V>> | undefined,
  op: MergeOp<V> | ReplaceOp<Readonly<Record<string, V>>>,
): Readonly<Record<string, V>> {
  switch (op.op) {
    case 'merge':
      return { ...(existing ?? {}), ...op.value };
    case 'replace':
      return op.value;
    default:
      // Defensive: the public type forbids this branch, but it remains
      // load-bearing under mutation testing (kills equivalent-tag mutants
      // on the constructors).
      throw new Error(`applyOp: unknown op tag "${(op as { readonly op: string }).op}"`);
  }
}
