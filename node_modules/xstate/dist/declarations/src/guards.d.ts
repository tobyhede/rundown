import type { EventObject, StateValue, MachineContext, ParameterizedObject, AnyMachineSnapshot, NoRequiredParams, WithDynamicParams, Identity, Elements, DoNotInfer } from "./types.js";
type SingleGuardArg<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TGuardArg> = [TGuardArg] extends [{
    type: string;
}] ? Identity<TGuardArg> : [TGuardArg] extends [string] ? TGuardArg : GuardPredicate<TContext, TExpressionEvent, TParams, ParameterizedObject>;
type NormalizeGuardArg<TGuardArg> = TGuardArg extends {
    type: string;
} ? Identity<TGuardArg> & {
    params: unknown;
} : TGuardArg extends string ? {
    type: TGuardArg;
    params: undefined;
} : '_out_TGuard' extends keyof TGuardArg ? TGuardArg['_out_TGuard'] & ParameterizedObject : never;
type NormalizeGuardArgArray<TArg extends unknown[]> = Elements<{
    [K in keyof TArg]: NormalizeGuardArg<TArg[K]>;
}>;
export type GuardPredicate<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TGuard extends ParameterizedObject> = {
    (args: GuardArgs<TContext, TExpressionEvent>, params: TParams): boolean;
    _out_TGuard?: TGuard;
};
export interface GuardArgs<TContext extends MachineContext, TExpressionEvent extends EventObject> {
    context: TContext;
    event: TExpressionEvent;
}
export type Guard<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TGuard extends ParameterizedObject> = NoRequiredParams<TGuard> | WithDynamicParams<TContext, TExpressionEvent, TGuard> | GuardPredicate<TContext, TExpressionEvent, TParams, TGuard>;
export type UnknownGuard = UnknownReferencedGuard | UnknownInlineGuard;
type UnknownReferencedGuard = Guard<MachineContext, EventObject, ParameterizedObject['params'], ParameterizedObject>;
type UnknownInlineGuard = Guard<MachineContext, EventObject, undefined, ParameterizedObject>;
export declare function stateIn<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined>(stateValue: StateValue): GuardPredicate<TContext, TExpressionEvent, TParams, any>;
/**
 * Higher-order guard that evaluates to `true` if the `guard` passed to it
 * evaluates to `false`.
 *
 * @category Guards
 * @example
 *
 * ```ts
 * import { setup, not } from 'xstate';
 *
 * const machine = setup({
 *   guards: {
 *     someNamedGuard: () => false
 *   }
 * }).createMachine({
 *   on: {
 *     someEvent: {
 *       guard: not('someNamedGuard'),
 *       actions: () => {
 *         // will be executed if guard in `not(...)`
 *         // evaluates to `false`
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @returns A guard
 */
export declare function not<TContext extends MachineContext, TExpressionEvent extends EventObject, TArg>(guard: SingleGuardArg<TContext, TExpressionEvent, unknown, TArg>): GuardPredicate<TContext, TExpressionEvent, unknown, NormalizeGuardArg<DoNotInfer<TArg>>>;
/**
 * Higher-order guard that evaluates to `true` if all `guards` passed to it
 * evaluate to `true`.
 *
 * @category Guards
 * @example
 *
 * ```ts
 * import { setup, and } from 'xstate';
 *
 * const machine = setup({
 *   guards: {
 *     someNamedGuard: () => true
 *   }
 * }).createMachine({
 *   on: {
 *     someEvent: {
 *       guard: and([({ context }) => context.value > 0, 'someNamedGuard']),
 *       actions: () => {
 *         // will be executed if all guards in `and(...)`
 *         // evaluate to true
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @returns A guard action object
 */
export declare function and<TContext extends MachineContext, TExpressionEvent extends EventObject, TArg extends unknown[]>(guards: readonly [
    ...{
        [K in keyof TArg]: SingleGuardArg<TContext, TExpressionEvent, unknown, TArg[K]>;
    }
]): GuardPredicate<TContext, TExpressionEvent, unknown, NormalizeGuardArgArray<DoNotInfer<TArg>>>;
/**
 * Higher-order guard that evaluates to `true` if any of the `guards` passed to
 * it evaluate to `true`.
 *
 * @category Guards
 * @example
 *
 * ```ts
 * import { setup, or } from 'xstate';
 *
 * const machine = setup({
 *   guards: {
 *     someNamedGuard: () => true
 *   }
 * }).createMachine({
 *   on: {
 *     someEvent: {
 *       guard: or([({ context }) => context.value > 0, 'someNamedGuard']),
 *       actions: () => {
 *         // will be executed if any of the guards in `or(...)`
 *         // evaluate to true
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @returns A guard action object
 */
export declare function or<TContext extends MachineContext, TExpressionEvent extends EventObject, TArg extends unknown[]>(guards: readonly [
    ...{
        [K in keyof TArg]: SingleGuardArg<TContext, TExpressionEvent, unknown, TArg[K]>;
    }
]): GuardPredicate<TContext, TExpressionEvent, unknown, NormalizeGuardArgArray<DoNotInfer<TArg>>>;
export declare function evaluateGuard<TContext extends MachineContext, TExpressionEvent extends EventObject>(guard: UnknownGuard | UnknownInlineGuard, context: TContext, event: TExpressionEvent, snapshot: AnyMachineSnapshot): boolean;
export {};
