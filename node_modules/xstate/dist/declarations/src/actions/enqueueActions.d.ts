import { Guard } from "../guards.js";
import { Action, ActionArgs, ActionFunction, AnyActorRef, AnyEventObject, EventObject, MachineContext, ParameterizedObject, ProvidedActor, UnifiedArg } from "../types.js";
import { assign } from "./assign.js";
import { cancel } from "./cancel.js";
import { emit } from "./emit.js";
import { raise } from "./raise.js";
import { sendParent, sendTo } from "./send.js";
import { spawnChild } from "./spawnChild.js";
import { stopChild } from "./stopChild.js";
interface ActionEnqueuer<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor, TAction extends ParameterizedObject, TGuard extends ParameterizedObject, TDelay extends string, TEmitted extends EventObject> {
    (action: Action<TContext, TExpressionEvent, TEvent, undefined, TActor, TAction, TGuard, TDelay, TEmitted>): void;
    assign: (...args: Parameters<typeof assign<TContext, TExpressionEvent, undefined, TEvent, TActor>>) => void;
    cancel: (...args: Parameters<typeof cancel<TContext, TExpressionEvent, undefined, TEvent>>) => void;
    raise: (...args: Parameters<typeof raise<TContext, TExpressionEvent, TEvent, undefined, TDelay, TDelay>>) => void;
    sendTo: <TTargetActor extends AnyActorRef>(...args: Parameters<typeof sendTo<TContext, TExpressionEvent, undefined, TTargetActor, TEvent, TDelay, TDelay>>) => void;
    sendParent: (...args: Parameters<typeof sendParent<TContext, TExpressionEvent, undefined, AnyEventObject, TEvent, TDelay, TDelay>>) => void;
    spawnChild: (...args: Parameters<typeof spawnChild<TContext, TExpressionEvent, undefined, TEvent, TActor>>) => void;
    stopChild: (...args: Parameters<typeof stopChild<TContext, TExpressionEvent, undefined, TEvent>>) => void;
    emit: (...args: Parameters<typeof emit<TContext, TExpressionEvent, undefined, TEvent, TEmitted>>) => void;
}
export interface EnqueueActionsAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor, TAction extends ParameterizedObject, TGuard extends ParameterizedObject, TDelay extends string> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TEvent?: TEvent;
    _out_TActor?: TActor;
    _out_TAction?: TAction;
    _out_TGuard?: TGuard;
    _out_TDelay?: TDelay;
}
interface CollectActionsArg<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor, TAction extends ParameterizedObject, TGuard extends ParameterizedObject, TDelay extends string, TEmitted extends EventObject> extends UnifiedArg<TContext, TExpressionEvent, TEvent> {
    check: (guard: Guard<TContext, TExpressionEvent, undefined, TGuard>) => boolean;
    enqueue: ActionEnqueuer<TContext, TExpressionEvent, TEvent, TActor, TAction, TGuard, TDelay, TEmitted>;
}
type CollectActions<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor, TAction extends ParameterizedObject, TGuard extends ParameterizedObject, TDelay extends string, TEmitted extends EventObject> = ({ context, event, check, enqueue, self }: CollectActionsArg<TContext, TExpressionEvent, TEvent, TActor, TAction, TGuard, TDelay, TEmitted>, params: TParams) => void;
/**
 * Creates an action object that will execute actions that are queued by the
 * `enqueue(action)` function.
 *
 * @example
 *
 * ```ts
 * import { createMachine, enqueueActions } from 'xstate';
 *
 * const machine = createMachine({
 *   entry: enqueueActions(({ enqueue, check }) => {
 *     enqueue.assign({ count: 0 });
 *
 *     if (check('someGuard')) {
 *       enqueue.assign({ count: 1 });
 *     }
 *
 *     enqueue('someAction');
 *   })
 * });
 * ```
 */
export declare function enqueueActions<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject = TExpressionEvent, TActor extends ProvidedActor = ProvidedActor, TAction extends ParameterizedObject = ParameterizedObject, TGuard extends ParameterizedObject = ParameterizedObject, TDelay extends string = never, TEmitted extends EventObject = EventObject>(collect: CollectActions<TContext, TExpressionEvent, TParams, TEvent, TActor, TAction, TGuard, TDelay, TEmitted>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, TActor, TAction, TGuard, TDelay, TEmitted>;
export {};
