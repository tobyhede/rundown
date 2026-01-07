import { ActionArgs, ActionFunction, AnyEventObject, DoNotInfer, EventObject, MachineContext, ParameterizedObject, SendExpr } from "../types.js";
export interface EmitAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TEmitted extends EventObject> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TEmitted?: TEmitted;
}
/**
 * Emits an event to event handlers registered on the actor via `actor.on(event,
 * handler)`.
 *
 * @example
 *
 * ```ts
 * import { emit } from 'xstate';
 *
 * const machine = createMachine({
 *   // ...
 *   on: {
 *     something: {
 *       actions: emit({
 *         type: 'emitted',
 *         some: 'data'
 *       })
 *     }
 *   }
 *   // ...
 * });
 *
 * const actor = createActor(machine).start();
 *
 * actor.on('emitted', (event) => {
 *   console.log(event);
 * });
 *
 * actor.send({ type: 'something' });
 * // logs:
 * // {
 * //   type: 'emitted',
 * //   some: 'data'
 * // }
 * ```
 */
export declare function emit<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TEmitted extends AnyEventObject>(
/** The event to emit, or an expression that returns an event to emit. */
eventOrExpr: DoNotInfer<TEmitted> | SendExpr<TContext, TExpressionEvent, TParams, DoNotInfer<TEmitted>, TEvent>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, never, never, never, never, TEmitted>;
