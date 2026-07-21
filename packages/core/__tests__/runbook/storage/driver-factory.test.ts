import { describe, it, expect, jest } from '@jest/globals';

// Mock the sql.js driver module so an initialization failure can be forced and
// the factory's hard-startup-failure wrapping observed in isolation. Native and
// schema modules stay real.
jest.unstable_mockModule('../../../src/runbook/storage/sqljs-driver.js', () => ({
  openSqljsDriver: jest.fn(),
}));

const { openSqljsDriver } = await import('../../../src/runbook/storage/sqljs-driver.js');
const { openRunbookDriver, SqljsUnavailableError } = await import(
  '../../../src/runbook/storage/driver-factory.js'
);

const mockedOpen = openSqljsDriver as jest.MockedFunction<typeof openSqljsDriver>;

describe('openRunbookDriver sql.js startup failure', () => {
  it('wraps a raw sql.js initialization failure as a hard startup error', async () => {
    mockedOpen.mockRejectedValue(new Error('wasm failed to load'));

    const rejection = await openRunbookDriver('/tmp/does-not-matter.db', {
      runtime: 'sqljs',
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(SqljsUnavailableError);
    expect((rejection as Error).message).toContain('wasm failed to load');
  });

  it('normalizes a non-Error sql.js failure via getErrorMessage', async () => {
    mockedOpen.mockRejectedValue('bare string init failure');

    const rejection = await openRunbookDriver('/tmp/does-not-matter.db', {
      runtime: 'sqljs',
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(rejection).toBeInstanceOf(SqljsUnavailableError);
    expect((rejection as Error).message).toContain('bare string init failure');
  });
});
