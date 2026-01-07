import { EventObject, AnyStateMachine, AnyActorLogic, EventFromLogic, Snapshot, InputFrom } from "../index.js";
import type { SerializedSnapshot, StatePath, DirectedGraphNode, TraversalOptions, AnyStateNode, TraversalConfig } from "./types.js";
/**
 * Returns all state nodes of the given `node`.
 *
 * @param stateNode State node to recursively get child state nodes from
 */
export declare function getStateNodes(stateNode: AnyStateNode | AnyStateMachine): AnyStateNode[];
export declare function serializeSnapshot(snapshot: Snapshot<any>): SerializedSnapshot;
export declare function createDefaultMachineOptions<TMachine extends AnyStateMachine>(machine: TMachine, options?: TraversalOptions<ReturnType<TMachine['transition']>, EventFromLogic<TMachine>, InputFrom<TMachine>>): TraversalOptions<ReturnType<TMachine['transition']>, EventFromLogic<TMachine>, InputFrom<TMachine>>;
export declare function createDefaultLogicOptions(): TraversalOptions<any, any, any>;
export declare function toDirectedGraph(stateMachine: AnyStateNode | AnyStateMachine): DirectedGraphNode;
export declare function resolveTraversalOptions<TLogic extends AnyActorLogic>(logic: TLogic, traversalOptions?: TraversalOptions<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>, InputFrom<TLogic>>, defaultOptions?: TraversalOptions<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>, InputFrom<TLogic>>): TraversalConfig<ReturnType<TLogic['transition']>, EventFromLogic<TLogic>>;
export declare function joinPaths<TSnapshot extends Snapshot<unknown>, TEvent extends EventObject>(headPath: StatePath<TSnapshot, TEvent>, tailPath: StatePath<TSnapshot, TEvent>): StatePath<TSnapshot, TEvent>;
