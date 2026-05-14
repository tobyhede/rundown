import type { ActionFunction } from 'xstate';
import type { runbookSetup } from '../../src/runbook/compiler.js';

/**
 * Derive the full action-union type ({@link AllActions}) from `runbookSetup.createAction`'s
 * parameter rather than from `RunbookMachine`.
 *
 * **Why not `MachineImplementationsFrom<RunbookMachine>`?**
 *
 * `RunbookMachine = ReturnType<typeof runbookSetup.createMachine>`. Because
 * `createMachine` is generic on `TConfig`, evaluating its `ReturnType` without
 * a concrete config instantiates the return with the generic constraint —
 * giving `TAction = ParameterizedObject` (i.e. `{ type: string; params: unknown }`).
 * That collapses the `actions` map to a string-indexed type where every object,
 * including `{}`, satisfies `Required<>`. Both compile-time guarantees are lost.
 *
 * **The correct anchor: `runbookSetup.createAction`**
 *
 * `SetupReturn.createAction` is typed as:
 * ```
 * (action: ActionFunction<TContext, TEvent, TEvent, unknown,
 *   ToProvidedActor<...>, ToParameterizedObject<TActions>, ...>) => typeof action
 * ```
 * The 6th type parameter of `ActionFunction` is `ToParameterizedObject<TActions>` — the
 * concrete action union — taken directly from `SetupReturn`'s own generic params, not
 * from the `createMachine` call. Inferring from that position gives us the specific union
 * `{ type: 'setLastAction'; params: { action: LastAction; msg?: string } }` rather than
 * the generic `ParameterizedObject`.
 *
 * Building a mapped type over `AllActions['type']` then produces an object type with a
 * concrete, non-optional `setLastAction` key, so:
 *
 *   - Adding a new named action to `runbookSetup` without a matching stub is a tsc error.
 *   - `withActionOverrides` rejects unknown keys and wrong param shapes at the call site.
 */

/** Internal helper: infer the Nth type parameter of ActionFunction via conditional types. */
type _CreateActionParam = Parameters<(typeof runbookSetup)['createAction']>[0];
type _ExtractActionFnParam<
  F,
  Pos extends 'allActions' | 'context' | 'event' | 'actors' | 'guards' | 'delays' | 'emitted',
> =
  F extends ActionFunction<
    infer TCtx,
    infer TEvt,
    infer _TBaseEvt,
    infer _TParams,
    infer TActors,
    infer TAll,
    infer TGuards,
    infer TDelays,
    infer TEmitted
  >
    ? Pos extends 'context'
      ? TCtx
      : Pos extends 'event'
        ? TEvt
        : Pos extends 'actors'
          ? TActors
          : Pos extends 'allActions'
            ? TAll
            : Pos extends 'guards'
              ? TGuards
              : Pos extends 'delays'
                ? TDelays
                : Pos extends 'emitted'
                  ? TEmitted
                  : never
    : never;

/** Union of all parameterized action objects declared in `runbookSetup`. */
type AllActions = _ExtractActionFnParam<_CreateActionParam, 'allActions'>;

/**
 * The `actions` map required by `RunbookMachine`, with every named action
 * present as a **required** key.
 *
 * Derived from `typeof runbookSetup` (not `RunbookMachine`) so the action
 * keys are concrete string literals, not a string index signature.
 *
 *   - Adding a new named action to `runbookSetup` without a matching stub here
 *     is a tsc error at build time.
 *   - `withActionOverrides(overrides)` rejects unknown keys and wrong param
 *     shapes at the call site.
 */
export type RunbookActionImpls = {
  [K in AllActions['type']]: ActionFunction<
    _ExtractActionFnParam<_CreateActionParam, 'context'>,
    _ExtractActionFnParam<_CreateActionParam, 'event'>,
    _ExtractActionFnParam<_CreateActionParam, 'event'>,
    Extract<AllActions, { type: K }>['params'],
    _ExtractActionFnParam<_CreateActionParam, 'actors'>,
    AllActions,
    _ExtractActionFnParam<_CreateActionParam, 'guards'>,
    _ExtractActionFnParam<_CreateActionParam, 'delays'>,
    _ExtractActionFnParam<_CreateActionParam, 'emitted'>
  >;
};

/**
 * No-op defaults covering every named action declared in `runbookSetup`.
 *
 * Because this value is typed as `RunbookActionImpls`, adding a new
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
  setLastAction: () => {},
  storeCapturedVariables: () => {},
  setOutputCaptureFailed: () => {},
  setArtifactResolutionFailed: () => {},
  storeReadyIteration: () => {},
  storeExhaustedIteration: () => {},
  setForResolutionFailed: () => {},
  storeResolvedArtifacts: () => {},
  storeStepOutputs: () => {},
  storeFrontmatterOutputs: () => {},
  raisePass: () => {},
  raiseFail: () => {},
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
