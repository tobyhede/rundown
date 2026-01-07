import { AnyActorRef, SnapshotFrom } from "./types.js";
interface WaitForOptions {
    /**
     * How long to wait before rejecting, if no emitted state satisfies the
     * predicate.
     *
     * @defaultValue Infinity
     */
    timeout: number;
    /** A signal which stops waiting when aborted. */
    signal?: AbortSignal;
}
/**
 * Subscribes to an actor ref and waits for its emitted value to satisfy a
 * predicate, and then resolves with that value. Will throw if the desired state
 * is not reached after an optional timeout. (defaults to Infinity).
 *
 * @example
 *
 * ```js
 * const state = await waitFor(someService, (state) => {
 *   return state.hasTag('loaded');
 * });
 *
 * state.hasTag('loaded'); // true
 * ```
 *
 * @param actorRef The actor ref to subscribe to
 * @param predicate Determines if a value matches the condition to wait for
 * @param options
 * @returns A promise that eventually resolves to the emitted value that matches
 *   the condition
 */
export declare function waitFor<TActorRef extends AnyActorRef>(actorRef: TActorRef, predicate: (emitted: SnapshotFrom<TActorRef>) => boolean, options?: Partial<WaitForOptions>): Promise<SnapshotFrom<TActorRef>>;
export {};
