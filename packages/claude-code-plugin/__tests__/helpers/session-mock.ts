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
 * both `get` and `set` mocks read/write it on each call.
 */
const stateByMock = new WeakMap<SessionMock, Map<keyof SessionState, unknown>>();

/**
 * Create a typed pair of Session get/set mocks backed by per-mock state.
 *
 * Semantics (see `get`/`set` for details):
 * - `get(key)` throws if `key` was never seeded via `initialState`, `setGet`,
 *   or a prior `set`. This is deliberate: the real `Session#get` returns
 *   strongly-typed values, and silently returning `undefined` from a mock
 *   launders the type system. Tests must seed keys they read.
 * - `set(key, value)` persists into the internal state map so a subsequent
 *   `get(key)` returns the value. Mirrors `Session#set` in `src/session.ts`.
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
    if (!state.has(key)) {
      throw new Error(
        `SessionMock: key '${key}' not configured — call setGet(mock, '${key}', …) or seed via createSessionMock({ ${key}: … }) first`,
      );
    }
    return state.get(key) as SessionState[K];
  }) as unknown as SessionGetMock;

  const set = jest.fn(async <K extends keyof SessionState>(key: K, value: SessionState[K]) => {
    state.set(key, value);
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
 * @throws {Error} If the mock was not produced by `createSessionMock`
 *   (foreign mock) or the mock's state has already been garbage-collected.
 */
export function setGet<K extends keyof SessionState>(
  mock: SessionMock,
  key: K,
  value: SessionState[K],
): void {
  const state = stateByMock.get(mock);
  if (!state) {
    throw new Error(
      'setGet: mock not registered (either foreign mock or already garbage-collected)',
    );
  }
  state.set(key, value);
}
