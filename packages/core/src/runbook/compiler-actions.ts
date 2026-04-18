import type { OutputDeclaration } from '@rundown-org/parser';
import type { LastAction } from './types.js';

/**
 * Single source of truth for parameterized action names and their params shapes.
 *
 * Every named action declared in {@link runbookSetup} that takes a `params`
 * argument MUST have its param shape listed here. The setup implementations
 * reference `ActionDefs[K]` for their second-argument type, and the
 * {@link actionRef} factory uses this map to type-check both the action name
 * and the params shape at every call site.
 *
 * Adding a new parameterized action:
 * 1. Add `<name>: <ParamsShape>` to this map.
 * 2. Declare the impl in `runbookSetup({ actions: { ... } })` with its params
 *    argument typed as `ActionDefs['<name>']`.
 * 3. Construct refs at call sites with `actionRef('<name>', { ... })`.
 */
export interface ActionDefs {
  readonly setLastAction: { action: LastAction; msg?: string };
  readonly storeStepOutputs: {
    outputs: readonly OutputDeclaration[];
    stepName: string;
    substepId?: string;
  };
  readonly storeFrontmatterOutputs: {
    stepName?: string;
    substepId?: string;
  };
}

/** A single parameterized action reference, discriminated on `type`. */
export type ActionRef<K extends keyof ActionDefs> = {
  readonly type: K;
  readonly params: ActionDefs[K];
};

/** Union of every parameterized action reference the compiler may emit. */
export type CompilerActionRef = {
  [K in keyof ActionDefs]: ActionRef<K>;
}[keyof ActionDefs];

/**
 * Build a typed action reference for use in XState transition `actions` arrays.
 *
 * Both the action name and the params shape are validated against
 * {@link ActionDefs} at the call site, so a typo on either side is a compile
 * error rather than a runtime surprise.
 *
 * @param type - Name of a parameterized action declared in {@link ActionDefs}
 * @param params - Params shape matching `ActionDefs[type]`
 * @returns `{ type, params }` literal with the narrow discriminated-union type
 */
export function actionRef<K extends keyof ActionDefs>(
  type: K,
  params: ActionDefs[K],
): ActionRef<K> {
  return { type, params };
}
