/**
 * Process-level registry of runbook stores, keyed by database path.
 *
 * A project's `.rundown/rundown.db` is opened at most once per process. Every
 * `RunbookStateManager` (and any other consumer) constructed for the same project
 * root therefore shares one driver and one store, which is what makes "single
 * authority" true within a process rather than merely intended: independent
 * connections could otherwise observe each other's uncommitted-then-rolled-back
 * work only through SQLite's locking, and would multiply WAL readers for no
 * benefit.
 *
 * Sharing also fixes the lifecycle problem the migration would otherwise create.
 * Managers are constructed ad hoc at ~50 call sites with no disposal hook; if each
 * opened its own driver, every command would leak a connection. Here the driver
 * outlives individual managers and is closed explicitly — by tests via
 * {@link closeRunbookStores}, and at process exit by the OS.
 *
 * @module runbook/storage/store-registry
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { DB_FILE, dbPath } from '../../paths.js';
import type { SqlDriver } from './sql-driver.js';
import { openRunbookDriver, type OpenRunbookDriverOptions } from './driver-factory.js';
import { RunbookStore } from './runbook-store.js';

/** An opened database and its typed repository. */
interface OpenStore {
  /** The capability-selected driver. */
  readonly driver: SqlDriver;
  /** The repository over that driver. */
  readonly store: RunbookStore;
}

/**
 * Open stores keyed by resolved database path.
 *
 * Stores the in-flight promise (not the resolved value) so two concurrent
 * openers for the same path share one open rather than racing to create two.
 */
const openStores = new Map<string, Promise<OpenStore>>();

/**
 * Resolve a project root to the canonical key for its database.
 *
 * Resolves symlinks where possible so two spellings of the same project root
 * (e.g. `/tmp/x` and `/private/tmp/x` on macOS) share one store rather than
 * opening two connections to the same file.
 *
 * @param cwd - Project root.
 * @returns The canonical database path used as the registry key.
 */
export function runbookStoreKey(cwd: string): string {
  try {
    // Resolve the PROJECT ROOT, not `.rundown` — the latter does not exist before
    // the first open, so keying off it would yield a different key once created
    // and silently open a second store for the same database.
    return path.join(fsSync.realpathSync(cwd), DB_FILE);
  } catch {
    return dbPath(cwd);
  }
}

/**
 * Get (opening on first use) the shared {@link RunbookStore} for a project root.
 *
 * @param cwd - Project root.
 * @param options - Driver options (runtime override, adapter settings).
 * @returns The shared store for that project.
 */
export async function getRunbookStore(
  cwd: string,
  options: OpenRunbookDriverOptions = {},
): Promise<RunbookStore> {
  return (await openRunbookStore(cwd, options)).store;
}

/**
 * Get (opening on first use) the shared driver and store for a project root.
 *
 * @param cwd - Project root.
 * @param options - Driver options (runtime override, adapter settings).
 * @returns The shared driver and store.
 */
export function openRunbookStore(
  cwd: string,
  options: OpenRunbookDriverOptions = {},
): Promise<OpenStore> {
  const key = runbookStoreKey(cwd);
  const existing = openStores.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const opening = (async (): Promise<OpenStore> => {
    const target = dbPath(cwd);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const driver = await openRunbookDriver(target, options);
    // The database holds run state and hashed claim secrets, so it inherits the
    // owner-only mode the per-run JSON state files carried before it. Applied
    // after open because the file does not exist until the driver creates it.
    // Best-effort: a filesystem without POSIX modes must not fail the open.
    await Promise.all(
      [target, `${target}-wal`, `${target}-shm`].map((file) =>
        fs.chmod(file, 0o600).catch(() => undefined),
      ),
    );
    return { driver, store: new RunbookStore(driver, cwd) };
  })();
  // Registered before it resolves so concurrent callers join this open. On
  // failure the entry is dropped so a later attempt can retry rather than
  // permanently caching a rejected promise.
  openStores.set(key, opening);
  opening.catch(() => {
    if (openStores.get(key) === opening) {
      openStores.delete(key);
    }
  });
  return opening;
}

/**
 * Close and forget every open store.
 *
 * Intended for test teardown, where many temporary project roots are opened in
 * one process. Disposal failures are swallowed per store so one bad handle
 * cannot strand the rest.
 *
 * @returns Resolves once every store has been disposed and the registry cleared.
 */
export async function closeRunbookStores(): Promise<void> {
  const entries = [...openStores.values()];
  openStores.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const { driver } = await entry;
        await driver[Symbol.asyncDispose]();
      } catch {
        // Best-effort teardown: a store that failed to open or dispose must not
        // prevent the others from closing.
      }
    }),
  );
}

/**
 * Close and forget the store for one project root.
 *
 * @param cwd - Project root whose store should be closed.
 * @returns Resolves once the store is disposed, or immediately when none is open.
 */
export async function closeRunbookStore(cwd: string): Promise<void> {
  const key = runbookStoreKey(cwd);
  const entry = openStores.get(key);
  if (entry === undefined) {
    return;
  }
  openStores.delete(key);
  try {
    const { driver } = await entry;
    await driver[Symbol.asyncDispose]();
  } catch {
    // Best-effort teardown, as above.
  }
}
