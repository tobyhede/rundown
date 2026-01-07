import { symbolObservable } from "./symbolObservable.js";
import { AnyActorSystem, Clock } from "./system.js";
export declare let executingCustomAction: boolean;
import type { AnyActorLogic, AnyActorRef, ConditionalRequired, EmittedFrom, EventFromLogic, InputFrom, IsNotNever, Snapshot, SnapshotFrom } from "./types.js";
import { ActorOptions, ActorRef, InteropSubscribable, Observer, Subscription } from "./types.js";
export declare const $$ACTOR_TYPE = 1;
export declare enum ProcessingStatus {
    NotStarted = 0,
    Running = 1,
    Stopped = 2
}
/**
 * An Actor is a running process that can receive events, send events and change
 * its behavior based on the events it receives, which can cause effects outside
 * of the actor. When you run a state machine, it becomes an actor.
 */
export declare class Actor<TLogic extends AnyActorLogic> implements ActorRef<SnapshotFrom<TLogic>, EventFromLogic<TLogic>, EmittedFrom<TLogic>> {
    logic: TLogic;
    /** The current internal state of the actor. */
    private _snapshot;
    /**
     * The clock that is responsible for setting and clearing timeouts, such as
     * delayed events and transitions.
     */
    clock: Clock;
    options: Readonly<ActorOptions<TLogic>>;
    /** The unique identifier for this actor relative to its parent. */
    id: string;
    private mailbox;
    private observers;
    private eventListeners;
    private logger;
    _parent?: AnyActorRef;
    ref: ActorRef<SnapshotFrom<TLogic>, EventFromLogic<TLogic>, EmittedFrom<TLogic>>;
    private _actorScope;
    systemId: string | undefined;
    /** The globally unique process ID for this invocation. */
    sessionId: string;
    /** The system to which this actor belongs. */
    system: AnyActorSystem;
    private _doneEvent?;
    src: string | AnyActorLogic;
    /**
     * Creates a new actor instance for the given logic with the provided options,
     * if any.
     *
     * @param logic The logic to create an actor from
     * @param options Actor options
     */
    constructor(logic: TLogic, options?: ActorOptions<TLogic>);
    private _initState;
    private _deferred;
    private update;
    /**
     * Subscribe an observer to an actor’s snapshot values.
     *
     * @remarks
     * The observer will receive the actor’s snapshot value when it is emitted.
     * The observer can be:
     *
     * - A plain function that receives the latest snapshot, or
     * - An observer object whose `.next(snapshot)` method receives the latest
     *   snapshot
     *
     * @example
     *
     * ```ts
     * // Observer as a plain function
     * const subscription = actor.subscribe((snapshot) => {
     *   console.log(snapshot);
     * });
     * ```
     *
     * @example
     *
     * ```ts
     * // Observer as an object
     * const subscription = actor.subscribe({
     *   next(snapshot) {
     *     console.log(snapshot);
     *   },
     *   error(err) {
     *     // ...
     *   },
     *   complete() {
     *     // ...
     *   }
     * });
     * ```
     *
     * The return value of `actor.subscribe(observer)` is a subscription object
     * that has an `.unsubscribe()` method. You can call
     * `subscription.unsubscribe()` to unsubscribe the observer:
     *
     * @example
     *
     * ```ts
     * const subscription = actor.subscribe((snapshot) => {
     *   // ...
     * });
     *
     * // Unsubscribe the observer
     * subscription.unsubscribe();
     * ```
     *
     * When the actor is stopped, all of its observers will automatically be
     * unsubscribed.
     *
     * @param observer - Either a plain function that receives the latest
     *   snapshot, or an observer object whose `.next(snapshot)` method receives
     *   the latest snapshot
     */
    subscribe(observer: Observer<SnapshotFrom<TLogic>>): Subscription;
    subscribe(nextListener?: (snapshot: SnapshotFrom<TLogic>) => void, errorListener?: (error: any) => void, completeListener?: () => void): Subscription;
    on<TType extends EmittedFrom<TLogic>['type'] | '*'>(type: TType, handler: (emitted: EmittedFrom<TLogic> & (TType extends '*' ? unknown : {
        type: TType;
    })) => void): Subscription;
    /** Starts the Actor from the initial state */
    start(): this;
    private _process;
    private _stop;
    /** Stops the Actor and unsubscribe all listeners. */
    stop(): this;
    private _complete;
    private _reportError;
    private _error;
    private _stopProcedure;
    /**
     * Sends an event to the running Actor to trigger a transition.
     *
     * @param event The event to send
     */
    send(event: EventFromLogic<TLogic>): void;
    private attachDevTools;
    toJSON(): {
        xstate$$type: number;
        id: string;
    };
    /**
     * Obtain the internal state of the actor, which can be persisted.
     *
     * @remarks
     * The internal state can be persisted from any actor, not only machines.
     *
     * Note that the persisted state is not the same as the snapshot from
     * {@link Actor.getSnapshot}. Persisted state represents the internal state of
     * the actor, while snapshots represent the actor's last emitted value.
     *
     * Can be restored with {@link ActorOptions.state}
     * @see https://stately.ai/docs/persistence
     */
    getPersistedSnapshot(): Snapshot<unknown>;
    [symbolObservable](): InteropSubscribable<SnapshotFrom<TLogic>>;
    /**
     * Read an actor’s snapshot synchronously.
     *
     * @remarks
     * The snapshot represent an actor's last emitted value.
     *
     * When an actor receives an event, its internal state may change. An actor
     * may emit a snapshot when a state transition occurs.
     *
     * Note that some actors, such as callback actors generated with
     * `fromCallback`, will not emit snapshots.
     * @see {@link Actor.subscribe} to subscribe to an actor’s snapshot values.
     * @see {@link Actor.getPersistedSnapshot} to persist the internal state of an actor (which is more than just a snapshot).
     */
    getSnapshot(): SnapshotFrom<TLogic>;
}
export type RequiredActorOptionsKeys<TLogic extends AnyActorLogic> = undefined extends InputFrom<TLogic> ? never : 'input';
/**
 * Creates a new actor instance for the given actor logic with the provided
 * options, if any.
 *
 * @remarks
 * When you create an actor from actor logic via `createActor(logic)`, you
 * implicitly create an actor system where the created actor is the root actor.
 * Any actors spawned from this root actor and its descendants are part of that
 * actor system.
 * @example
 *
 * ```ts
 * import { createActor } from 'xstate';
 * import { someActorLogic } from './someActorLogic.ts';
 *
 * // Creating the actor, which implicitly creates an actor system with itself as the root actor
 * const actor = createActor(someActorLogic);
 *
 * actor.subscribe((snapshot) => {
 *   console.log(snapshot);
 * });
 *
 * // Actors must be started by calling `actor.start()`, which will also start the actor system.
 * actor.start();
 *
 * // Actors can receive events
 * actor.send({ type: 'someEvent' });
 *
 * // You can stop root actors by calling `actor.stop()`, which will also stop the actor system and all actors in that system.
 * actor.stop();
 * ```
 *
 * @param logic - The actor logic to create an actor from. For a state machine
 *   actor logic creator, see {@link createMachine}. Other actor logic creators
 *   include {@link fromCallback}, {@link fromEventObservable},
 *   {@link fromObservable}, {@link fromPromise}, and {@link fromTransition}.
 * @param options - Actor options
 */
export declare function createActor<TLogic extends AnyActorLogic>(logic: TLogic, ...[options]: ConditionalRequired<[
    options?: ActorOptions<TLogic> & {
        [K in RequiredActorOptionsKeys<TLogic>]: unknown;
    }
], IsNotNever<RequiredActorOptionsKeys<TLogic>>>): Actor<TLogic>;
/**
 * Creates a new Interpreter instance for the given machine with the provided
 * options, if any.
 *
 * @deprecated Use `createActor` instead
 * @alias
 */
export declare const interpret: typeof createActor;
/**
 * @deprecated Use `Actor` instead.
 * @alias
 */
export type Interpreter = typeof Actor;
