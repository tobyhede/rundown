import { Spawner } from "../spawn.js";
import type { ActionArgs, AnyEventObject, Assigner, EventObject, LowInfer, MachineContext, ParameterizedObject, PropertyAssigner, ProvidedActor, ActionFunction } from "../types.js";
export interface AssignArgs<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor> extends ActionArgs<TContext, TExpressionEvent, TEvent> {
    spawn: Spawner<TActor>;
}
export interface AssignAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TActor?: TActor;
}
/**
 * Updates the current context of the machine.
 *
 * @example
 *
 * ```ts
 * import { createMachine, assign } from 'xstate';
 *
 * const countMachine = createMachine({
 *   context: {
 *     count: 0,
 *     message: ''
 *   },
 *   on: {
 *     inc: {
 *       actions: assign({
 *         count: ({ context }) => context.count + 1
 *       })
 *     },
 *     updateMessage: {
 *       actions: assign(({ context, event }) => {
 *         return {
 *           message: event.message.trim()
 *         };
 *       })
 *     }
 *   }
 * });
 * ```
 *
 * @param assignment An object that represents the partial context to update, or
 *   a function that returns an object that represents the partial context to
 *   update.
 */
export declare function assign<TContext extends MachineContext, TExpressionEvent extends AnyEventObject, // TODO: consider using a stricter `EventObject` here
TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor>(assignment: Assigner<LowInfer<TContext>, TExpressionEvent, TParams, TEvent, TActor> | PropertyAssigner<LowInfer<TContext>, TExpressionEvent, TParams, TEvent, TActor>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, TActor, never, never, never, never>;
