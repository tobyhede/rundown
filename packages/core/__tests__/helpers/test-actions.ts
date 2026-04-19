import type { RunbookMachine } from '../../src/runbook/compiler.js';

/**
 * The `actions` field accepted by `RunbookMachine['provide']`, with every
 * named action required. Deriving the shape from the compiled machine (rather
 * than re-declaring it) means:
 *
 *   - Adding a new named action to `runbookSetup` propagates automatically.
 *   - Param shapes for each action come from the XState setup inference — no
 *     hand-maintained duplicate type declarations.
 *
 * The intermediate `NonNullable<>` strips the `| undefined` that `provide()`
 * tolerates at the top level, and `Required<>` strips the per-key optional
 * markers so every action needs a stub below.
 */
type ProvideActionsArg = NonNullable<
  NonNullable<Parameters<RunbookMachine['provide']>[0]>['actions']
>;

export type RunbookActionImpls = Required<ProvideActionsArg>;

/**
 * No-op defaults covering every named action declared in `runbookSetup`.
 *
 * Because this value is typed as `Required<RunbookActionImpls>`, adding a new
 * named action to `runbookSetup` without also adding a stub here produces a
 * TypeScript error at build time. That compile-time pressure is the whole
 * point of this helper — it replaces the silent gap in `.provide()`'s own
 * type checking (XState v5 treats every key as optional, so a typo or a
 * missing stub passes type-checking without this guard).
 *
 * Keep the stubs as plain no-ops. Tests that need to observe a call should
 * override with `jest.fn()` via `withActionOverrides()`.
 */
export const defaultActionStubs: RunbookActionImpls = {
  setLastAction: () => {
    /* no-op */
  },
};

/**
 * Merge `overrides` over `defaultActionStubs` for use with
 * `machine.provide({ actions: withActionOverrides({ ... }) })`.
 *
 * The `Partial<RunbookActionImpls>` parameter type rejects unknown keys and
 * mistyped params at the call site, catching test-author typos that plain
 * `.provide()` would silently swallow.
 *
 * @param overrides - Per-action replacements (e.g. `jest.fn()` spies).
 * @returns A fully populated `actions` map suitable for `machine.provide()`.
 */
export function withActionOverrides(
  overrides: Partial<RunbookActionImpls> = {},
): RunbookActionImpls {
  return { ...defaultActionStubs, ...overrides };
}
