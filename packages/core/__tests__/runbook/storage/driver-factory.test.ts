import { beforeEach, describe, it, expect, jest } from '@jest/globals';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';

// Mock the sql.js driver module so an initialization failure can be forced and
// the factory's hard-startup-failure wrapping observed in isolation. Native and
// schema modules stay real.
jest.unstable_mockModule('../../../src/runbook/storage/sqljs-driver.js', () => ({
  openSqljsDriver: jest.fn(),
}));
jest.unstable_mockModule('../../../src/runbook/storage/native-sqlite-driver.js', () => ({
  openNativeDriver: jest.fn(),
}));

const { openSqljsDriver } = await import('../../../src/runbook/storage/sqljs-driver.js');
const { openNativeDriver } = await import('../../../src/runbook/storage/native-sqlite-driver.js');
const { openRunbookDriver, SqljsUnavailableError } = await import(
  '../../../src/runbook/storage/driver-factory.js'
);

const mockedOpen = openSqljsDriver as jest.MockedFunction<typeof openSqljsDriver>;
const mockedNativeOpen = openNativeDriver as jest.MockedFunction<typeof openNativeDriver>;

beforeEach(() => {
  mockedOpen.mockReset();
  mockedNativeOpen.mockReset();
});

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

describe.each([
  'native',
  'sqljs',
] as const)('openRunbookDriver %s schema initialization failure', (runtime) => {
  it('disposes the opened driver and rethrows the original schema error', async () => {
    const schemaError = new Error('incompatible schema');
    const dispose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const driver = {
      immediate: jest.fn<SqlDriver['immediate']>().mockRejectedValue(schemaError),
      [Symbol.asyncDispose]: dispose,
    } as unknown as SqlDriver;
    if (runtime === 'native') {
      mockedNativeOpen.mockReturnValue(driver as ReturnType<typeof openNativeDriver>);
    } else {
      mockedOpen.mockResolvedValue(driver as Awaited<ReturnType<typeof openSqljsDriver>>);
    }

    await expect(openRunbookDriver('/tmp/does-not-matter.db', { runtime })).rejects.toBe(
      schemaError,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not let disposal failure mask the schema error', async () => {
    const schemaError = new Error('corrupt schema');
    const dispose = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('close failed'));
    const driver = {
      immediate: jest.fn<SqlDriver['immediate']>().mockRejectedValue(schemaError),
      [Symbol.asyncDispose]: dispose,
    } as unknown as SqlDriver;
    if (runtime === 'native') {
      mockedNativeOpen.mockReturnValue(driver as ReturnType<typeof openNativeDriver>);
    } else {
      mockedOpen.mockResolvedValue(driver as Awaited<ReturnType<typeof openSqljsDriver>>);
    }

    await expect(openRunbookDriver('/tmp/does-not-matter.db', { runtime })).rejects.toBe(
      schemaError,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
