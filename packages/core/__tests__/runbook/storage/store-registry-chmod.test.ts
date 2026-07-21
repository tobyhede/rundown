import { describe, it, expect, jest, afterEach } from '@jest/globals';
import * as os from 'node:os';
import * as path from 'node:path';

// Intercept only `chmod`; every other fs/promises call (mkdir, mkdtemp, rm)
// passes through to the real implementation so store-open otherwise behaves
// exactly as in production.
const actualFsp = await import('node:fs/promises');
const chmodMock = jest.fn(actualFsp.chmod);

jest.unstable_mockModule('node:fs/promises', () => ({
  ...actualFsp,
  default: actualFsp,
  chmod: chmodMock,
}));

const { getRunbookStore, closeRunbookStores } = await import(
  '../../../src/runbook/storage/store-registry.js'
);

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const dir = await actualFsp.mkdtemp(path.join(os.tmpdir(), 'rd-chmod-'));
  roots.push(dir);
  return dir;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} from chmod`), { code });
}

afterEach(async () => {
  await closeRunbookStores();
  chmodMock.mockReset();
  chmodMock.mockImplementation(actualFsp.chmod);
  await Promise.all(
    roots.splice(0).map((dir) => actualFsp.rm(dir, { recursive: true, force: true })),
  );
});

describe('store-registry database-file permission hardening', () => {
  it('fails the open when chmod on the database file is denied (EACCES)', async () => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('rundown.db')) {
        throw errno('EACCES');
      }
      return actualFsp.chmod(file, mode);
    });
    await expect(getRunbookStore(cwd, { runtime: 'native' })).rejects.toThrow(/EACCES/);
  });

  it('fails the open when chmod on the database file is refused (EPERM)', async () => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('rundown.db')) {
        throw errno('EPERM');
      }
      return actualFsp.chmod(file, mode);
    });
    await expect(getRunbookStore(cwd, { runtime: 'native' })).rejects.toThrow(/EPERM/);
  });

  it('tolerates an ENOENT on the optional WAL/SHM sidecar files', async () => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('-wal') || String(file).endsWith('-shm')) {
        throw errno('ENOENT');
      }
      return actualFsp.chmod(file, mode);
    });
    await expect(getRunbookStore(cwd, { runtime: 'native' })).resolves.toBeDefined();
  });

  it('tolerates an unsupported-filesystem mode error (ENOSYS) on the database file', async () => {
    const cwd = await newRoot();
    chmodMock.mockImplementation(async (file, mode) => {
      if (String(file).endsWith('rundown.db')) {
        throw errno('ENOSYS');
      }
      return actualFsp.chmod(file, mode);
    });
    await expect(getRunbookStore(cwd, { runtime: 'native' })).resolves.toBeDefined();
  });
});
