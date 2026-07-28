import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isError } from '../../../src/errors.js';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';

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

const mockedSqljsOpen = openSqljsDriver as jest.MockedFunction<typeof openSqljsDriver>;
const mockedNativeOpen = openNativeDriver as jest.MockedFunction<typeof openNativeDriver>;

beforeEach(() => {
  mockedSqljsOpen.mockReset();
  mockedNativeOpen.mockReset();
});

describe('openRunbookDriver sql.js startup failure', () => {
  it.each([
    new Error('wasm failed to load'),
    'bare string init failure',
  ])('wraps %p as a typed hard startup refusal without a native fallback', async (failure) => {
    mockedSqljsOpen.mockRejectedValue(failure);

    const rejection = await openRunbookDriver('/tmp/does-not-matter.db', {
      runtime: 'sqljs',
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(SqljsUnavailableError);
    expect((rejection as Error).name).toBe('SqljsUnavailableError');
    expect((rejection as Error).message).toContain(isError(failure) ? failure.message : failure);
    expect((rejection as Error).cause).toBe(failure);
    expect(mockedNativeOpen).not.toHaveBeenCalled();
  });
});

describe.each([
  'native',
  'sqljs',
] as const)('openRunbookDriver %s schema initialization failure', (runtime) => {
  it.each([
    false,
    true,
  ])('disposes the driver without masking the schema error', async (failClose) => {
    const schemaError = new Error('incompatible schema');
    const dispose = jest
      .fn<() => Promise<void>>()
      .mockImplementation(() =>
        failClose ? Promise.reject(new Error('close failed')) : Promise.resolve(),
      );
    const driver = {
      immediate: jest.fn<SqlDriver['immediate']>().mockRejectedValue(schemaError),
      [Symbol.asyncDispose]: dispose,
    } as unknown as SqlDriver;
    if (runtime === 'native') {
      mockedNativeOpen.mockReturnValue(driver as ReturnType<typeof openNativeDriver>);
    } else {
      mockedSqljsOpen.mockResolvedValue(driver as Awaited<ReturnType<typeof openSqljsDriver>>);
    }

    await expect(openRunbookDriver('/tmp/does-not-matter.db', { runtime })).rejects.toBe(
      schemaError,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
