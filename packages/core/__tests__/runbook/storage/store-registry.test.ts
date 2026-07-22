import { describe, it, expect, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getRunbookStore,
  openRunbookStore,
  closeRunbookStores,
  closeRunbookStore,
  runbookStoreKey,
} from '../../../src/runbook/storage/store-registry.js';

const roots: string[] = [];

async function newRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-registry-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await closeRunbookStores();
  await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('runbook store registry', () => {
  it('opens a project database once and shares it across callers', async () => {
    const cwd = await newRoot();
    const first = await getRunbookStore(cwd, { runtime: 'native' });
    const second = await getRunbookStore(cwd, { runtime: 'native' });
    expect(second).toBe(first);
  });

  it('creates the .rundown directory and the database file', async () => {
    const cwd = await newRoot();
    await getRunbookStore(cwd, { runtime: 'native' });
    expect(fsSync.existsSync(path.join(cwd, '.rundown', 'rundown.db'))).toBe(true);
  });

  it('joins concurrent opens of the same project into one store', async () => {
    const cwd = await newRoot();
    // Both calls start before either resolves, so they must share the in-flight open.
    const [a, b] = await Promise.all([
      getRunbookStore(cwd, { runtime: 'native' }),
      getRunbookStore(cwd, { runtime: 'native' }),
    ]);
    expect(a).toBe(b);
  });

  it('keys distinct projects to distinct stores', async () => {
    const one = await newRoot();
    const two = await newRoot();
    const a = await getRunbookStore(one, { runtime: 'native' });
    const b = await getRunbookStore(two, { runtime: 'native' });
    expect(a).not.toBe(b);
  });

  it('resolves symlinked spellings of a root to one store', async () => {
    const real = await newRoot();
    await getRunbookStore(real, { runtime: 'native' });
    const link = path.join(await newRoot(), 'link');
    await fs.symlink(real, link, 'dir');
    const viaLink = await getRunbookStore(link, { runtime: 'native' });
    const direct = await getRunbookStore(real, { runtime: 'native' });
    expect(runbookStoreKey(link)).toBe(runbookStoreKey(real));
    expect(viaLink).toBe(direct);
  });

  it('reopens after the store is closed', async () => {
    const cwd = await newRoot();
    const first = await getRunbookStore(cwd, { runtime: 'native' });
    await closeRunbookStore(cwd);
    const second = await getRunbookStore(cwd, { runtime: 'native' });
    expect(second).not.toBe(first);
  });

  it('waits for an active close before reopening the same project', async () => {
    const cwd = await newRoot();
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);

    let enterDisposal!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      enterDisposal = resolve;
    });
    let releaseDisposal!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const disposeSpy = jest
      .spyOn(first.driver, Symbol.asyncDispose)
      .mockImplementation(async () => {
        enterDisposal();
        await disposalReleased;
        await originalDispose();
      });

    const closing = closeRunbookStore(cwd);
    await disposalEntered;

    let reopenSettled = false;
    const reopening = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
      reopenSettled = true;
      return opened;
    });

    // Give an incorrectly concurrent native open ample event-loop turns to
    // settle while disposal remains deterministically blocked.
    await Promise.resolve();
    for (let turn = 0; turn < 20 && !reopenSettled; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const settledBeforeRelease = reopenSettled;

    releaseDisposal();
    const [, reopened] = await Promise.all([closing, reopening]);
    disposeSpy.mockRestore();

    expect(settledBeforeRelease).toBe(false);
    expect(reopened.store).not.toBe(first.store);
  });

  it('waits for close-all disposal before reopening the same project', async () => {
    const cwd = await newRoot();
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);

    let enterDisposal!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      enterDisposal = resolve;
    });
    let releaseDisposal!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const disposeSpy = jest
      .spyOn(first.driver, Symbol.asyncDispose)
      .mockImplementation(async () => {
        enterDisposal();
        await disposalReleased;
        await originalDispose();
      });

    const closing = closeRunbookStores();
    await disposalEntered;

    let reopenSettled = false;
    const reopening = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
      reopenSettled = true;
      return opened;
    });

    await Promise.resolve();
    for (let turn = 0; turn < 20 && !reopenSettled; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const settledBeforeRelease = reopenSettled;

    releaseDisposal();
    const [, reopened] = await Promise.all([closing, reopening]);
    disposeSpy.mockRestore();

    expect(settledBeforeRelease).toBe(false);
    expect(reopened.store).not.toBe(first.store);
  });

  it('exposes the driver for explicit disposal', async () => {
    const cwd = await newRoot();
    const { driver } = await openRunbookStore(cwd, { runtime: 'native' });
    expect(driver.kind).toBe('native');
    expect(driver.capabilities.multiProcess).toBe(true);
  });

  it('closing an unopened project is a no-op', async () => {
    const cwd = await newRoot();
    await expect(closeRunbookStore(cwd)).resolves.toBeUndefined();
  });
});
