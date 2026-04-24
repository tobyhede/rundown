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
 * Per-mock state map. `createSessionMock` seeds it; `setGet` mutates it;
 * the `get` mock implementation reads from it on each call.
 */
const stateByMock = new WeakMap<SessionMock, Map<keyof SessionState, unknown>>();

/**
 * Create a typed pair of Session get/set mocks backed by per-mock state.
 *
 * The returned `get` mock reads from an internal `Map` on each call. Use
 * `setGet(mock, key, value)` to set values post-creation; multiple calls
 * layer (each configures one key without dropping others).
 *
 * @param initialState - Optional map of keys to initial values.
 * @returns A SessionMock with typed `get` and `set` jest mocks.
 */
export function createSessionMock(initialState: Partial<SessionState> = {}): SessionMock {
  const state = new Map<keyof SessionState, unknown>(
    Object.entries(initialState) as [keyof SessionState, unknown][],
  );

  // `jest.fn(async <K>(key: K) => SessionState[K])` produces a generic mock
  // type that TS2352-rejects onto `jest.MockedFunction<Session['get']>`. The
  // `as unknown as` double-cast is the canonical escape hatch — isolated here
  // so call sites and `setGet` stay cast-free.
  const get = jest.fn(async <K extends keyof SessionState>(key: K) => {
    return state.get(key) as SessionState[K];
  }) as unknown as SessionGetMock;

  const set = jest.fn(async () => {
    /* no-op */
  }) as unknown as SessionSetMock;

  const mock: SessionMock = { get, set };
  stateByMock.set(mock, state);
  return mock;
}

/**
 * Configure a session mock to return `value` when `get` is called with `key`.
 *
 * Preserves per-key type strictness — `value` must match `SessionState[K]` for
 * the supplied `K`. Layers with any prior `setGet` / `initialState` entries:
 * other keys retain their previously configured values; only `key` is updated.
 *
 * @param mock - SessionMock created by `createSessionMock`.
 * @param key - The `SessionState` key to configure.
 * @param value - The value to return; type-constrained to `SessionState[K]`.
 * @throws {Error} If the mock was not produced by `createSessionMock`.
 */
export function setGet<K extends keyof SessionState>(
  mock: SessionMock,
  key: K,
  value: SessionState[K],
): void {
  const state = stateByMock.get(mock);
  if (!state) {
    throw new Error('setGet called on a SessionMock not produced by createSessionMock');
  }
  state.set(key, value);
}
