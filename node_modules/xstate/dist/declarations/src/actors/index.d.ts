import type { ActorRef, AnyEventObject, Snapshot } from "../types.js";
export { fromCallback, type CallbackActorLogic, type CallbackActorRef, type CallbackSnapshot, type CallbackLogicFunction } from "./callback.js";
export { fromEventObservable, fromObservable, type ObservableActorLogic, type ObservableActorRef, type ObservableSnapshot } from "./observable.js";
export { fromPromise, type PromiseActorLogic, type PromiseActorRef, type PromiseSnapshot } from "./promise.js";
export { fromTransition, type TransitionActorLogic, type TransitionActorRef, type TransitionSnapshot } from "./transition.js";
export declare function createEmptyActor(): ActorRef<Snapshot<undefined>, AnyEventObject, AnyEventObject>;
