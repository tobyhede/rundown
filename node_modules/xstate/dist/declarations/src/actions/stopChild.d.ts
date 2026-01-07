import { ActionArgs, AnyActorRef, EventObject, MachineContext, ParameterizedObject } from "../types.js";
type ResolvableActorRef<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject> = string | AnyActorRef | ((args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams) => AnyActorRef | string);
export interface StopAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
}
/**
 * Stops a child actor.
 *
 * @param actorRef The actor to stop.
 */
export declare function stopChild<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject>(actorRef: ResolvableActorRef<TContext, TExpressionEvent, TParams, TEvent>): StopAction<TContext, TExpressionEvent, TParams, TEvent>;
/**
 * Stops a child actor.
 *
 * @deprecated Use `stopChild(...)` instead
 * @alias
 */
export declare const stop: typeof stopChild;
export {};
