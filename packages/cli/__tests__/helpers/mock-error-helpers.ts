/**
 * Shared mock implementations for @rundown-org/core error utility functions.
 * Spread into jest.unstable_mockModule('@rundown-org/core', ...) blocks.
 */
export const mockErrorHelpers = {
  getErrorMessage: (error: unknown) => (Error.isError(error) ? error.message : String(error)),
  isNodeError: (error: unknown) =>
    Error.isError(error) &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string',
  isError: (error: unknown) => Error.isError(error),
};
