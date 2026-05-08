import type { OutputValue } from './output-evaluator.js';
import type { ArtifactVarValue, TemplateVarValue } from './types.js';

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

declare const artifactVarsBrand: unique symbol;

/**
 * Persisted ARTIFACTS variable accumulator.
 *
 * Carries exact `ArtifactRecord` values and wildcard `ArtifactRecord[]` values
 * separately from string-only step OUTPUTS.
 */
export type ArtifactVars = Readonly<Record<string, ArtifactVarValue>> & {
  readonly [artifactVarsBrand]: true;
};

/**
 * Sole producer of {@link ArtifactVars}.
 *
 * Apply at the two seams where artifact variables enter {@link RunbookState}:
 *   1. The Zod parse seam in {@link makeRunbookStateSchema} when state is
 *      loaded from disk.
 *   2. {@link RunbookStateManager.update} when the resolver or actor mirror
 *      writes the field through `merge(...)` / `replace(...)`.
 *
 * Identity-preserving — the brand is type-only. Mirrors the seam-application
 * pattern of {@link brandInitialTemplateVars} and {@link brandStoredOutputs}.
 *
 * @param vars - Plain artifact variable map
 * @returns The same object, branded
 */
export function brandArtifactVars(vars: Readonly<Record<string, ArtifactVarValue>>): ArtifactVars {
  return vars as ArtifactVars;
}

/**
 * Fully-merged effective variable space at a moment in execution.
 *
 * Layered, lowest precedence first:
 *   1. `state.templateVars` — CLI-seeded inputs / built-ins / frontmatter
 *   2. `state.artifactVars` — accumulated ARTIFACTS declarations
 *   3. `state.variables`   — accumulated step OUTPUTS
 *   4. caller-supplied `extraVars` — delegation-side overrides (e.g. --input)
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
 *   2. `state.artifactVars`  (mid) — accumulated ARTIFACTS declarations
 *   3. `state.variables`     (mid) — accumulated step OUTPUTS
 *   4. `extraVars`           (top) — caller-supplied overrides (typically --input
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
 * @param state - Runbook-state subset providing the persisted variable sources
 * @param state.templateVars - Seeded template variables (built-ins, frontmatter inputs, CLI overrides)
 * @param state.artifactVars - Accumulated ARTIFACTS variables
 * @param state.variables - Accumulated step OUTPUTS already rendered to strings
 * @param extraVars - Optional caller-supplied variables overlaid on top
 * @returns Branded effective variable space
 */
export function mergeEffectiveVars<V extends TemplateVarValue = TemplateVarValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly artifactVars?: Readonly<Record<string, ArtifactVarValue>>;
    readonly variables?: Readonly<Record<string, string>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V | ArtifactVarValue>;

export function mergeEffectiveVars<V extends OutputValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly variables?: Readonly<Record<string, string>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V>;

export function mergeEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly artifactVars?: Readonly<Record<string, ArtifactVarValue>>;
    readonly variables?: Readonly<Record<string, string>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V | ArtifactVarValue> {
  return {
    ...(state.templateVars ?? {}),
    ...(state.artifactVars ?? {}),
    ...(state.variables ?? {}),
    ...(extraVars ?? {}),
  } as EffectiveVars<V | ArtifactVarValue>;
}

/**
 * Module-private nominal brand applied to {@link RunbookState.templateVars}.
 *
 * Distinguishes seeded template inputs (CLI flags / built-ins / frontmatter)
 * from accumulated step OUTPUTS ({@link StoredOutputs}). The two are
 * structurally similar (both are `Record<string, …>`) but semantically
 * distinct — one is immutable after init, the other is mutated as steps
 * complete. Without this brand a function that legitimately accepts only
 * the seeded inputs (e.g. {@link import('./source-resolver.js').resolveForValue})
 * would silently accept `state.variables` as well, repeating the bug class
 * fixed in commit `19067f6f`.
 *
 * Declared with `declare const` + `unique symbol` so the brand is purely
 * type-level (zero runtime cost) and can only be produced inside this
 * module via {@link brandInitialTemplateVars}. The symbol key does not
 * participate in any `Record<string, …>` index signature, so branded values
 * remain fully assignable to plain `Readonly<Record<string, TemplateVarValue>>`
 * at read sites.
 */
declare const initialTemplateVarsBrand: unique symbol;

/**
 * Seeded template-variable space at runbook init.
 *
 * Carries CLI inputs, frontmatter `inputs:`, and built-ins (`Date`,
 * `Branch`, `WorkPath`, `RunId`, etc.). Frozen for the lifetime of the
 * run — never mutated by step execution. Use {@link StoredOutputs} for
 * the mutable accumulator of step OUTPUTS.
 */
export type InitialTemplateVars = Readonly<Record<string, TemplateVarValue>> & {
  readonly [initialTemplateVarsBrand]: true;
};

/**
 * Sole producer of {@link InitialTemplateVars}.
 *
 * Apply at the two seams where seeded variables enter {@link RunbookState}:
 *   1. The Zod parse seam in {@link makeRunbookStateSchema} when state is
 *      loaded from disk.
 *   2. {@link RunbookStateManager.create} when a new run is initialised
 *      in-memory.
 *
 * Identity-preserving — the brand is type-only.
 *
 * @param vars - Plain seeded-template-variable record
 * @returns The same object, branded.
 */
export function brandInitialTemplateVars(
  vars: Readonly<Record<string, TemplateVarValue>>,
): InitialTemplateVars {
  return vars as InitialTemplateVars;
}

/**
 * Module-private nominal brand applied to {@link RunbookState.variables}.
 *
 * Distinguishes the mutable accumulator of step OUTPUTS from the seeded
 * input space ({@link InitialTemplateVars}). All values are strings —
 * OUTPUTS are stringified before persistence by `evaluateStepOutputDeclarations`
 * in `output-evaluator.ts`, so the value type is `Record<string, string>`
 * rather than `Record<string, TemplateVarValue>`.
 *
 * Without this brand a function that legitimately accepts only stored
 * OUTPUTS (e.g. a future serializer) would silently accept any
 * `Record<string, string>` — including a partial spread of the seeded
 * inputs that happen to be string-typed.
 */
declare const storedOutputsBrand: unique symbol;

/**
 * Mutable step-OUTPUTS accumulator persisted in {@link RunbookState.variables}.
 *
 * Each entry is a stringified value emitted by an `OUTPUTS` directive that
 * has resolved via `evaluateStepOutputDeclarations`. Keys may collide with
 * {@link InitialTemplateVars} entries; the merge in {@link mergeEffectiveVars}
 * gives outputs precedence over template inputs.
 */
export type StoredOutputs = Readonly<Record<string, string>> & {
  readonly [storedOutputsBrand]: true;
};

/**
 * Sole producer of {@link StoredOutputs}.
 *
 * Apply at the two seams where step OUTPUTS land in {@link RunbookState}:
 *   1. The Zod parse seam in {@link makeRunbookStateSchema} when state is
 *      loaded from disk.
 *   2. {@link RunbookStateManager.create} / {@link RunbookStateManager.update}
 *      when XState reducer output is persisted.
 *
 * Identity-preserving — the brand is type-only.
 *
 * @param vars - Plain stringified-OUTPUTS record
 * @returns The same object, branded.
 */
export function brandStoredOutputs(vars: Readonly<Record<string, string>>): StoredOutputs {
  return vars as StoredOutputs;
}

/**
 * Sole producer of an {@link EffectiveVars} brand applied to data that has
 * already been merged elsewhere — typically the Zod parse seam for
 * {@link ContextSnapshot.vars}, which stores a pre-merged effective view
 * on disk.
 *
 * Complements {@link mergeEffectiveVars} (which merges AND brands). Use this
 * only at boundaries where the merge has already occurred: the value was
 * produced by {@link mergeEffectiveVars} in an earlier process run and is
 * now re-entering from disk. Applying it in {@link makeContextSnapshotSchema}
 * ensures the parse seam re-mints the brand on every state load, mirroring
 * how {@link brandInitialTemplateVars} / {@link brandStoredOutputs} are
 * applied to the top-level {@link RunbookState} fields.
 *
 * Identity-preserving — the brand is type-only.
 *
 * @template V - Value type of the merged record (inferred)
 * @param vars - Plain merged-record shape
 * @returns The same object, branded.
 */
export function brandEffectiveVars(
  vars: Readonly<Record<string, TemplateVarValue | ArtifactVarValue>>,
): EffectiveVars<TemplateVarValue | ArtifactVarValue>;

export function brandEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  vars: Readonly<Record<string, V>>,
): EffectiveVars<V>;

export function brandEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  vars: Readonly<Record<string, V>>,
): EffectiveVars<V> {
  return vars as EffectiveVars<V>;
}
