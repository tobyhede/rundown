import { ActionArgs, ActionFunction, AnyActorLogic, ConditionalRequired, EventObject, InputFrom, IsLiteralString, IsNotNever, MachineContext, Mapper, ParameterizedObject, ProvidedActor, RequiredActorOptions, UnifiedArg } from "../types.js";
type ResolvableActorId<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TId extends string | undefined> = TId | ((args: UnifiedArg<TContext, TExpressionEvent, TEvent>) => TId);
export interface SpawnAction<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor> {
    (args: ActionArgs<TContext, TExpressionEvent, TEvent>, params: TParams): void;
    _out_TActor?: TActor;
}
interface SpawnActionOptions<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor> {
    id?: ResolvableActorId<TContext, TExpressionEvent, TEvent, TActor['id']>;
    systemId?: string;
    input?: Mapper<TContext, TEvent, InputFrom<TActor['logic']>, TEvent> | InputFrom<TActor['logic']>;
    syncSnapshot?: boolean;
}
type DistributeActors<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor> = (TActor extends any ? ConditionalRequired<[
    src: TActor['src'],
    options?: SpawnActionOptions<TContext, TExpressionEvent, TEvent, TActor> & {
        [K in RequiredActorOptions<TActor>]: unknown;
    }
], IsNotNever<RequiredActorOptions<TActor>>> : never) | [
    src: AnyActorLogic,
    options?: SpawnActionOptions<TContext, TExpressionEvent, TEvent, ProvidedActor> & {
        id?: never;
    }
];
type SpawnArguments<TContext extends MachineContext, TExpressionEvent extends EventObject, TEvent extends EventObject, TActor extends ProvidedActor> = IsLiteralString<TActor['src']> extends true ? DistributeActors<TContext, TExpressionEvent, TEvent, TActor> : [
    src: string | AnyActorLogic,
    options?: {
        id?: ResolvableActorId<TContext, TExpressionEvent, TEvent, string>;
        systemId?: string;
        input?: unknown;
        syncSnapshot?: boolean;
    }
];
export declare function spawnChild<TContext extends MachineContext, TExpressionEvent extends EventObject, TParams extends ParameterizedObject['params'] | undefined, TEvent extends EventObject, TActor extends ProvidedActor>(...[src, { id, systemId, input, syncSnapshot }]: SpawnArguments<TContext, TExpressionEvent, TEvent, TActor>): ActionFunction<TContext, TExpressionEvent, TEvent, TParams, TActor, never, never, never, never>;
export {};
