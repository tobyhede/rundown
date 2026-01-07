import { ActionArgs, ActionFunction, DoNotInfer, EventObject, ExecutableActionObject, MachineContext, ParameterizedObject, RaiseActionOptions, SendExpr } from "../types.js";
export interface RaiseAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TDelay extends string> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TEvent?: TEvent;
    _out_TDelay?: TDelay;
}
/**
 * Raises an event. This places the event in the internal event queue, so that
 * the event is immediately consumed by the machine in the current step.
 *
 * @param eventType The event to raise.
 */
export declare function raise<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TDelay extends string = never, TUsedDelay extends TDelay = never>(eventOrExpr: DoNotInfer<TEvent> | SendExpr<TContext, TExpressionEvent, TParams, DoNotInfer<TEvent>, TEvent>, options?: RaiseActionOptions<TContext, TExpressionEvent, TParams, DoNotInfer<TEvent>, TUsedDelay>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, never, never, never, TDelay, never>;
export interface ExecutableRaiseAction extends ExecutableActionObject {
    type: 'xstate.raise';
    params: {
        event: EventObject;
        id: string | undefined;
        delay: number | undefined;
    };
}
