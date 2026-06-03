import type { ArtifactRecord } from './artifact-schema.js';
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
 *   2. `state.variables`   — accumulated step OUTPUTS and ARTIFACT resolutions
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
 *   2. `state.variables`     (mid) — accumulated step OUTPUTS and ARTIFACT
 *                                     resolutions
 *   3. `extraVars`           (top) — caller-supplied overrides (typically --input
 *                                     flags routed through delegation/run commands)
 *
 * Mirrors the precedence used by `buildExecutionFrame` for OUTPUTS evaluation
 * and template rendering, ensuring delegation snapshots see the same effective
 * variable space the running parent does.
 *
 * Generic over the value type so a single producer serves both delegation
 * snapshots ({@link TemplateVarValue}) and OUTPUTS frames ({@link OutputValue}).
 *
 * @template V - Value type of the merged record (inferred from arguments)
 * @param state - Runbook-state subset providing the persisted variable sources
 * @param state.templateVars - Seeded template variables (built-ins, frontmatter inputs, CLI overrides)
 * @param state.variables - Accumulated step OUTPUTS and ARTIFACT resolutions
 * @param extraVars - Optional caller-supplied variables overlaid on top
 * @returns Branded effective variable space
 */
export function mergeEffectiveVars<V extends TemplateVarValue = TemplateVarValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly variables?: Readonly<Record<string, VariableValue>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V>;

export function mergeEffectiveVars<V extends OutputValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly variables?: Readonly<Record<string, VariableValue>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V>;

export function mergeEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  state: {
    readonly templateVars?: Readonly<Record<string, V>>;
    readonly variables?: Readonly<Record<string, VariableValue>>;
  },
  extraVars?: Readonly<Record<string, V>>,
): EffectiveVars<V> {
  return {
    ...(state.templateVars ?? {}),
    ...(state.variables ?? {}),
    ...(extraVars ?? {}),
  } as EffectiveVars<V>;
}

/**
 * Module-private nominal brand applied to {@link RunbookState.templateVars}.
 *
 * Distinguishes seeded template inputs (CLI flags / built-ins / frontmatter)
 * from accumulated step OUTPUTS ({@link StoredOutputs}). The two are
 * structurally similar (both are `Record<string, …>`) but semantically
 * distinct — one is immutable after init, the other is mutated as steps
 * complete.
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
 * Distinguishes the mutable accumulator from the seeded, immutable
 * {@link InitialTemplateVars} seed. The accumulator carries
 * {@link VariableValue} entries — strings, numbers, JSON objects, JSON
 * arrays, `JsonArrayStream` references, or trusted artifact values. The two
 * spaces are structurally similar (both are `Record<string, …>`) but
 * semantically distinct — one is mutated as steps complete, the other is
 * frozen for the lifetime of the run.
 *
 * Without this brand a function that legitimately accepts only the
 * mutable accumulator (e.g. a future serializer) would silently accept
 * any `Record<string, VariableValue>` — including a partial spread
 * of the seeded inputs whose values happen to match the union shape.
 */
declare const storedOutputsBrand: unique symbol;

/**
 * One value persisted in {@link RunbookState.variables} or carried by a
 * runtime frame.
 *
 * The artifact arm declares {@link TrustedArtifactValue} — values intended to
 * have passed through a sanctioned producer. Structural typing means
 * unbranded `ArtifactRecord` values are still assignable here (see the
 * codebase precedent at `packages/core/src/runbook/types.ts:304-308`); the
 * declaration is documentational. The runtime brand check at
 * `partitionVariables` is the enforcing boundary, and direct
 * `as TrustedArtifactValue` casts outside sanctioned producers are blocked
 * by the ESLint `no-restricted-syntax` rule.
 *
 * @see RoutedVariableValue - wider shape used after routing but before
 *   partitioning has verified provenance.
 */
export type VariableValue = TemplateVarValue | TrustedArtifactValue;

/**
 * Variable-value shape produced by `routeVariable` and consumed by
 * `partitionVariables` — the **post-routing, pre-partitioning** position in
 * the pipeline.
 *
 * By the time a value reaches this type it has already been shape-routed,
 * JSON-parsed, and manifest-rehydrated where possible; rehydrated entries
 * carry the trust brand minted by the sanctioned producers. What hasn't
 * happened yet is provenance enforcement: values supplied as raw artifact
 * JSON via `--input-json`, `--input-file`, `RD_INPUT_*` env vars, or
 * inherited maps that bypassed the `ContextSnapshot` parse seam may still
 * be present here without the brand. The artifact arm therefore admits
 * both `PublicArtifactValue` (unverified shape) and `TrustedArtifactValue`
 * (brand-bearing).
 *
 * `partitionVariables` is the seam that converts `Record<string, RoutedVariableValue>`
 * -> `Record<string, VariableValue>` by:
 *
 * 1. Accepting values whose artifact arm carries the runtime brand
 *    ({@link isTrustedArtifactValue}); these flow into `runtimeVars`.
 * 2. Throwing for unbranded artifact-shaped values
 *    (`isArtifactValueShape`-true, brand-absent); a forged record
 *    must never cross the trust boundary into `VariableValue` storage.
 * 3. Routing everything else through `TemplateVarValueSchema.parse` into
 *    `templateVars`.
 *
 * The split keeps function signatures honest at review time: storage sites
 * declare `VariableValue` (trust declared by alias, enforced at the runtime
 * partition seam), post-routing sites declare `RoutedVariableValue` (forged
 * shapes representable, rejected at partition time by the runtime brand check).
 * The forged-input case is representable at this seam — that's the whole
 * point of having a dedicated post-routing type.
 */
export type RoutedVariableValue = TemplateVarValue | PublicArtifactValue | TrustedArtifactValue;

/**
 * Mutable step-OUTPUTS accumulator persisted in {@link RunbookState.variables}.
 *
 * Each entry may be a string, number, JSON object, JSON array,
 * `JsonArrayStream`, or a trusted artifact value.
 * Keys may collide with {@link InitialTemplateVars} entries; the merge in
 * {@link mergeEffectiveVars} gives runtime variables precedence over template
 * inputs.
 */
export type StoredOutputs = Readonly<Record<string, VariableValue>> & {
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
 * @param vars - Plain mutable-accumulator record. Values are strings,
 *   numbers, JSON objects, JSON arrays, `JsonArrayStream`, or trusted
 *   artifact values.
 * @returns The same object, branded.
 */
export function brandStoredOutputs(vars: Readonly<Record<string, VariableValue>>): StoredOutputs {
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
export function brandEffectiveVars<V extends TemplateVarValue | OutputValue = TemplateVarValue>(
  vars: Readonly<Record<string, V>>,
): EffectiveVars<V> {
  return vars as EffectiveVars<V>;
}

/**
 * Module-private runtime brand symbol for trusted artifact values.
 *
 * **Divergence from the other brands in this module.**
 * `initialTemplateVarsBrand` / `storedOutputsBrand` / `effectiveVarsBrand`
 * above are declared with `declare const ... unique symbol` and applied with
 * identity-preserving casts. They are purely type-level (zero runtime cost)
 * and are never runtime-checked — no code branches on whether a value carries
 * them. They work because their consumers are typed functions; mistyped
 * inputs are caught at compile time.
 *
 * Trusted artifacts are different. `partitionVariables` and
 * `resolveNakedDeclaration` must reject forged JSON (`--input-json`, file
 * inputs, inherited context) that satisfies the structural artifact shape but
 * never passed through a sanctioned producer. JSON has no nominal types, so
 * the only honest check is a runtime symbol that producers actually attach
 * and consumers actually read. We therefore use a real `Symbol(...)` plus
 * `Object.defineProperty` (non-enumerable) — the brand survives reference
 * passes and outer-map spreads (preserved-by-reference), but is stripped by
 * the operations that should erase it: `JSON.stringify`, `JSON.parse`,
 * `{ ...record }` spread of the record itself, and `Object.assign`-into-new
 * patterns. The non-enumerability is load-bearing: enumerable symbol
 * properties ARE copied by `Object.assign` and `{ ...x }`, which would let a
 * `toPublicArtifactRecord(...)` projector accidentally carry the brand into
 * an output it shouldn't.
 *
 * The symbol is NOT exported from this module or the package barrel. The
 * only ways to mint trust are the producer functions below, themselves
 * called from the five sanctioned sites:
 *   1. {@link readExactArtifactRecordFromManifest} / `*Array*` in
 *      artifact-inputs.ts — sole authority that an URI matches a manifest row.
 *   2. The ARTIFACTS directive resolver's manifest-write/read paths
 *      (artifact-directive-resolver.ts).
 *   3. The file-artifact producer in artifact-directive-resolver.ts.
 *   4. The Zod parse seam in `makeRunbookStateSchema` (schemas.ts) when
 *      state is loaded from disk.
 *   5. The Zod parse seam in `makeContextSnapshotSchema` (schemas.ts) for
 *      delegation inheritance.
 *
 * Test helpers in `src/testing/effective-vars.ts` (exposed via the
 * `@rundown-org/core/testing/effective-vars` subpath export) call these
 * producers via a `*ForTest` wrapper so fixtures can mint trusted values
 * without round-tripping through a manifest file.
 */
const trustedArtifactBrand: unique symbol = Symbol('trustedArtifact');

/**
 * Provenance-checked artifact record. Distinguishes records minted by a
 * sanctioned producer from forged objects that happen to be artifact-shaped.
 *
 * Documentational alias: consumers that must enforce provenance accept this
 * type instead of bare {@link ArtifactRecord} to signal intent at signature
 * sites. Structural typing means the alias does not exclude unbranded
 * `ArtifactRecord` values on its own (see the codebase precedent at
 * `packages/core/src/runbook/types.ts:304-308`). The runtime aspect is
 * the enforcing layer: {@link isTrustedArtifactRecord} reads the symbol
 * property and returns `false` for forged objects that lack it. Direct
 * `as TrustedArtifactRecord` casts are blocked outside sanctioned producers
 * by the ESLint `no-restricted-syntax` rule.
 */
export type TrustedArtifactRecord = ArtifactRecord & {
  readonly [trustedArtifactBrand]: true;
};

/**
 * Provenance-checked artifact array (container brand).
 *
 * A per-element `every(isTrustedArtifactRecord)` check would vacuously
 * accept `[]`, allowing a forged `--input-json Plans='[]'` to slip through
 * as a trusted artifact array. We brand the array container itself with the
 * same symbol so empty arrays are only trusted when explicitly minted by a
 * sanctioned producer (e.g. the zero-match selector result).
 */
export type TrustedArtifactArray = readonly TrustedArtifactRecord[] & {
  readonly [trustedArtifactBrand]: true;
};

/**
 * Provenance-checked artifact value: a single trusted record or a trusted
 * (container-branded) array of trusted records.
 *
 * Mirrors {@link PublicArtifactValue} but at the trusted level.
 */
export type TrustedArtifactValue = TrustedArtifactRecord | TrustedArtifactArray;

/**
 * Incoming (untrusted) artifact value shape — pre-validation.
 *
 * Used at parse and CLI entry points where the value's provenance is not
 * yet established. The empty-array case is permitted here because incoming
 * JSON may legitimately carry `[]`; the partitioning boundary distinguishes
 * "empty trusted result (e.g. zero-match selector)" from "forged empty input"
 * by checking the container brand, not by checking the length.
 */
export type PublicArtifactValue = ArtifactRecord | readonly ArtifactRecord[];

/**
 * Sole producer of a {@link TrustedArtifactRecord} for a single record.
 *
 * Attaches the runtime brand symbol as a non-enumerable, non-configurable,
 * non-writable property on the record. Identity-preserving — the same object
 * reference is returned (with the brand now attached); callers can continue
 * to treat the value as `ArtifactRecord` at sites that don't need the brand.
 *
 * Apply ONLY at sanctioned producer sites — see the brand TSDoc above.
 *
 * @param record - Already-validated `ArtifactRecord`
 * @returns The same object reference, now carrying the trusted-artifact brand
 */
export function brandTrustedArtifactRecord(record: ArtifactRecord): TrustedArtifactRecord {
  // Idempotent: re-branding an already-branded record is safe because the
  // property descriptor is identical. Use `Object.getOwnPropertyDescriptor`
  // to short-circuit so we don't throw on the `configurable: false` second
  // call.
  if (Object.getOwnPropertyDescriptor(record, trustedArtifactBrand) === undefined) {
    Object.defineProperty(record, trustedArtifactBrand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return record as TrustedArtifactRecord;
}

/**
 * Sole producer of a {@link TrustedArtifactArray} — brands the array
 * container as well as every element.
 *
 * Empty arrays MUST be branded through this producer to denote a genuine
 * zero-match-selector result; forged `[]` input that bypasses producers will
 * fail {@link isTrustedArtifactArray} at the partitioning boundary.
 *
 * @param records - Array of records (may be empty for zero-match results);
 *   each entry is branded as `TrustedArtifactRecord` before container
 *   branding.
 * @returns The same array reference, now carrying the trusted-artifact brand
 */
export function brandTrustedArtifactArray(
  records: readonly ArtifactRecord[],
): TrustedArtifactArray {
  for (const record of records) {
    brandTrustedArtifactRecord(record);
  }
  if (Object.getOwnPropertyDescriptor(records, trustedArtifactBrand) === undefined) {
    Object.defineProperty(records, trustedArtifactBrand, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return records as TrustedArtifactArray;
}

/**
 * Sole producer of a {@link TrustedArtifactValue} — dispatches on shape.
 *
 * Used at the Zod parse seams where the union arm has just validated either
 * arm. Single records get `brandTrustedArtifactRecord`; arrays get
 * `brandTrustedArtifactArray` (which brands every element AND the container).
 *
 * @param value - Single `ArtifactRecord` or readonly `ArtifactRecord[]`
 * @returns The same value reference, branded as `TrustedArtifactValue`
 */
export function brandTrustedArtifactValue(value: PublicArtifactValue): TrustedArtifactValue {
  if (Array.isArray(value)) {
    return brandTrustedArtifactArray(value);
  }
  return brandTrustedArtifactRecord(value as ArtifactRecord);
}

/**
 * Runtime type guard for {@link TrustedArtifactRecord}.
 *
 * Reads the module-private symbol directly. Forged JSON never carries the
 * symbol (it's stripped by `JSON.stringify` and never present on
 * `JSON.parse(...)` output), and external code cannot mint the symbol (it's
 * not exported). So this guard reliably distinguishes branded from forged.
 *
 * @param value - Value to test
 * @returns `true` when `value` carries the trusted-artifact brand
 */
export function isTrustedArtifactRecord(value: unknown): value is TrustedArtifactRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[trustedArtifactBrand] === true
  );
}

/**
 * Runtime type guard for {@link TrustedArtifactArray}.
 *
 * Checks the **container brand** on the array itself. A bare `[]` from
 * forged input returns `false` even though no element check would fail.
 *
 * @param value - Value to test
 * @returns `true` when `value` is an array carrying the trusted-artifact brand
 */
export function isTrustedArtifactArray(value: unknown): value is TrustedArtifactArray {
  return (
    Array.isArray(value) &&
    (value as unknown as Record<symbol, unknown>)[trustedArtifactBrand] === true &&
    value.every(isTrustedArtifactRecord)
  );
}

/**
 * Runtime type guard for {@link TrustedArtifactValue}.
 *
 * Accepts either a single branded record or a branded array container. Does
 * NOT vacuously accept any empty array — `isTrustedArtifactArray` requires
 * the container brand explicitly.
 *
 * @param value - Value to test
 * @returns `true` when `value` is a trusted artifact value
 */
export function isTrustedArtifactValue(value: unknown): value is TrustedArtifactValue {
  return isTrustedArtifactRecord(value) || isTrustedArtifactArray(value);
}
