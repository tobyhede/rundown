/**
 * Shared mock implementations for @rundown-org/core error utility functions.
 * Spread into jest.unstable_mockModule('@rundown-org/core', ...) blocks.
 *
 * Mocks intentionally use `instanceof Error` rather than the real polyfilled
 * helpers — a mock should not depend on the module it's mocking.
 */
export const mockErrorHelpers = {
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  isNodeError: (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string',
  isError: (error: unknown) => error instanceof Error,
};
