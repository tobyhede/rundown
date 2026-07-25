import { describe, it, expect, afterEach } from '@jest/globals';
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
