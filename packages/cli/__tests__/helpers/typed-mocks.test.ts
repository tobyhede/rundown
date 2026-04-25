import { describe, expect, it } from '@jest/globals';
import { mockFn } from './typed-mocks.js';

describe('mockFn', () => {
  it('infers parameter and return types from the signature', () => {
    const greet = mockFn<(name: string) => string>();
    greet.mockReturnValue('hello world');

    const result = greet('world');

    expect(result).toBe('hello world');
    expect(greet).toHaveBeenCalledWith('world');
  });

  it('mirrors an existing function signature via typeof', () => {
    function add(a: number, b: number): number {
      return a + b;
    }

    const mockAdd = mockFn<typeof add>();
    mockAdd.mockReturnValue(42);

    expect(mockAdd(1, 2)).toBe(42);
    expect(mockAdd).toHaveBeenCalledWith(1, 2);
  });

  it('rejects argument-type drift at the call site', () => {
    const greet = mockFn<(name: string) => string>();
    greet.mockReturnValue('ok');

    // @ts-expect-error — argument must be a string, not a number
    greet(42);

    // Runtime call still happens; the directive only asserts the type error.
    expect(greet).toHaveBeenCalled();
  });
});
