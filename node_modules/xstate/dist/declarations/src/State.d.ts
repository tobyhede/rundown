import type { StateNode } from "./StateNode.js";
import type { StateMachine } from "./StateMachine.js";
import type { ProvidedActor, AnyMachineSnapshot, AnyStateMachine, EventObject, HistoryValue, MachineContext, StateConfig, StateValue, AnyActorRef, Snapshot, ParameterizedObject, IsNever, MetaObject, StateSchema, StateId, SnapshotStatus } from "./types.js";
type ToTestStateValue<TStateValue extends StateValue> = TStateValue extends string ? TStateValue : IsNever<keyof TStateValue> extends true ? never : keyof TStateValue | {
    [K in keyof TStateValue]?: ToTestStateValue<NonNullable<TStateValue[K]>>;
};
export declare function isMachineSnapshot(value: unknown): value is AnyMachineSnapshot;
interface MachineSnapshotBase<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta, TStateSchema extends StateSchema = StateSchema> {
    /** The state machine that produced this state snapshot. */
    machine: StateMachine<TContext, TEvent, TChildren, ProvidedActor, ParameterizedObject, ParameterizedObject, string, TStateValue, TTag, unknown, TOutput, EventObject, // TEmitted
    any, // TMeta
    TStateSchema>;
    /** The tags of the active state nodes that represent the current state value. */
    tags: Set<string>;
    /**
     * The current state value.
     *
     * This represents the active state nodes in the state machine.
     *
     * - For atomic state nodes, it is a string.
     * - For compound parent state nodes, it is an object where:
     *
     *   - The key is the parent state node's key
     *   - The value is the current state value of the active child state node(s)
     *
     * @example
     *
     * ```ts
     * // single-level state node
     * snapshot.value; // => 'yellow'
     *
     * // nested state nodes
     * snapshot.value; // => { red: 'wait' }
     * ```
     */
    value: TStateValue;
    /** The current status of this snapshot. */
    status: SnapshotStatus;
    error: unknown;
    context: TContext;
    historyValue: Readonly<HistoryValue<TContext, TEvent>>;
    /** The enabled state nodes representative of the state value. */
    _nodes: Array<StateNode<TContext, TEvent>>;
    /** An object mapping actor names to spawned/invoked actors. */
    children: TChildren;
    /**
     * Whether the current state value is a subset of the given partial state
     * value.
     *
     * @param partialStateValue
     */
    matches: (partialStateValue: ToTestStateValue<TStateValue>) => boolean;
    /**
     * Whether the current state nodes has a state node with the specified `tag`.
     *
     * @param tag
     */
    hasTag: (tag: TTag) => boolean;
    /**
     * Determines whether sending the `event` will cause a non-forbidden
     * transition to be selected, even if the transitions have no actions nor
     * change the state value.
     *
     * @param event The event to test
     * @returns Whether the event will cause a transition
     */
    can: (event: TEvent) => boolean;
    getMeta: () => Record<StateId<TStateSchema> & string, TMeta | undefined>;
    toJSON: () => unknown;
}
interface ActiveMachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject, TStateSchema extends StateSchema> extends MachineSnapshotBase<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> {
    status: 'active';
    output: undefined;
    error: undefined;
}
interface DoneMachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject, TStateSchema extends StateSchema> extends MachineSnapshotBase<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> {
    status: 'done';
    output: TOutput;
    error: undefined;
}
interface ErrorMachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject, TStateSchema extends StateSchema> extends MachineSnapshotBase<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> {
    status: 'error';
    output: undefined;
    error: unknown;
}
interface StoppedMachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject, TStateSchema extends StateSchema> extends MachineSnapshotBase<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> {
    status: 'stopped';
    output: undefined;
    error: undefined;
}
export type MachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject, TStateSchema extends StateSchema> = ActiveMachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> | DoneMachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> | ErrorMachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema> | StoppedMachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>;
export declare function createMachineSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TMeta extends MetaObject, TStateSchema extends StateSchema>(config: StateConfig<TContext, TEvent>, machine: AnyStateMachine): MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, undefined, TMeta, TStateSchema>;
export declare function cloneMachineSnapshot<TState extends AnyMachineSnapshot>(snapshot: TState, config?: Partial<StateConfig<any, any>>): TState;
export declare function getPersistedSnapshot<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TStateValue extends StateValue, TTag extends string, TOutput, TMeta extends MetaObject>(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, any>, options?: unknown): Snapshot<unknown>;
export {};
