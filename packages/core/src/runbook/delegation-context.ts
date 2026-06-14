import { IDENTITY_OWNED_BUILTINS } from '@rundown-org/parser';
import {
  brandEffectiveVars,
  brandTrustedArtifactValue,
  mergeEffectiveVars,
} from './effective-vars.js';
import { isArtifactRecord } from './artifact-schema.js';
import type {
  AncestorSnapshot,
  ContextSnapshot,
  DelegationParentState,
  ContextSnapshotVarValue,
  ForContext,
  IterationBinding,
  JsonValue,
  TemplateVarValue,
} from './types.js';
import { getActiveForContext, deriveExecutionAt } from './targeting.js';

/** Maximum depth for parent context chain addressing. */
export const MAX_ANCESTOR_DEPTH = 32;

const IDENTITY_OWNED_BUILTIN_SET = new Set<string>(IDENTITY_OWNED_BUILTINS);

function rebrandContextSnapshotVars(
  vars: Readonly<Record<string, ContextSnapshotVarValue>>,
): ReturnType<typeof brandEffectiveVars<ContextSnapshotVarValue>> {
  const branded: Record<string, ContextSnapshotVarValue> = {};
  let changed = false;

  for (const [key, value] of Object.entries(vars)) {
    if (isArtifactRecord(value)) {
      branded[key] = brandTrustedArtifactValue(value);
      changed = true;
      continue;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isArtifactRecord)) {
      branded[key] = brandTrustedArtifactValue(value);
      changed = true;
      continue;
    }
    branded[key] = value;
  }

  return brandEffectiveVars(changed ? branded : vars);
}

/**
 * Rehydrate trusted artifact brands inside a context snapshot.
 *
 * XState persisted snapshots are intentionally opaque in `RunbookState`, so
 * inline launch metadata read directly from `snapshot.context` may bypass the
 * state-schema parse seam that normally rebrands `ContextSnapshot.vars`.
 *
 * @param snapshot - Context snapshot produced by core inline/delegation actors
 * @returns Snapshot with artifact values in `vars` and ancestor vars rebranded
 */
export function rebrandContextSnapshotArtifacts(snapshot: ContextSnapshot): ContextSnapshot {
  return {
    ...snapshot,
    vars: rebrandContextSnapshotVars(snapshot.vars),
    ancestors: snapshot.ancestors.map((ancestor) => ({
      ...ancestor,
      vars: rebrandContextSnapshotVars(ancestor.vars),
    })),
  };
}

/**
 * Reconstitute inherited context variables from a frozen delegation snapshot.
 *
 * Rebuilds inherited context variables by walking the frozen snapshot instead
 * of live parent state.
 *
 * Produces the following addressing schemes:
 * - `context.parent.vars.*` and `context.ancestors.0.vars.*` from snapshot.vars
 * - `context.ancestors.N.vars.*` (N >= 1) from snapshot.ancestors[N-1]
 * - `context.ancestors.N.step` / `.substep` from snapshot.ancestors[N-1]
 * - `context.parent.parent...vars.*` (chain form) from snapshot.ancestors
 *
 * Keys starting with `context.` in source vars are excluded to prevent
 * recursive nesting.
 *
 * @param snapshot - The frozen context snapshot from delegation metadata
 * @returns Variable map with string values for structural fields (step, substep, at, index)
 *          and ContextSnapshotVarValue entries (template values or artifact records)
 *          from snapshot.vars
 * @throws {Error} When the ancestor chain exceeds {@link MAX_ANCESTOR_DEPTH} levels
 */
export function reconstituteContextVars(
  snapshot: ContextSnapshot,
): Record<string, ContextSnapshotVarValue> {
  if (snapshot.ancestors.length > MAX_ANCESTOR_DEPTH) {
    throw new Error(
      `Parent context chain depth (${String(snapshot.ancestors.length)}) exceeds maximum of ${String(MAX_ANCESTOR_DEPTH)} levels`,
    );
  }

  const result: Record<string, ContextSnapshotVarValue> = {};

  // Parent structural fields: step, substep, at, index
  if (snapshot.step) {
    result['context.parent.step'] = snapshot.step;
    result['context.ancestors.0.step'] = snapshot.step;
  }
  if (snapshot.substep) {
    result['context.parent.substep'] = snapshot.substep;
    result['context.ancestors.0.substep'] = snapshot.substep;
  }
  if (snapshot.at) {
    result['context.parent.at'] = snapshot.at;
    result['context.ancestors.0.at'] = snapshot.at;
  }
  if (snapshot.index !== undefined) {
    result['context.parent.index'] = String(snapshot.index);
    result['context.ancestors.0.index'] = String(snapshot.index);
  }

  // Parent vars: context.parent.vars.* and context.ancestors.0.vars.* (parent is ancestor 0)
  for (const [key, value] of Object.entries(snapshot.vars)) {
    if (key.startsWith('context.')) continue;
    result[`context.parent.vars.${key}`] = value;
    result[`context.ancestors.0.vars.${key}`] = value;
  }

  // Ancestor chain from snapshot.ancestors: index offset by 1
  // snapshot.ancestors[0] = grandparent = context.ancestors.1
  for (let i = 0; i < snapshot.ancestors.length; i++) {
    const ancestor = snapshot.ancestors[i];
    const arrayIdx = i + 1; // offset: parent is 0, grandparent is 1
    const arrayPrefix = `context.ancestors.${String(arrayIdx)}`;

    // Structural properties
    result[`${arrayPrefix}.step`] = ancestor.step;
    if (ancestor.substep) {
      result[`${arrayPrefix}.substep`] = ancestor.substep;
    }
    if (ancestor.at) {
      result[`${arrayPrefix}.at`] = ancestor.at;
    }
    if (ancestor.index !== undefined) {
      result[`${arrayPrefix}.index`] = String(ancestor.index);
    }

    // Vars
    for (const [key, value] of Object.entries(ancestor.vars)) {
      if (key.startsWith('context.')) continue;
      result[`${arrayPrefix}.vars.${key}`] = value;
    }
  }

  // Chain form: context.parent.parent = grandparent, context.parent.parent.parent = great-grandparent
  let chainPrefix = 'context.parent.parent';
  for (let i = 0; i < snapshot.ancestors.length; i++) {
    const ancestor = snapshot.ancestors[i];

    result[`${chainPrefix}.step`] = ancestor.step;
    if (ancestor.substep) {
      result[`${chainPrefix}.substep`] = ancestor.substep;
    }
    if (ancestor.at) {
      result[`${chainPrefix}.at`] = ancestor.at;
    }
    if (ancestor.index !== undefined) {
      result[`${chainPrefix}.index`] = String(ancestor.index);
    }

    for (const [key, value] of Object.entries(ancestor.vars)) {
      if (key.startsWith('context.')) continue;
      result[`${chainPrefix}.vars.${key}`] = value;
    }

    chainPrefix += '.parent';
  }

  return result;
}

/**
 * Build a context snapshot from live runbook state.
 *
 * Captures the current execution position and effective variable space.
 * The merge of `state.templateVars`, `state.variables`, and the optional
 * caller-supplied `extraVars` is delegated to {@link mergeEffectiveVars}
 * (the sole producer of {@link ContextSnapshot.vars}'s branded
 * `EffectiveVars` type). Routing through that producer keeps delegation
 * snapshots in lock-step with the merge order used by
 * `buildExecutionFrame` in `output-evaluator.ts` for OUTPUTS evaluation
 * — and prevents the bug class fixed in commit `19067f6f`, where this
 * function silently dropped `state.variables`.
 *
 * @param state - Current runbook state
 * @param substep - Target substep identifier (e.g., "1")
 * @param ancestors - Ancestor chain (defaults to empty)
 * @param options - Optional overrides for extra variables and explicit iteration
 * @param options.extraVars - Additional variables to merge into the snapshot
 * @param options.iterationOverride - Explicit iteration number (overrides derived value)
 * @returns Frozen context snapshot
 */
export function buildContextSnapshot(
  state: DelegationParentState,
  substep?: string,
  ancestors?: readonly AncestorSnapshot[],
  options?: {
    extraVars?: Readonly<Record<string, TemplateVarValue>>;
    iterationOverride?: number;
  },
): ContextSnapshot {
  const vars = rebrandContextSnapshotVars(mergeEffectiveVars(state, options?.extraVars));
  const activeFor = getActiveForContext(state.forStack, state.step);
  const iteration = options?.iterationOverride ?? activeFor?.iteration;
  const iterationBinding = toIterationBinding(activeFor);
  const at = deriveExecutionAt(state.step, substep, iteration);

  return {
    vars,
    ancestors: ancestors ?? [],
    step: state.step,
    substep,
    at,
    ...(iteration !== undefined ? { index: iteration } : {}),
    ...(iterationBinding !== undefined ? { iterationBinding } : {}),
  };
}

/**
 * Build a typed iteration binding from the active FOR context, or `undefined`
 * when there is no current named/data-source iteration. An item binding is
 * produced only for a resolved data-source value, keeping the `item` variant's
 * non-optional `value` invariant true by construction.
 *
 * @param fc - Active FOR context (already excludes implicit / non-current frames)
 * @returns Typed iteration binding, or undefined
 */
function toIterationBinding(fc: ForContext | undefined): IterationBinding | undefined {
  if (fc === undefined) return undefined;
  if (fc.source.kind === 'range') {
    return fc.variable !== undefined
      ? { kind: 'range', index: fc.iteration, variable: fc.variable }
      : { kind: 'range', index: fc.iteration };
  }
  // No variable or no resolved value → no item binding. This keeps the `item`
  // variant's non-optional `value` true by construction; a data-source frame
  // mid-resolution (currentValue still undefined) simply contributes nothing.
  if (fc.variable === undefined || fc.currentValue === undefined) return undefined;
  return { kind: 'item', index: fc.iteration, variable: fc.variable, value: fc.currentValue };
}

/**
 * Normalise a FOR data-source item value into the child's input-variable space.
 *
 * A data-source item is a {@link JsonValue}; the inherited-variable layer the
 * child receives is {@link TemplateVarValue}-typed (the declared-input space,
 * which excludes the bare `boolean`/`null` primitives a `.jsonl` line may
 * carry). Objects, arrays, strings, and numbers pass through unchanged; a
 * `boolean` or `null` item is serialised to its JSON string, matching the
 * documented `{{item}}` serialized-JSON-string rendering convention.
 *
 * @param value - The resolved data-source item from the iteration binding
 * @returns The item as a template-variable value
 */
function itemValueToTemplateVar(value: JsonValue): TemplateVarValue {
  return typeof value === 'boolean' || value === null ? JSON.stringify(value) : value;
}

/**
 * Surface a typed iteration binding into a flat inherited-var map for a child.
 *
 * `Index`/`index` are surfaced unconditionally; the loop variable is surfaced
 * only when the child declares it in frontmatter `inputs` (the contract gate —
 * language spec §10.4). Applied at claim/prepare time, where the child's
 * `inputs` are known. The result is {@link TemplateVarValue}-typed so it
 * composes directly with the inherited-user-var layer in
 * `prepareParsedRunbook`, which ranks below explicit `--input`.
 *
 * @param binding - Typed iteration binding from the snapshot (may be undefined)
 * @param childInputs - The child runbook's declared `inputs` names
 * @returns Inherited-var additions (empty when there is no binding)
 */
export function surfaceIterationBinding(
  binding: IterationBinding | undefined,
  childInputs: readonly string[] | undefined,
): Record<string, TemplateVarValue> {
  if (binding === undefined) return {};
  // Both casings are surfaced deliberately: `Index` is the documented built-in
  // (language spec §10.4), and lower-case `index` mirrors the snapshot/CLI field
  // used by the `--index` flag so templates referencing either resolve.
  const surfaced: Record<string, TemplateVarValue> = {
    Index: String(binding.index),
    index: String(binding.index),
  };
  const declares = (name: string): boolean => childInputs?.includes(name) ?? false;
  if (binding.kind === 'range') {
    if (binding.variable !== undefined && declares(binding.variable)) {
      surfaced[binding.variable] = String(binding.index);
    }
  } else if (declares(binding.variable)) {
    surfaced[binding.variable] = itemValueToTemplateVar(binding.value);
  }
  return surfaced;
}

/**
 * Extract parent user-level variables from a context snapshot.
 *
 * Filters out `context.*` namespace keys, `RunId` (which is per-execution),
 * and `RunbookRef` (which belongs to the resolved child), returning the
 * remaining user-addressable variables suitable for child inheritance. Since
 * `buildContextSnapshot` folds `state.variables` into
 * `snapshot.vars` via `mergeEffectiveVars`, the returned set intentionally
 * includes step OUTPUTS (which live in `state.variables`) as well as the
 * caller-provided `state.templateVars`. Do not re-filter `state.variables`
 * back out — their visibility to children is the entire point of the OUTPUTS
 * flow (SPEC §7).
 *
 * @param snapshot - The context snapshot to extract user variables from
 * @returns User-defined variables including step OUTPUTS (excludes context.*, RunId, and RunbookRef)
 */
export function extractInheritedUserVars(
  snapshot: ContextSnapshot,
): Record<string, ContextSnapshotVarValue> {
  const result: Record<string, ContextSnapshotVarValue> = {};
  for (const [key, value] of Object.entries(snapshot.vars)) {
    if (!key.startsWith('context.') && !IDENTITY_OWNED_BUILTIN_SET.has(key)) {
      result[key] = value;
    }
  }
  return result;
}
