import { expect } from '@jest/globals';

/**
 * Assert and narrow a discriminated union variant in tests.
 *
 * @param value - Union value to inspect
 * @param key - Discriminant property key
 * @param expected - Expected discriminant value
 */
export function assertVariant<
  T,
  K extends keyof T,
  V extends T[K] & (string | number | boolean | null | undefined),
>(value: T, key: K, expected: V): asserts value is Extract<T, Record<K, V>> {
  expect(value[key]).toBe(expected);
}
