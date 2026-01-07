import { AnyActorSystem } from "../system.js";
import { ActorLogic, ActorRefFromLogic, AnyEventObject, EventObject, NonReducibleUnknown, Snapshot } from "../types.js";
export type CallbackSnapshot<TInput> = Snapshot<undefined> & {
    input: TInput;
};
export type CallbackActorLogic<TEvent extends EventObject, TInput = NonReducibleUnknown, TEmitted extends EventObject = EventObject> = ActorLogic<CallbackSnapshot<TInput>, TEvent, TInput, AnyActorSystem, TEmitted>;
/**
 * Represents an actor created by `fromCallback`.
 *
 * The type of `self` within the actor's logic.
 *
 * @example
 *
 * ```ts
 * import { fromCallback, createActor } from 'xstate';
 *
 * // The events the actor receives.
 * type Event = { type: 'someEvent' };
 * // The actor's input.
 * type Input = { name: string };
 *
 * // Actor logic that logs whenever it receives an event of type `someEvent`.
 * const logic = fromCallback<Event, Input>(({ self, input, receive }) => {
 *   self;
 *   // ^? CallbackActorRef<Event, Input>
 *
 *   receive((event) => {
 *     if (event.type === 'someEvent') {
 *       console.log(`${input.name}: received "someEvent" event`);
 *       // logs 'myActor: received "someEvent" event'
 *     }
 *   });
 * });
 *
 * const actor = createActor(logic, { input: { name: 'myActor' } });
 * //    ^? CallbackActorRef<Event, Input>
 * ```
 *
 * @see {@link fromCallback}
 */
export type CallbackActorRef<TEvent extends EventObject, TInput = NonReducibleUnknown> = ActorRefFromLogic<CallbackActorLogic<TEvent, TInput>>;
type Receiver<TEvent extends EventObject> = (listener: {
    bivarianceHack(event: TEvent): void;
}['bivarianceHack']) => void;
export type CallbackLogicFunction<TEvent extends EventObject = AnyEventObject, TSentEvent extends EventObject = AnyEventObject, TInput = NonReducibleUnknown, TEmitted extends EventObject = EventObject> = ({ input, system, self, sendBack, receive, emit }: {
    /**
     * Data that was provided to the callback actor
     *
     * @see {@link https://stately.ai/docs/input | Input docs}
     */
    input: TInput;
    /** The actor system to which the callback actor belongs */
    system: AnyActorSystem;
    /** The parent actor of the callback actor */
    self: CallbackActorRef<TEvent>;
    /** A function that can send events back to the parent actor */
    sendBack: (event: TSentEvent) => void;
    /**
     * A function that can be called with a listener function argument; the
     * listener is then called whenever events are received by the callback actor
     */
    receive: Receiver<TEvent>;
    emit: (emitted: TEmitted) => void;
}) => (() => void) | void;
/**
 * An actor logic creator which returns callback logic as defined by a callback
 * function.
 *
 * @remarks
 * Useful for subscription-based or other free-form logic that can send events
 * back to the parent actor.
 *
 * Actors created from callback logic (“callback actors”) can:
 *
 * - Receive events via the `receive` function
 * - Send events to the parent actor via the `sendBack` function
 *
 * Callback actors are a bit different from other actors in that they:
 *
 * - Do not work with `onDone`
 * - Do not produce a snapshot using `.getSnapshot()`
 * - Do not emit values when used with `.subscribe()`
 * - Can not be stopped with `.stop()`
 *
 * @example
 *
 * ```typescript
 * const callbackLogic = fromCallback(({ sendBack, receive }) => {
 *   let lockStatus = 'unlocked';
 *
 *   const handler = (event) => {
 *     if (lockStatus === 'locked') {
 *       return;
 *     }
 *     sendBack(event);
 *   };
 *
 *   receive((event) => {
 *     if (event.type === 'lock') {
 *       lockStatus = 'locked';
 *     } else if (event.type === 'unlock') {
 *       lockStatus = 'unlocked';
 *     }
 *   });
 *
 *   document.body.addEventListener('click', handler);
 *
 *   return () => {
 *     document.body.removeEventListener('click', handler);
 *   };
 * });
 * ```
 *
 * @param callback - The callback function used to describe the callback logic
 *   The callback function is passed an object with the following properties:
 *
 *   - `receive` - A function that can send events back to the parent actor; the
 *       listener is then called whenever events are received by the callback
 *       actor
 *   - `sendBack` - A function that can send events back to the parent actor
 *   - `input` - Data that was provided to the callback actor
 *   - `self` - The parent actor of the callback actor
 *   - `system` - The actor system to which the callback actor belongs The callback
 *       function can (optionally) return a cleanup function, which is called
 *       when the actor is stopped.
 *
 * @returns Callback logic
 * @see {@link CallbackLogicFunction} for more information about the callback function and its object argument
 * @see {@link https://stately.ai/docs/input | Input docs} for more information about how input is passed
 */
export declare function fromCallback<TEvent extends EventObject, TInput = NonReducibleUnknown, TEmitted extends EventObject = EventObject>(callback: CallbackLogicFunction<TEvent, AnyEventObject, TInput, TEmitted>): CallbackActorLogic<TEvent, TInput, TEmitted>;
export {};
