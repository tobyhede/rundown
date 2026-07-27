import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SqlDriver } from '../../../src/runbook/storage/sql-driver.js';

const actualFsp = await import('node:fs/promises');
const chmodMock = jest.fn(actualFsp.chmod);
const openDriverMock = jest.fn<(dbPath: string) => Promise<SqlDriver>>();

jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsp,
  default: actualFsp,
  chmod: chmodMock,
}));
jest.unstable_mockModule('../../../src/runbook/storage/driver-factory.js', () => ({
  openRunbookDriver: openDriverMock,
}));

const { closeRunbookStores, getRunbookStore } = await import(
  '../../../src/runbook/storage/store-registry.js'
);

const roots: string[] = [];
let disposals: Array<jest.Mock<() => Promise<void>>>;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} from chmod`), { code });
}

function makeDriver(): SqlDriver {
  const dispose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  disposals.push(dispose);
  return { [Symbol.asyncDispose]: dispose } as unknown as SqlDriver;
}

async function newRoot(): Promise<string> {
  const root = await actualFsp.mkdtemp(path.join(os.tmpdir(), 'rd-chmod-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  disposals = [];
  chmodMock.mockReset();
  chmodMock.mockImplementation(actualFsp.chmod);
  openDriverMock.mockReset();
  openDriverMock.mockImplementation(async (dbPath) => {
    await actualFsp.writeFile(dbPath, '');
    return makeDriver();
  });
});

afterEach(async () => {
  await closeRunbookStores();
  await Promise.all(
    roots.splice(0).map((root) => actualFsp.rm(root, { recursive: true, force: true })),
  );
});

describe('store registry database-file permission hardening', () => {
  it.each([
    'EACCES',
    'EPERM',
  ])('rejects %s on the database file, disposes, and retries with a fresh open', async (code) => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('rundown.db')) throw errno(code);
      return actualFsp.chmod(file, mode);
    });

    await expect(getRunbookStore(cwd, { runtime: 'native' })).rejects.toThrow(code);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
    chmodMock.mockImplementation(actualFsp.chmod);
    await expect(getRunbookStore(cwd, { runtime: 'native' })).resolves.toBeDefined();
    expect(openDriverMock).toHaveBeenCalledTimes(2);
  });

  it('tolerates ENOENT only for optional WAL/SHM sidecars', async () => {
    const cwd = await newRoot();
    const dbFile = path.join(cwd, '.rundown', 'rundown.db');
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('-wal') || String(file).endsWith('-shm')) throw errno('ENOENT');
      return actualFsp.chmod(file, mode);
    });
    await expect(getRunbookStore(cwd, { runtime: 'native' })).resolves.toBeDefined();
    expect(chmodMock).toHaveBeenCalledWith(dbFile, 0o600);
    expect(chmodMock).toHaveBeenCalledWith(`${dbFile}-wal`, 0o600);
    expect(chmodMock).toHaveBeenCalledWith(`${dbFile}-shm`, 0o600);
  });

  it('rejects ENOENT for the required database file', async () => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('rundown.db')) throw errno('ENOENT');
      return actualFsp.chmod(file, mode);
    });

    await expect(getRunbookStore(cwd, { runtime: 'native' })).rejects.toThrow('ENOENT');
    expect(disposals[0]).toHaveBeenCalledTimes(1);
  });

  it.each([
    errno('EACCES'),
    new Error('unexpected chmod failure'),
  ])('rejects a non-ENOENT sidecar failure: $message', async (failure) => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('-wal')) throw failure;
      return actualFsp.chmod(file, mode);
    });

    await expect(getRunbookStore(cwd, { runtime: 'native' })).rejects.toBe(failure);
    expect(disposals[0]).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ENOSYS',
    'ENOTSUP',
    'EOPNOTSUPP',
  ])('tolerates unsupported filesystem mode error %s', async (code) => {
    const cwd = await newRoot();
    chmodMock.mockRejectedValue(errno(code));
    await expect(getRunbookStore(cwd, { runtime: 'native' })).resolves.toBeDefined();
  });
});
