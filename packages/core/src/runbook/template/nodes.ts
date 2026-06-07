import { isBuiltinTemplateHelperName, type BuiltinTemplateHelperName } from '@rundown-org/parser';

/** Built-in helper name, parser-owned and core-rendered. */
export type BuiltinName = BuiltinTemplateHelperName;

/** Template helper argument. */
export type TemplateArg =
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'literal'; readonly value: string };

/**
 * Ephemeral template node produced for a single render call.
 *
 * Never persist this type into RunbookState, RunbookContext, or XState
 * snapshots.
 */
export type TemplateNode =
  | { readonly kind: 'literal'; readonly text: string }
  | {
      readonly kind: 'variable';
      readonly name: string;
      /**
       * Explicit reference (`{{ ./Var }}`) versus a bare reference (`{{ Var }}`).
       * Explicit references bypass the helper registry and resolve as variables.
       */
      readonly explicit: boolean;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    }
  | {
      readonly kind: 'userHelper';
      readonly name: string;
      readonly arg: TemplateArg;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    }
  | {
      readonly kind: 'builtinHelper';
      readonly name: BuiltinName;
      readonly arg: TemplateArg;
      /** Original placeholder token, preserved for soft-miss fallback and debugging. */
      readonly raw: string;
    };

/**
 * Check whether a helper name is built-in.
 *
 * @param name - Candidate helper name
 * @returns `true` when parser reserves the name for a built-in helper
 */
export function isBuiltinName(name: string): name is BuiltinName {
  return isBuiltinTemplateHelperName(name);
}
