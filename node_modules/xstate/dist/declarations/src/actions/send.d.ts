import { ActionArgs, ActionFunction, AnyActorRef, AnyEventObject, Cast, DoNotInfer, EventFrom, EventObject, ExecutableActionObject, InferEvent, MachineContext, ParameterizedObject, SendExpr, SendToActionOptions } from "../types.js";
export interface SendToAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TDelay extends string> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TDelay?: TDelay;
}
/**
 * Sends an event to an actor.
 *
 * @param actor The `ActorRef` to send the event to.
 * @param event The event to send, or an expression that evaluates to the event
 *   to send
 * @param options Send action options
 *
 *   - `id` - The unique send event identifier (used with `cancel()`).
 *   - `delay` - The number of milliseconds to delay the sending of the event.
 */
export declare function sendTo<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TTargetActor extends AnyActorRef, TEvent extends EventObject, TDelay extends string = never, TUsedDelay extends TDelay = never>(to: SendToActionTarget<TContext, TExpressionEvent, TParams, TTargetActor, TEvent>, eventOrExpr: EventFrom<TTargetActor> | SendExpr<TContext, TExpressionEvent, TParams, InferEvent<Cast<EventFrom<TTargetActor>, EventObject>>, TEvent>, options?: SendToActionOptions<TContext, TExpressionEvent, TParams, DoNotInfer<TEvent>, TUsedDelay>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, never, never, never, TDelay, never>;
/**
 * Sends an event to this machine's parent.
 *
 * @param event The event to send to the parent machine.
 * @param options Options to pass into the send event.
 */
export declare function sendParent<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TSentEvent extends EventObject = AnyEventObject, TEvent extends EventObject = AnyEventObject, TDelay extends string = never, TUsedDelay extends TDelay = never>(event: TSentEvent | SendExpr<TContext, TExpressionEvent, TParams, TSentEvent, TEvent>, options?: SendToActionOptions<TContext, TExpressionEvent, TParams, TEvent, TUsedDelay>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, never, never, never, TDelay, never>;
type SendToActionTarget<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TTargetActor extends AnyActorRef, TEvent extends EventObject> = string | TTargetActor | ((args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams) => string | TTargetActor);
/**
 * Forwards (sends) an event to the `target` actor.
 *
 * @param target The target actor to forward the event to.
 * @param options Options to pass into the send action creator.
 */
export declare function forwardTo<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TDelay extends string = never, TUsedDelay extends TDelay = never>(target: SendToActionTarget<TContext, TExpressionEvent, TParams, AnyActorRef, TEvent>, options?: SendToActionOptions<TContext, TExpressionEvent, TParams, TEvent, TUsedDelay>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, never, never, never, TDelay, never>;
export interface ExecutableSendToAction extends ExecutableActionObject {
    type: 'xstate.sendTo';
    params: {
        event: EventObject;
        id: string | undefined;
        delay: number | undefined;
        to: AnyActorRef;
    };
}
export {};
