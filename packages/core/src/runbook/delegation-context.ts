import type { ContextSnapshot } from './types.js';

/**
 * Reconstitute inherited context variables from a frozen delegation snapshot.
 *
 * Rebuilds the variable map that `buildInheritedContextVars` would produce
 * by walking live parent state, but from the frozen snapshot instead.
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
 * @returns Variable map keyed by `context.parent.vars.*`, `context.ancestors.N.*`, etc.
 */
export function reconstituteContextVars(snapshot: ContextSnapshot): Record<string, string> {
  const result: Record<string, string> = {};

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

    for (const [key, value] of Object.entries(ancestor.vars)) {
      if (key.startsWith('context.')) continue;
      result[`${chainPrefix}.vars.${key}`] = value;
    }

    chainPrefix += '.parent';
  }

  return result;
}
