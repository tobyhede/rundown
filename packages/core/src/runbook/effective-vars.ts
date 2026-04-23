import type { OutputValue } from './output-evaluator.js';
import type { TemplateVarValue } from './types.js';

/**
 * Module-private nominal brand applied to the output of {@link mergeEffectiveVars}.
 *
 * Declared with `declare const` + `unique symbol` so the brand is purely
 * type-level (zero runtime cost) and can only be produced inside this module.
 * The symbol key does not participate in the `Record<string, …>` index
 * signature (only string keys do), so branded values remain fully assignable
 * to plain `Record<string, TemplateVarValue>` (and `Record<string, OutputValue>`
 * for the {@link OutputValue}-typed instantiation) at read sites.
 */
declare const effectiveVarsBrand: unique symbol;

/**
 * Fully-merged effective variable space at a moment in execution.
 *
 * Layered, lowest precedence first:
 *   1. `state.templateVars` — CLI-seeded inputs / built-ins / frontmatter
 *   2. `state.variables`   — accumulated step OUTPUTS
 *   3. caller-supplied `extraVars` — delegation-side overrides (e.g. --input)
 *
 * Used wherever delegation snapshots, OUTPUTS frames, or template renderers need
 * "the variables a child or expression should see right now". By accepting only
 * `EffectiveVars` (and not the underlying `Record<string, …>`), consumer
 * signatures force callers to produce the merge through {@link mergeEffectiveVars}.
 *
 * **The brand is the contract.** Hand-rolled objects, plain spreads of state
 * fields, or partial subsets cannot satisfy this type. If the merge rule
 * changes (e.g. a new variable source is added), updating
 * {@link mergeEffectiveVars} automatically propagates to every consumer.
 *
 * Generic over the value type so the producer can serve both:
 *   - delegation snapshots, which carry full {@link TemplateVarValue} entries
 *     (including `JsonArrayStream` refs); and
 *   - OUTPUTS execution frames, whose `templateVars` are already flattened to
 *     {@link OutputValue} (`JsonValue` — no `JsonArrayStream`).
 *
 * Both instantiations share the same brand symbol, so the contract is uniform
 * across consumers.
 *
 * @template V - Value type of the merged record. Defaults to {@link TemplateVarValue}.
 */
export type EffectiveVars<V = TemplateVarValue> = Readonly<Record<string, V>> & {
  readonly [effectiveVarsBrand]: true;
};

/**
 * Sole producer of {@link EffectiveVars}.
 *
 * Merges the variable sources in precedence order:
 *   1. `state.templateVars` (low) — CLI-seeded inputs / built-ins / frontmatter
 *   2. `state.variables`     (mid) — accumulated step OUTPUTS
 *   3. `extraVars`           (top) — caller-supplied overrides (typically --input
 *                                     flags routed through delegation/run commands)
 *
 * Mirrors the precedence used by `buildExecutionFrame` for OUTPUTS evaluation
 * and template rendering, ensuring delegation snapshots see the same effective
 * variable space the running parent does.
 *
 * Generic over the value type so a single producer serves both delegation
 * snapshots ({@link TemplateVarValue}) and OUTPUTS frames ({@link OutputValue}).
 * `state.variables` is typed as `Record<string, string>` because stored OUTPUTS
 * are always rendered to strings before persistence; `string` is assignable to
 * both `TemplateVarValue` and `OutputValue`, so the field shape is uniform.
 *
 * @template V - Value type of the merged record (inferred from arguments)
 * @param state - Runbook-state subset providing the two persisted variable sources
 * @param state.templateVars - Seeded template variables (built-ins, frontmatter inputs, CLI overrides)
 * @param state.variables - Accumulated step OUTPUTS already rendered to strings
 * @param extraVars - Optional caller-supplied variables overlaid on top
 * @returns Branded effective variable space
 */
export function mergeEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly variables?: Readonly<Record<string, string>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V> {
  return {
    ...(state.templateVars ?? {}),
    ...(state.variables ?? {}),
    ...(extraVars ?? {}),
  } as EffectiveVars<V>;
}
