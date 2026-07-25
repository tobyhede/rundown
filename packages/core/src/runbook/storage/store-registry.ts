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
 * First open wins: a later open of an already-open project returns the existing
 * driver and store and ignores its own options, since the built driver cannot be
 * rebuilt under the callers already holding it.
 *
 * @module runbook/storage/store-registry
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { isNodeError } from '../../errors.js';
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

/** A registry entry: one open (or in-flight) database. */
interface StoreEntry {
  /**
   * The in-flight or settled open.
   *
   * The promise (not the resolved value) is held so two concurrent openers for
   * the same path share one open rather than racing to create two.
   */
  readonly opening: Promise<OpenStore>;
  /**
   * The project root spelling this entry was opened for.
   *
   * The key is derived from the filesystem, which can move under a long-lived
   * entry in either direction — a spelling that canonicalized at open may stop,
   * and one that did not may start — so a close re-deriving the key can miss.
   */
  readonly cwd: string;
}

/** Open stores, each registered under exactly one key (see {@link registryKey}). */
const openStores = new Map<string, StoreEntry>();

/**
 * Resolve a project root to the canonical key for its database.
 *
 * Resolves symlinks where possible so two spellings of the same project root
 * (e.g. `/tmp/x` and `/private/tmp/x` on macOS) share one store rather than
 * opening two connections to the same file.
 *
 * A root that does not exist yet (`ENOENT`/`ENOTDIR`) falls back to the literal
 * spelling: the first open of a fresh project legitimately precedes the
 * directory. Every other realpath failure — `EACCES`, `ELOOP`, `EIO` — means the
 * path exists but could not be canonicalized, so the fallback would be a
 * different file's key returned as though it were canonical. Those propagate.
 *
 * @param cwd - Project root.
 * @returns The canonical database path used as the registry key.
 * @throws {Error} When the root exists but cannot be canonicalized.
 */
export function runbookStoreKey(cwd: string): string {
  try {
    // Resolve the PROJECT ROOT, not `.rundown` — the latter does not exist before
    // the first open, so keying off it would yield a different key once created
    // and silently open a second store for the same database.
    return path.join(fsSync.realpathSync(cwd), DB_FILE);
  } catch (err) {
    if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return dbPath(cwd);
    }
    throw err;
  }
}

/**
 * Derive the single key a project root is registered and looked up under,
 * tolerating canonicalization failure.
 *
 * A database reachable only through a spelling `realpath` cannot resolve must
 * stay openable and closable, so the literal spelling stands in rather than
 * throwing out of a promise-returning API — as the SOLE key, never as an alias
 * beside the canonical one. An alias stays live after it comes to name a
 * DIFFERENT project, handing that caller the wrong database; the drift it would
 * have covered is handled by {@link StoreEntry.cwd} instead.
 *
 * @param cwd - Project root.
 * @returns The registry key for that root.
 */
function registryKey(cwd: string): string {
  try {
    return runbookStoreKey(cwd);
  } catch {
    return dbPath(cwd);
  }
}

/**
 * Find the entry opened for an exact project-root spelling — the close-path
 * fallback for when key derivation has moved since the open.
 *
 * @param cwd - Project root as it was passed to the open.
 * @returns The matching entry, or `undefined` when none was opened for it.
 */
function findEntryByCwd(cwd: string): StoreEntry | undefined {
  for (const entry of openStores.values()) {
    if (entry.cwd === cwd) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Forget an entry by identity rather than by recomputing its key, so removal can
 * neither miss the entry it was asked to drop nor steal one that now belongs to
 * another.
 *
 * @param entry - The entry to unregister.
 */
function forgetEntry(entry: StoreEntry): void {
  for (const [key, registered] of openStores) {
    if (registered === entry) {
      openStores.delete(key);
    }
  }
}

/**
 * Get (opening on first use) the shared {@link RunbookStore} for a project root.
 *
 * @param cwd - Project root.
 * @param options - Driver options (runtime override, adapter settings), honoured
 *   only on the open that creates the store.
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
 * @param options - Driver options (runtime override, adapter settings), honoured
 *   only on the open that creates the store.
 * @returns The shared driver and store.
 */
export function openRunbookStore(
  cwd: string,
  options: OpenRunbookDriverOptions = {},
): Promise<OpenStore> {
  const key = registryKey(cwd);
  const existing = openStores.get(key);
  if (existing !== undefined) {
    return existing.opening;
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
  const entry: StoreEntry = { opening, cwd };
  // Registered before it resolves so concurrent callers join this open. On
  // failure the entry is dropped so a later attempt can retry rather than
  // permanently caching a rejected promise.
  openStores.set(key, entry);
  opening.catch(() => {
    forgetEntry(entry);
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
        const { driver } = await entry.opening;
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
  // Key first, so the common case is a lookup; then the exact spelling the open
  // recorded, the only thing that still matches once the filesystem has moved
  // the derivation. Missing here does not merely fail to tidy the map — it leaks
  // the driver for the process lifetime.
  const entry = openStores.get(registryKey(cwd)) ?? findEntryByCwd(cwd);
  if (entry === undefined) {
    return;
  }
  forgetEntry(entry);
  try {
    const { driver } = await entry.opening;
    await driver[Symbol.asyncDispose]();
  } catch {
    // Best-effort teardown, as above.
  }
}
