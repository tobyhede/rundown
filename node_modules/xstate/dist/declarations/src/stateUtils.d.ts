import { MachineSnapshot } from "./State.js";
import type { StateNode } from "./StateNode.js";
import { ActionArgs, AnyEventObject, AnyMachineSnapshot, AnyStateNode, AnyTransitionDefinition, DelayedTransitionDefinition, EventObject, InitialTransitionConfig, InitialTransitionDefinition, MachineContext, StateValue, TransitionDefinition, TODO, UnknownAction, ParameterizedObject, AnyTransitionConfig, AnyActorScope } from "./types.js";
type StateNodeIterable<TContext extends MachineContext, TE extends EventObject> = Iterable<StateNode<TContext, TE>>;
type AnyStateNodeIterable = StateNodeIterable<any, any>;
export declare function getAllStateNodes(stateNodes: Iterable<AnyStateNode>): Set<AnyStateNode>;
export declare function getStateValue(rootNode: AnyStateNode, stateNodes: AnyStateNodeIterable): StateValue;
export declare function isInFinalState(stateNodeSet: Set<AnyStateNode>, stateNode: AnyStateNode): boolean;
export declare const isStateId: (str: string) => boolean;
export declare function getCandidates<TEvent extends EventObject>(stateNode: StateNode<any, TEvent>, receivedEventType: TEvent['type']): Array<TransitionDefinition<any, TEvent>>;
/** All delayed transitions from the config. */
export declare function getDelayedTransitions(stateNode: AnyStateNode): Array<DelayedTransitionDefinition<MachineContext, EventObject>>;
export declare function formatTransition(stateNode: AnyStateNode, descriptor: string, transitionConfig: AnyTransitionConfig): AnyTransitionDefinition;
export declare function formatTransitions<TContext extends MachineContext, TEvent extends EventObject>(stateNode: AnyStateNode): Map<string, TransitionDefinition<TContext, TEvent>[]>;
export declare function formatInitialTransition<TContext extends MachineContext, TEvent extends EventObject>(stateNode: AnyStateNode, _target: string | undefined | InitialTransitionConfig<TContext, TEvent, TODO, TODO, TODO, TODO>): InitialTransitionDefinition<TContext, TEvent>;
export declare function getInitialStateNodes(stateNode: AnyStateNode): Set<AnyStateNode>;
/**
 * Returns the relative state node from the given `statePath`, or throws.
 *
 * @param statePath The string or string array relative path to the state node.
 */
export declare function getStateNodeByPath(stateNode: AnyStateNode, statePath: string | string[]): AnyStateNode;
/**
 * Returns the state nodes represented by the current state value.
 *
 * @param stateValue The state value or State instance
 */
export declare function getStateNodes(stateNode: AnyStateNode, stateValue: StateValue): Array<AnyStateNode>;
export declare function transitionNode<TContext extends MachineContext, TEvent extends EventObject>(stateNode: AnyStateNode, stateValue: StateValue, snapshot: MachineSnapshot<TContext, TEvent, any, any, any, any, any, any>, event: TEvent): Array<TransitionDefinition<TContext, TEvent>> | undefined;
/** https://www.w3.org/TR/scxml/#microstepProcedure */
export declare function microstep(transitions: Array<AnyTransitionDefinition>, currentSnapshot: AnyMachineSnapshot, actorScope: AnyActorScope, event: AnyEventObject, isInitial: boolean, internalQueue: Array<AnyEventObject>): AnyMachineSnapshot;
export interface BuiltinAction {
    (): void;
    type: `xstate.${string}`;
    resolve: (actorScope: AnyActorScope, snapshot: AnyMachineSnapshot, actionArgs: ActionArgs<any, any, any>, actionParams: ParameterizedObject['params'] | undefined, action: unknown, extra: unknown) => [
        newState: AnyMachineSnapshot,
        params: unknown,
        actions?: UnknownAction[]
    ];
    retryResolve: (actorScope: AnyActorScope, snapshot: AnyMachineSnapshot, params: unknown) => void;
    execute: (actorScope: AnyActorScope, params: unknown) => void;
}
export declare function resolveActionsAndContext(currentSnapshot: AnyMachineSnapshot, event: AnyEventObject, actorScope: AnyActorScope, actions: UnknownAction[], internalQueue: AnyEventObject[], deferredActorIds: string[] | undefined): AnyMachineSnapshot;
export declare function macrostep(snapshot: AnyMachineSnapshot, event: EventObject, actorScope: AnyActorScope, internalQueue: AnyEventObject[]): {
    snapshot: typeof snapshot;
    microstates: Array<typeof snapshot>;
};
/**
 * Resolves a partial state value with its full representation in the state
 * node's machine.
 *
 * @param stateValue The partial state value to resolve.
 */
export declare function resolveStateValue(rootNode: AnyStateNode, stateValue: StateValue): StateValue;
export {};
