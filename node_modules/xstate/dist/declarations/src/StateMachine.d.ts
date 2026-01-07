import { MachineSnapshot } from "./State.js";
import { StateNode } from "./StateNode.js";
import { AnyActorSystem } from "./system.js";
import type { ActorLogic, ActorScope, AnyActorRef, AnyActorScope, DoNotInfer, Equals, EventDescriptor, EventObject, HistoryValue, InternalMachineImplementations, MachineConfig, MachineContext, MachineImplementationsSimplified, MetaObject, ParameterizedObject, ProvidedActor, Snapshot, StateMachineDefinition, StateValue, TransitionDefinition, ResolvedStateMachineTypes, StateSchema, SnapshotStatus } from "./types.js";
export declare class StateMachine<TContext extends MachineContext, TEvent extends EventObject, TChildren extends Record<string, AnyActorRef | undefined>, TActor extends ProvidedActor, TAction extends ParameterizedObject, TGuard extends ParameterizedObject, TDelay extends string, TStateValue extends StateValue, TTag extends string, TInput, TOutput, TEmitted extends EventObject, TMeta extends MetaObject, TStateSchema extends StateSchema> implements ActorLogic<MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, TEvent, TInput, AnyActorSystem, TEmitted> {
    /** The raw config used to create the machine. */
    config: MachineConfig<TContext, TEvent, any, any, any, any, any, any, TOutput, any, // TEmitted
    any> & {
        schemas?: unknown;
    };
    /** The machine's own version. */
    version?: string;
    schemas: unknown;
    implementations: MachineImplementationsSimplified<TContext, TEvent>;
    root: StateNode<TContext, TEvent>;
    id: string;
    states: StateNode<TContext, TEvent>['states'];
    events: Array<EventDescriptor<TEvent>>;
    constructor(
    /** The raw config used to create the machine. */
    config: MachineConfig<TContext, TEvent, any, any, any, any, any, any, TOutput, any, // TEmitted
    any> & {
        schemas?: unknown;
    }, implementations?: MachineImplementationsSimplified<TContext, TEvent>);
    /**
     * Clones this state machine with the provided implementations.
     *
     * @param implementations Options (`actions`, `guards`, `actors`, `delays`) to
     *   recursively merge with the existing options.
     * @returns A new `StateMachine` instance with the provided implementations.
     */
    provide(implementations: InternalMachineImplementations<ResolvedStateMachineTypes<TContext, DoNotInfer<TEvent>, TActor, TAction, TGuard, TDelay, TTag, TEmitted>>): StateMachine<TContext, TEvent, TChildren, TActor, TAction, TGuard, TDelay, TStateValue, TTag, TInput, TOutput, TEmitted, TMeta, TStateSchema>;
    resolveState(config: {
        value: StateValue;
        context?: TContext;
        historyValue?: HistoryValue<TContext, TEvent>;
        status?: SnapshotStatus;
        output?: TOutput;
        error?: unknown;
    } & (Equals<TContext, MachineContext> extends false ? {
        context: unknown;
    } : {})): MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>;
    /**
     * Determines the next snapshot given the current `snapshot` and received
     * `event`. Calculates a full macrostep from all microsteps.
     *
     * @param snapshot The current snapshot
     * @param event The received event
     */
    transition(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, event: TEvent, actorScope: ActorScope<typeof snapshot, TEvent, AnyActorSystem, TEmitted>): MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>;
    /**
     * Determines the next state given the current `state` and `event`. Calculates
     * a microstep.
     *
     * @param state The current state
     * @param event The received event
     */
    microstep(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, event: TEvent, actorScope: AnyActorScope): Array<MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>>;
    getTransitionData(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, event: TEvent): Array<TransitionDefinition<TContext, TEvent>>;
    /**
     * The initial state _before_ evaluating any microsteps. This "pre-initial"
     * state is provided to initial actions executed in the initial state.
     */
    private getPreInitialState;
    /**
     * Returns the initial `State` instance, with reference to `self` as an
     * `ActorRef`.
     */
    getInitialSnapshot(actorScope: ActorScope<MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, TEvent, AnyActorSystem, TEmitted>, input?: TInput): MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>;
    start(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>): void;
    getStateNodeById(stateId: string): StateNode<TContext, TEvent>;
    get definition(): StateMachineDefinition<TContext, TEvent>;
    toJSON(): StateMachineDefinition<TContext, TEvent>;
    getPersistedSnapshot(snapshot: MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, options?: unknown): Snapshot<unknown>;
    restoreSnapshot(snapshot: Snapshot<unknown>, _actorScope: ActorScope<MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>, TEvent, AnyActorSystem, TEmitted>): MachineSnapshot<TContext, TEvent, TChildren, TStateValue, TTag, TOutput, TMeta, TStateSchema>;
}
