import { ActorRefFromLogic, AnyActorLogic, AnyActorRef, AnyActorScope, AnyEventObject, AnyMachineSnapshot, ConditionalRequired, GetConcreteByKey, InputFrom, IsLiteralString, IsNotNever, ProvidedActor, RequiredActorOptions, type RequiredLogicInput } from "./types.js";
type SpawnOptions<TActor extends ProvidedActor, TSrc extends TActor['src']> = TActor extends {
    src: TSrc;
} ? ConditionalRequired<[
    options?: {
        id?: TActor['id'];
        systemId?: string;
        input?: InputFrom<TActor['logic']>;
        syncSnapshot?: boolean;
    } & {
        [K in RequiredActorOptions<TActor>]: unknown;
    }
], IsNotNever<RequiredActorOptions<TActor>>> : never;
export type Spawner<TActor extends ProvidedActor> = IsLiteralString<TActor['src']> extends true ? {
    <TSrc extends TActor['src']>(logic: TSrc, ...[options]: SpawnOptions<TActor, TSrc>): ActorRefFromLogic<GetConcreteByKey<TActor, 'src', TSrc>['logic']>;
    <TLogic extends AnyActorLogic>(src: TLogic, ...[options]: ConditionalRequired<[
        options?: {
            id?: never;
            systemId?: string;
            input?: InputFrom<TLogic>;
            syncSnapshot?: boolean;
        } & {
            [K in RequiredLogicInput<TLogic>]: unknown;
        }
    ], IsNotNever<RequiredLogicInput<TLogic>>>): ActorRefFromLogic<TLogic>;
} : <TLogic extends AnyActorLogic | string>(src: TLogic, ...[options]: ConditionalRequired<[
    options?: {
        id?: string;
        systemId?: string;
        input?: TLogic extends string ? unknown : InputFrom<TLogic>;
        syncSnapshot?: boolean;
    } & (TLogic extends AnyActorLogic ? {
        [K in RequiredLogicInput<TLogic>]: unknown;
    } : {})
], IsNotNever<TLogic extends AnyActorLogic ? RequiredLogicInput<TLogic> : never>>) => TLogic extends AnyActorLogic ? ActorRefFromLogic<TLogic> : AnyActorRef;
export declare function createSpawner(actorScope: AnyActorScope, { machine, context }: AnyMachineSnapshot, event: AnyEventObject, spawnedChildren: Record<string, AnyActorRef>): Spawner<any>;
export {};
