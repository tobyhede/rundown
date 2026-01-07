import { ActorLogic, ActorSystem, EventObject, Snapshot } from "../index.js";
import { TraversalOptions, AdjacencyMap } from "./types.js";
export declare function getAdjacencyMap<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject, TInput, TSystem extends ActorSystem<any> = ActorSystem<any>>(logic: ActorLogic<TSnapshot, TEvent, TInput, TSystem>, options: TraversalOptions<TSnapshot, TEvent, TInput>): AdjacencyMap<TSnapshot, TEvent>;
export declare function adjacencyMapToArray<TSnapshot, TEvent>(adjMap: AdjacencyMap<TSnapshot, TEvent>): Array<{
    state: TSnapshot;
    event: TEvent;
    nextState: TSnapshot;
}>;
