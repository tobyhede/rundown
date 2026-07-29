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
const pendingDisposalReleases = new Set<() => void>();

/** Track a blocking disposal gate so shared teardown cannot wait on itself. */
function trackDisposalRelease(resolve: () => void): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    pendingDisposalReleases.delete(release);
    resolve();
  };
  pendingDisposalReleases.add(release);
  return release;
}

async function newRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rd-registry-'));
  roots.push(dir);
  return dir;
}

/**
 * Yield the event loop long enough that an UNSERIALIZED reopen would have
 * settled, so a `settled === false` assertion after this means the reopen is
 * genuinely waiting rather than merely slow.
 *
 * A real reopen costs a recursive `mkdir`, a driver open, and three `chmod`s —
 * measured at 5-11 turns on this codebase, so 20 is a 2-3x margin. It is not a
 * race either way: a correctly serialized reopen is blocked on a promise the
 * test itself resolves, so it stays pending for any number of turns.
 */
async function drainTurns(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(async () => {
  for (const release of pendingDisposalReleases) release();
  pendingDisposalReleases.clear();
  jest.restoreAllMocks();
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

  it('locks the database and its WAL/SHM sidecars to owner-only (0o600)', async () => {
    const cwd = await newRoot();
    await getRunbookStore(cwd, { runtime: 'native' });
    // The store holds run state and hashed claim secrets, so it inherits the
    // owner-only mode the per-run JSON state files carried before it. The native
    // driver opens in WAL mode, so the -wal/-shm sidecars exist on disk beside
    // the db while the shared connection is held open — all three must be 0o600,
    // not just the main file.
    const dbFile = path.join(cwd, '.rundown', 'rundown.db');
    for (const file of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
      const { mode } = await fs.stat(file);
      expect(mode & 0o777).toBe(0o600);
    }
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

  it('falls back to the literal spelling for a root that does not exist yet', async () => {
    const cwd = path.join(await newRoot(), 'not-created-yet');
    expect(runbookStoreKey(cwd)).toBe(path.join(cwd, '.rundown', 'rundown.db'));

    // ENOTDIR — a file where a directory component is expected — is the same
    // "nothing to canonicalize" case as ENOENT.
    const file = path.join(await newRoot(), 'file');
    await fs.writeFile(file, '');
    const under = path.join(file, 'root');
    expect(runbookStoreKey(under)).toBe(path.join(under, '.rundown', 'rundown.db'));
  });

  it('propagates a root that exists but cannot be canonicalized', async () => {
    const dir = await newRoot();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    await fs.symlink(b, a, 'dir');
    await fs.symlink(a, b, 'dir');

    // ELOOP is not "not there yet": returning the literal spelling here would
    // present a key that is not canonical as though it were, which is how one
    // database ends up with two registry entries.
    expect(() => runbookStoreKey(a)).toThrow(/ELOOP/);
  });

  it('does not serve a stale store to a spelling that now names a different project', async () => {
    const first = await newRoot();
    const second = await newRoot();
    const link = path.join(await newRoot(), 'link');
    await fs.symlink(first, link, 'dir');
    const viaFirst = await getRunbookStore(link, { runtime: 'native' });

    // Registering the literal spelling as an alias must not make it authoritative:
    // once it resolves elsewhere it names a different database, and handing back
    // the old store would be a caller reading and writing the wrong project.
    await fs.unlink(link);
    await fs.symlink(second, link, 'dir');

    const viaSecond = await getRunbookStore(link, { runtime: 'native' });
    expect(viaSecond).not.toBe(viaFirst);
    expect(await getRunbookStore(second, { runtime: 'native' })).toBe(viaSecond);
  });

  it('does not serve a stale store to a spelling that has become a real project directory', async () => {
    const projectA = await newRoot();
    // Canonicalized so the literal spelling of `link` IS its own realpath once
    // it becomes a real directory — otherwise the platform's `/var` →
    // `/private/var` tmpdir link hides the aliasing hazard under test.
    const parent = await fs.realpath(await newRoot());
    const link = path.join(parent, 'link');
    await fs.symlink(projectA, link, 'dir');
    const viaLink = await openRunbookStore(link, { runtime: 'native' });

    // The link is replaced by a real directory holding a DIFFERENT project.
    // `realpath` now answers with the literal spelling, so an entry that is also
    // registered under that spelling is a stale alias naming project A.
    await fs.unlink(link);
    await fs.mkdir(link);
    const viaReal = await openRunbookStore(link, { runtime: 'native' });

    expect(viaReal.driver).not.toBe(viaLink.driver);
    expect(fsSync.existsSync(path.join(link, '.rundown', 'rundown.db'))).toBe(true);

    // Instance inequality alone is not enough: the second caller must read and
    // write its OWN database, not project A's.
    await viaReal.driver.immediate((tx) => {
      tx.exec('CREATE TABLE probe (x INTEGER)');
    });
    await expect(
      viaLink.driver.read((tx) => tx.prepare('SELECT x FROM probe').all()),
    ).rejects.toThrow(/no such table/i);
  });

  it('disposes a project whose root starts canonicalizing between open and close', async () => {
    const parent = await newRoot();
    const root = path.join(parent, 'project');
    const other = path.join(parent, 'other');
    await fs.mkdir(other);

    // The root does not exist yet, so the open can only register the literal
    // spelling.
    const { driver } = await openRunbookStore(root, { runtime: 'native' });

    // It is then replaced by a symlink elsewhere: `realpath` now SUCCEEDS and
    // answers with a key the open never used, so a close that consults only the
    // canonical spelling misses and leaks the connection. This is the mirror of
    // "resolved at open, unresolvable at close".
    await fs.rm(root, { recursive: true, force: true });
    await fs.symlink(other, root, 'dir');

    await closeRunbookStore(root);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('reopens after the store is closed', async () => {
    const cwd = await newRoot();
    const first = await getRunbookStore(cwd, { runtime: 'native' });
    await closeRunbookStore(cwd);
    const second = await getRunbookStore(cwd, { runtime: 'native' });
    expect(second).not.toBe(first);
  });

  it.each(['close-one', 'close-all'] as const)(
    'waits for %s disposal before reopening the same project',
    async (mode) => {
      const cwd = await newRoot();
      const first = await openRunbookStore(cwd, { runtime: 'native' });
      const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
      let enterDisposal!: () => void;
      const disposalEntered = new Promise<void>((resolve) => {
        enterDisposal = resolve;
      });
      let releaseDisposal!: () => void;
      const disposalReleased = new Promise<void>((resolve) => {
        releaseDisposal = trackDisposalRelease(resolve);
      });
      const disposeSpy = jest
        .spyOn(first.driver, Symbol.asyncDispose)
        .mockImplementation(async () => {
          enterDisposal();
          await disposalReleased;
          await originalDispose();
        });

      const closing = mode === 'close-one' ? closeRunbookStore(cwd) : closeRunbookStores();
      await disposalEntered;
      let reopenSettled = false;
      const reopening = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
        reopenSettled = true;
        return opened;
      });
      await drainTurns();
      const settledBeforeRelease = reopenSettled;
      releaseDisposal();
      const [, reopened] = await Promise.all([closing, reopening]);
      disposeSpy.mockRestore();

      expect(settledBeforeRelease).toBe(false);
      expect(reopened.store).not.toBe(first.store);
    },
  );

  it('waits for a close found by original cwd after its canonical key drifts', async () => {
    const parent = await newRoot();
    const cwd = path.join(parent, 'created-by-open');
    const moved = path.join(parent, 'moved-after-open');
    const beforeKey = runbookStoreKey(cwd);
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    await fs.rename(cwd, moved);
    await fs.symlink(moved, cwd, 'dir');
    const afterKey = runbookStoreKey(cwd);
    expect(afterKey).not.toBe(beforeKey);
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let enterDisposal!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      enterDisposal = resolve;
    });
    let releaseDisposal!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      releaseDisposal = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
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
    await drainTurns();
    const settledBeforeRelease = reopenSettled;
    releaseDisposal();
    const [, reopened] = await Promise.all([closing, reopening]);

    expect(settledBeforeRelease).toBe(false);
    expect(reopened.store).not.toBe(first.store);
  });

  it('waits by canonical key when close and reopen use different root spellings', async () => {
    const real = await newRoot();
    const link = path.join(await newRoot(), 'link');
    await fs.symlink(real, link, 'dir');
    const first = await openRunbookStore(real, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let entered!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      release = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      entered();
      await disposalReleased;
      await originalDispose();
    });

    const closing = closeRunbookStore(real);
    await disposalEntered;
    let settled = false;
    const reopening = openRunbookStore(link, { runtime: 'native' }).then((opened) => {
      settled = true;
      return opened;
    });
    await drainTurns();
    expect(settled).toBe(false);
    release();
    await Promise.all([closing, reopening]);
  });

  it.each([
    { identity: 'close-time alias', openViaAlias: false, closeViaAlias: true },
    { identity: 'open-time alias', openViaAlias: true, closeViaAlias: false },
  ])('waits by the $identity after its canonical key drifts', async (testCase) => {
    const parent = await newRoot();
    const real = path.join(parent, 'real');
    const moved = path.join(parent, 'moved');
    const alias = path.join(parent, 'alias');
    await fs.mkdir(real);
    await fs.symlink(real, alias, 'dir');
    const openCwd = testCase.openViaAlias ? alias : real;
    const closeCwd = testCase.closeViaAlias ? alias : real;
    const first = await openRunbookStore(openCwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let enterDisposal!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      enterDisposal = resolve;
    });
    let releaseDisposal!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      releaseDisposal = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      enterDisposal();
      await disposalReleased;
      await originalDispose();
    });

    const keyAtClose = runbookStoreKey(closeCwd);
    const closing = closeRunbookStore(closeCwd);
    await disposalEntered;
    await fs.rename(real, moved);
    await fs.unlink(alias);
    await fs.symlink(moved, alias, 'dir');
    expect(runbookStoreKey(alias)).not.toBe(keyAtClose);

    let reopenSettled = false;
    const reopening = openRunbookStore(alias, { runtime: 'native' }).then((opened) => {
      reopenSettled = true;
      return opened;
    });
    await drainTurns();
    const settledBeforeRelease = reopenSettled;
    releaseDisposal();
    const [, reopened] = await Promise.all([closing, reopening]);

    expect(settledBeforeRelease).toBe(false);
    expect(reopened.store).not.toBe(first.store);
  });

  it('closes by canonical key when the close uses a different root spelling', async () => {
    const real = await newRoot();
    const link = path.join(await newRoot(), 'link');
    await fs.symlink(real, link, 'dir');
    const { driver } = await openRunbookStore(real, { runtime: 'native' });

    await closeRunbookStore(link);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('does not serialize an unrelated project behind another project close', async () => {
    const closingCwd = await newRoot();
    const unrelatedCwd = await newRoot();
    const first = await openRunbookStore(closingCwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let entered!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      release = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      entered();
      await disposalReleased;
      await originalDispose();
    });

    const closing = closeRunbookStore(closingCwd);
    await disposalEntered;
    const unrelated = await openRunbookStore(unrelatedCwd, { runtime: 'native' });
    expect(unrelated.store).toBeDefined();
    release();
    await closing;
  });

  it('forgets a completed close before serializing a second close cycle', async () => {
    const cwd = await newRoot();
    await openRunbookStore(cwd, { runtime: 'native' });
    await closeRunbookStore(cwd);
    const second = await openRunbookStore(cwd, { runtime: 'native' });
    const originalDispose = second.driver[Symbol.asyncDispose].bind(second.driver);
    let entered!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      release = trackDisposalRelease(resolve);
    });
    jest.spyOn(second.driver, Symbol.asyncDispose).mockImplementation(async () => {
      entered();
      await disposalReleased;
      await originalDispose();
    });

    const closing = closeRunbookStore(cwd);
    await disposalEntered;
    let settled = false;
    const reopening = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
      settled = true;
      return opened;
    });
    await drainTurns();
    expect(settled).toBe(false);
    release();
    await Promise.all([closing, reopening]);
  });

  it('close-all waits for a close that was already active', async () => {
    const cwd = await newRoot();
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let entered!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      release = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      entered();
      await disposalReleased;
      await originalDispose();
    });

    const closingOne = closeRunbookStore(cwd);
    await disposalEntered;
    let closeAllSettled = false;
    const closingAll = closeRunbookStores().then(() => {
      closeAllSettled = true;
    });
    await drainTurns();
    expect(closeAllSettled).toBe(false);
    release();
    await Promise.all([closingOne, closingAll]);
  });

  it('shared teardown releases a blocking disposal gate', async () => {
    const cwd = await newRoot();
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    const originalDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let entered!: () => void;
    const disposalEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const disposalReleased = new Promise<void>((resolve) => {
      release = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      entered();
      await disposalReleased;
      await originalDispose();
    });

    void closeRunbookStore(cwd);
    await disposalEntered;
    // Deliberately leave the gate blocked: this test completes only if afterEach
    // releases tracked gates before waiting for registry disposal.
    expect(pendingDisposalReleases.has(release)).toBe(true);
  });

  it('waits for an overlapping close-reopen-close chain before reopening again', async () => {
    const cwd = await newRoot();
    const first = await openRunbookStore(cwd, { runtime: 'native' });
    const originalFirstDispose = first.driver[Symbol.asyncDispose].bind(first.driver);
    let enterFirstClose!: () => void;
    const firstCloseEntered = new Promise<void>((resolve) => {
      enterFirstClose = resolve;
    });
    let releaseFirstClose!: () => void;
    const firstCloseReleased = new Promise<void>((resolve) => {
      releaseFirstClose = trackDisposalRelease(resolve);
    });
    jest.spyOn(first.driver, Symbol.asyncDispose).mockImplementation(async () => {
      enterFirstClose();
      await firstCloseReleased;
      await originalFirstDispose();
    });

    const firstClose = closeRunbookStore(cwd);
    await firstCloseEntered;

    let enterSecondClose!: () => void;
    const secondCloseEntered = new Promise<void>((resolve) => {
      enterSecondClose = resolve;
    });
    let releaseSecondClose!: () => void;
    const secondCloseReleased = new Promise<void>((resolve) => {
      releaseSecondClose = trackDisposalRelease(resolve);
    });
    // Attach this continuation before `secondClose`: promise callbacks run in
    // registration order, so the disposal spy is installed before that close's
    // `await entry.opening` continuation can dispose the reopened driver.
    const reopeningForSecondClose = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
      const originalDispose = opened.driver[Symbol.asyncDispose].bind(opened.driver);
      jest.spyOn(opened.driver, Symbol.asyncDispose).mockImplementation(async () => {
        enterSecondClose();
        await secondCloseReleased;
        await originalDispose();
      });
      return opened;
    });
    const secondClose = closeRunbookStore(cwd);

    let finalReopenSettled = false;
    const finalReopen = openRunbookStore(cwd, { runtime: 'native' }).then((opened) => {
      finalReopenSettled = true;
      return opened;
    });
    releaseFirstClose();
    await secondCloseEntered;
    await drainTurns();
    const settledBeforeSecondClose = finalReopenSettled;
    releaseSecondClose();
    const [, reopenedThenClosed, , final] = await Promise.all([
      firstClose,
      reopeningForSecondClose,
      secondClose,
      finalReopen,
    ]);

    expect(settledBeforeSecondClose).toBe(false);
    expect(final.store).not.toBe(reopenedThenClosed.store);
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

  it('closing an unopened project does not dispose another project store', async () => {
    const opened = await newRoot();
    const never = await newRoot();
    const { driver } = await openRunbookStore(opened, { runtime: 'native' });

    // The close falls back to scanning entries by the root they were opened for.
    // A scan that matches on anything but that root closes an arbitrary other
    // project — the worst possible outcome for a call that should do nothing.
    await closeRunbookStore(never);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).resolves.toEqual({ x: 1 });
  });

  it('first open wins: a later open reuses the driver already built', async () => {
    const cwd = await newRoot();
    const { driver } = await openRunbookStore(cwd, { runtime: 'native' });

    // The driver exists and is already held by the first caller, so a second
    // caller's options cannot be applied to it. Reuse is the contract.
    const second = await openRunbookStore(cwd, {
      runtime: 'native',
      native: { busyTimeoutMs: 9999 },
    });
    expect(second.driver).toBe(driver);
  });

  it('defaulted and explicitly empty options are the same open', async () => {
    const cwd = await newRoot();
    const first = await getRunbookStore(cwd);
    expect(await getRunbookStore(cwd, {})).toBe(first);
  });

  it('disposes every open driver when closing all stores', async () => {
    const one = await newRoot();
    const two = await newRoot();
    const first = await openRunbookStore(one, { runtime: 'native' });
    const second = await openRunbookStore(two, { runtime: 'native' });

    await closeRunbookStores();

    // Clearing the map is not closing the databases: an undisposed driver holds
    // its connection (and, for sql.js, its lock file) for the process lifetime.
    await expect(first.driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
    await expect(second.driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('disposes the driver when closing one project', async () => {
    const cwd = await newRoot();
    const { driver } = await openRunbookStore(cwd, { runtime: 'native' });

    await closeRunbookStore(cwd);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('disposes a project whose canonical spelling stops resolving between open and close', async () => {
    const real = await newRoot();
    const link = path.join(await newRoot(), 'link');
    await fs.symlink(real, link, 'dir');
    const { driver } = await openRunbookStore(link, { runtime: 'native' });

    // The open registered the entry under the realpath-resolved spelling. Once
    // the link is gone realpath fails, so a close that recomputes the key from
    // `cwd` looks under the fallback spelling instead, finds nothing, returns
    // early — and the connection is leaked for the lifetime of the process.
    await fs.unlink(link);
    await closeRunbookStore(link);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('disposes a project whose root stops canonicalizing between open and close', async () => {
    const parent = await newRoot();
    const root = path.join(parent, 'project');
    // The root does not exist yet, so the open registers it under its literal
    // spelling.
    const { driver } = await openRunbookStore(root, { runtime: 'native' });

    // Replace it with a symlink loop: realpath now fails with ELOOP rather than
    // ENOENT, so a close that cannot tolerate that failure looks under no key at
    // all and leaks the connection.
    await fs.rm(root, { recursive: true, force: true });
    const other = path.join(parent, 'other');
    await fs.symlink(other, root, 'dir');
    await fs.symlink(root, other, 'dir');

    await closeRunbookStore(root);

    await expect(driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).rejects.toThrow(
      /used after disposal/,
    );
  });

  it('drops a failed open so a later attempt can retry', async () => {
    const parent = await newRoot();
    const root = path.join(parent, 'project');
    // A file where the project root belongs: creating `.rundown` under it fails.
    await fs.writeFile(root, '');
    await expect(openRunbookStore(root, { runtime: 'native' })).rejects.toThrow();

    // Caching the rejected open would make the project permanently unopenable in
    // this process, long after the condition that failed it is gone.
    await fs.rm(root);
    await fs.mkdir(root);
    const { driver } = await openRunbookStore(root, { runtime: 'native' });
    expect(driver.kind).toBe('native');
  });

  it('rejects rather than throws when a root cannot be canonicalized', async () => {
    const dir = await newRoot();
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    await fs.symlink(b, a, 'dir');
    await fs.symlink(a, b, 'dir');

    // `runbookStoreKey` propagates ELOOP by design, but the registry must not
    // let it escape synchronously out of a promise-returning function: callers
    // handle the failure of an open through the returned promise.
    await expect(openRunbookStore(a, { runtime: 'native' })).rejects.toThrow(/ELOOP/);
  });

  it('closing one project leaves another project open', async () => {
    const first = await newRoot();
    const second = await newRoot();
    await openRunbookStore(first, { runtime: 'native' });
    const other = await openRunbookStore(second, { runtime: 'native' });

    // Forgetting by identity must drop exactly the closed entry: dropping the
    // rest strands them with live drivers nobody can reach, and dropping none
    // leaves the closed entry serving a disposed driver.
    await closeRunbookStore(first);

    await expect(other.driver.read((tx) => tx.prepare('SELECT 1 AS x').get())).resolves.toEqual({
      x: 1,
    });
    expect(await openRunbookStore(second, { runtime: 'native' })).toBe(other);
  });
});
