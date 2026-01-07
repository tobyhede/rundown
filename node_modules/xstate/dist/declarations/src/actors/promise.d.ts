import { AnyActorSystem } from "../system.js";
import { ActorLogic, ActorRefFromLogic, EventObject, NonReducibleUnknown, Snapshot } from "../types.js";
export type PromiseSnapshot<TOutput, TInput> = Snapshot<TOutput> & {
    input: TInput | undefined;
};
export type PromiseActorLogic<TOutput, TInput = unknown, TEmitted extends EventObject = EventObject> = ActorLogic<PromiseSnapshot<TOutput, TInput>, {
    type: string;
    [k: string]: unknown;
}, TInput, // input
AnyActorSystem, TEmitted>;
/**
 * Represents an actor created by `fromPromise`.
 *
 * The type of `self` within the actor's logic.
 *
 * @example
 *
 * ```ts
 * import { fromPromise, createActor } from 'xstate';
 *
 * // The actor's resolved output
 * type Output = string;
 * // The actor's input.
 * type Input = { message: string };
 *
 * // Actor logic that fetches the url of an image of a cat saying `input.message`.
 * const logic = fromPromise<Output, Input>(async ({ input, self }) => {
 *   self;
 *   // ^? PromiseActorRef<Output, Input>
 *
 *   const data = await fetch(
 *     `https://cataas.com/cat/says/${input.message}`
 *   );
 *   const url = await data.json();
 *   return url;
 * });
 *
 * const actor = createActor(logic, { input: { message: 'hello world' } });
 * //    ^? PromiseActorRef<Output, Input>
 * ```
 *
 * @see {@link fromPromise}
 */
export type PromiseActorRef<TOutput> = ActorRefFromLogic<PromiseActorLogic<TOutput, unknown>>;
/**
 * An actor logic creator which returns promise logic as defined by an async
 * process that resolves or rejects after some time.
 *
 * Actors created from promise actor logic (“promise actors”) can:
 *
 * - Emit the resolved value of the promise
 * - Output the resolved value of the promise
 *
 * Sending events to promise actors will have no effect.
 *
 * @example
 *
 * ```ts
 * const promiseLogic = fromPromise(async () => {
 *   const result = await fetch('https://example.com/...').then((data) =>
 *     data.json()
 *   );
 *
 *   return result;
 * });
 *
 * const promiseActor = createActor(promiseLogic);
 * promiseActor.subscribe((snapshot) => {
 *   console.log(snapshot);
 * });
 * promiseActor.start();
 * // => {
 * //   output: undefined,
 * //   status: 'active'
 * //   ...
 * // }
 *
 * // After promise resolves
 * // => {
 * //   output: { ... },
 * //   status: 'done',
 * //   ...
 * // }
 * ```
 *
 * @param promiseCreator A function which returns a Promise, and accepts an
 *   object with the following properties:
 *
 *   - `input` - Data that was provided to the promise actor
 *   - `self` - The parent actor of the promise actor
 *   - `system` - The actor system to which the promise actor belongs
 *
 * @see {@link https://stately.ai/docs/input | Input docs} for more information about how input is passed
 */
export declare function fromPromise<TOutput, TInput = NonReducibleUnknown, TEmitted extends EventObject = EventObject>(promiseCreator: ({ input, system, self, signal, emit }: {
    /** Data that was provided to the promise actor */
    input: TInput;
    /** The actor system to which the promise actor belongs */
    system: AnyActorSystem;
    /** The parent actor of the promise actor */
    self: PromiseActorRef<TOutput>;
    signal: AbortSignal;
    emit: (emitted: TEmitted) => void;
}) => PromiseLike<TOutput>): PromiseActorLogic<TOutput, TInput, TEmitted>;
