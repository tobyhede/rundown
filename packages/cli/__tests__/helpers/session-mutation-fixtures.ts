/**
 * Shared fixtures for core's guarded session-mutation results.
 *
 * `SessionMutationResult<T>` is an `Extract<>` alias over `GuardedMutationResult<T>`,
 * so its committed arm is defined once in core. Building that arm inline in each
 * suite lets the copies drift apart from core's definition — and from each other
 * — the moment the arm gains or renames a field. One factory here means a change
 * to the shape breaks compilation in one place rather than silently leaving some
 * suites asserting against a shape production no longer returns.
 */

import type { SessionMutationResult } from '@rundown-org/core';

/** The committed arm of core's guarded session result, carrying `T`. */
export type CommittedSessionMutation<T> = Extract<
  SessionMutationResult<T>,
  { readonly kind: 'committed' }
>;

/**
 * Build the committed arm of a guarded session mutation.
 *
 * @typeParam T - Value the mutation commits.
 * @param value - Committed value to carry.
 * @returns The committed arm wrapping `value`.
 */
export function committed<T>(value: T): CommittedSessionMutation<T> {
  return { kind: 'committed', value };
}
