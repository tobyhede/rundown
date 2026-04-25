import { jest } from '@jest/globals';
import type { FunctionLike } from 'jest-mock';

/**
 * Create a typed `jest.fn()` mock matching the signature `T`.
 *
 * Thin wrapper around `jest.fn<T>()` that enforces a signature at the call
 * site. Replaces the `jest.fn<any>()` widening that previously kept
 * `tsc --noEmit -p tsconfig.test.json` green at the cost of disabling
 * argument-type and return-type checking on every mock invocation.
 *
 * Use `mockFn<typeof realFn>()` to mirror an existing function's signature,
 * or `mockFn<(arg: T) => R>()` for ad-hoc shapes. For modules mocked via
 * `jest.mock(...)` use Jest's native `jest.mocked(realFn)` cast at the
 * import site instead — this helper is for fresh mocks only.
 *
 * @typeParam T - The function signature the returned mock must satisfy.
 * @returns A `jest.Mock<T>` that type-checks calls against `T`.
 *
 * @example
 * ```ts
 * const greet = mockFn<(name: string) => string>();
 * greet.mockReturnValue('hi');
 * greet('world');     // OK
 * // @ts-expect-error — argument must be a string
 * greet(42);
 * ```
 */
export function mockFn<T extends FunctionLike>(): jest.Mock<T> {
  return jest.fn<T>();
}
