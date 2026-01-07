import { ActorLogic, ActorSystem, EventObject, Snapshot } from "../index.js";
import { StatePath, TraversalOptions } from "./types.js";
export declare function getPathsFromEvents<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput, TSystem extends ActorSystem<any> = ActorSystem<any>>(logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>, events: TEvent[], options?: TraversalOptions<TSnapshot, TEvent, TInput>): Array<StatePath<TSnapshot, TEvent>>;
