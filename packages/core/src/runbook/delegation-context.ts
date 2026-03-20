import type { ContextSnapshot, TemplateVarValue } from './types.js';

/** Maximum depth for parent context chain addressing. */
export const MAX_ANCESTOR_DEPTH = 32;

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
 *          and TemplateVarValue entries (strings, numbers, or objects) from snapshot.vars
 * @throws {Error} When the ancestor chain exceeds {@link MAX_ANCESTOR_DEPTH} levels
 */
export function reconstituteContextVars(
  snapshot: ContextSnapshot,
): Record<string, TemplateVarValue> {
  if (snapshot.ancestors.length > MAX_ANCESTOR_DEPTH) {
    throw new Error(
      `Parent context chain depth (${String(snapshot.ancestors.length)}) exceeds maximum of ${String(MAX_ANCESTOR_DEPTH)} levels`,
    );
  }

  const result: Record<string, TemplateVarValue> = {};

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
