// __tests__/helpers/session-mock.ts
// Typed mock factory for Session (matches packages/claude-code-plugin/src/session.ts).

import { jest } from '@jest/globals';
import type { Session } from '../../src/session.js';
import type { SessionState } from '../../src/shared/index.js';

/** Mock of Session#get. Generic key→value mapping is restored via `setGet`. */
export type SessionGetMock = jest.MockedFunction<Session['get']>;

/** Mock of Session#set. */
export type SessionSetMock = jest.MockedFunction<Session['set']>;

export interface SessionMock {
  get: SessionGetMock;
  set: SessionSetMock;
}

/**
 * Create a typed pair of Session get/set mocks.
 *
 * The returned mocks have correct generic signatures. Use `setGet(mock, key, value)`
 * to configure per-key return values with full type safety.
 *
 * @param initialState - Optional map of keys to initial values; `get(key)` returns
 *   `initialState[key]` if present, else `undefined` (cast to the key's value type).
 * @returns A SessionMock with typed `get` and `set` jest mocks.
 */
export function createSessionMock(initialState: Partial<SessionState> = {}): SessionMock {
  const get = jest.fn(async <K extends keyof SessionState>(key: K) => {
    return initialState[key] as SessionState[K];
  }) as unknown as SessionGetMock;

  const set = jest.fn(async () => {
    /* no-op */
  }) as unknown as SessionSetMock;

  return { get, set };
}

/**
 * Configure a session mock to return `value` when `get` is called with `key`.
 *
 * Preserves per-key type strictness — `value` must match `SessionState[K]` for
 * the supplied `K`. Replaces any prior implementation on `mock.get`; calls with
 * other keys return `undefined`. Callers that need multi-key behaviour should
 * seed via `createSessionMock(initialState)` instead.
 *
 * @param mock - SessionMock created by `createSessionMock`.
 * @param key - The `SessionState` key to match.
 * @param value - The value to return; type-constrained to `SessionState[K]`.
 */
export function setGet<K extends keyof SessionState>(
  mock: SessionMock,
  key: K,
  value: SessionState[K],
): void {
  mock.get.mockImplementation(async (k) => {
    if ((k as keyof SessionState) === key) return value as SessionState[typeof k];
    // Unreachable for tests that only call `get` with the configured key.
    return undefined as never;
  });
}
