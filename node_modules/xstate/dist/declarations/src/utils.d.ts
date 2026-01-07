import type { StateNode } from "./StateNode.js";
import type { AnyActorRef, AnyEventObject, AnyMachineSnapshot, AnyStateMachine, AnyTransitionConfig, ErrorActorEvent, EventObject, MachineContext, Mapper, NonReducibleUnknown, Observer, SingleOrArray, StateValue, TransitionConfigTarget } from "./types.js";
export declare function matchesState(parentStateId: StateValue, childStateId: StateValue): boolean;
export declare function toStatePath(stateId: string | string[]): string[];
export declare function pathToStateValue(statePath: string[]): StateValue;
export declare function mapValues<P, O extends Record<string, unknown>>(collection: O, iteratee: (item: O[keyof O], key: keyof O, collection: O, i: number) => P): {
    [key in keyof O]: P;
};
export declare function toArray<T>(value: readonly T[] | T | undefined): readonly T[];
export declare function resolveOutput<TContext extends MachineContext, TExpressionEvent extends EventObject>(mapper: Mapper<TContext, TExpressionEvent, unknown, EventObject> | NonReducibleUnknown, context: TContext, event: TExpressionEvent, self: AnyActorRef): unknown;
export declare function isErrorActorEvent(event: AnyEventObject): event is ErrorActorEvent;
export declare function toTransitionConfigArray(configLike: SingleOrArray<AnyTransitionConfig | TransitionConfigTarget>): Array<AnyTransitionConfig>;
export declare function normalizeTarget<TContext extends MachineContext, TEvent extends EventObject>(target: SingleOrArray<string | StateNode<TContext, TEvent>> | undefined): ReadonlyArray<string | StateNode<TContext, TEvent>> | undefined;
export declare function toObserver<T>(nextHandler?: Observer<T> | ((value: T) => void), errorHandler?: (error: any) => void, completionHandler?: () => void): Observer<T>;
export declare function createInvokeId(stateNodeId: string, index: number): string;
export declare function resolveReferencedActor(machine: AnyStateMachine, src: string): any;
export declare function getAllOwnEventDescriptors(snapshot: AnyMachineSnapshot): any[];
/**
 * Checks if an event type matches an event descriptor, supporting wildcards.
 * Event descriptors can be:
 *
 * - Exact matches: "event.type"
 * - Wildcard: "*"
 * - Partial matches: "event.*"
 *
 * @param eventType - The actual event type string
 * @param descriptor - The event descriptor to match against
 * @returns True if the event type matches the descriptor
 */
export declare function matchesEventDescriptor(eventType: string, descriptor: string): boolean;
