/**
 * Positive, capability-based storage-driver selection.
 *
 * The WASM `sql.js` driver is chosen ONLY when a positively identified
 * single-writer WebContainer runtime is detected. Everywhere else the native
 * `node:sqlite` driver is used, and a failure to initialize it on a normal
 * multi-process host is a hard startup error — never a silent downgrade to the
 * single-writer adapter, which would be unsafe under real multi-process
 * contention. Native-SQLite absence is deliberately NOT the selection signal:
 * the WebContainer marker is independent of it.
 *
 * @module runbook/storage/driver-factory
 */

import { getErrorMessage } from '../../errors.js';
import { ensureSchema } from './schema.js';
import { openNativeDriver, type NativeDriverOptions } from './native-sqlite-driver.js';
import { openSqljsDriver, type SqljsDriverOptions } from './sqljs-driver.js';
import type { SqlDriver } from './sql-driver.js';

/** Concrete storage runtimes. */
export type StorageRuntime = 'native' | 'sqljs';

/** Environment override forcing a specific driver (escape hatch and test seam). */
export const STORAGE_RUNTIME_ENV = 'RUNDOWN_SQL_DRIVER';

/**
 * WebContainer's userland shell is `jsh`; its spawned Node processes inherit
 * `SHELL=/bin/jsh`. This is the single positive marker for the supported
 * single-writer WebContainer environment.
 */
const WEBCONTAINER_SHELL_PATTERN = /(^|\/)jsh$/;

/**
 * Raised when the native driver cannot be initialized on a host that requires
 * genuine multi-process serialization. The recovery path is fixing the host, not
 * downgrading to the single-writer adapter.
 */
export class NativeSqliteUnavailableError extends Error {
  /**
   * Construct a typed native-unavailable startup error.
   *
   * @param cause - The underlying initialization failure message.
   */
  constructor(cause: string) {
    super(
      `Native SQLite (node:sqlite) is unavailable on this multi-process host: ${cause}. ` +
        `Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.`,
    );
    this.name = 'NativeSqliteUnavailableError';
  }
}

/**
 * Positively identify the supported single-writer WebContainer runtime.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns Whether this process is running inside WebContainer.
 */
export function isWebContainerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const shell = env.SHELL;
  return typeof shell === 'string' && WEBCONTAINER_SHELL_PATTERN.test(shell);
}

/**
 * Select the storage runtime for the current environment.
 *
 * An explicit {@link STORAGE_RUNTIME_ENV} override wins (validated). Otherwise a
 * positively identified WebContainer selects `sqljs`; every other host selects
 * `native`.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns The selected storage runtime.
 * @throws {Error} When the override env var holds an unrecognized value.
 */
export function selectStorageRuntime(env: NodeJS.ProcessEnv = process.env): StorageRuntime {
  const override = env[STORAGE_RUNTIME_ENV];
  if (override !== undefined) {
    if (override === 'native' || override === 'sqljs') {
      return override;
    }
    throw new Error(
      `Invalid ${STORAGE_RUNTIME_ENV}: ${JSON.stringify(override)}; expected 'native' or 'sqljs'`,
    );
  }
  return isWebContainerRuntime(env) ? 'sqljs' : 'native';
}

/** Options for opening a runbook storage driver. */
export interface OpenRunbookDriverOptions {
  /** Force a specific runtime, bypassing detection (tests). */
  readonly runtime?: StorageRuntime;
  /** Native-driver tuning. */
  readonly native?: NativeDriverOptions;
  /** sql.js-driver options (fault hook). */
  readonly sqljs?: SqljsDriverOptions;
  /** Environment to inspect for runtime detection. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Open the capability-selected storage driver and ensure its schema.
 *
 * The schema check-then-install runs inside a single writing transaction so two
 * processes racing to initialize a clean database cannot both install.
 *
 * @param dbPath - Path to the database file (or `':memory:'` for the native
 *   adapter in tests).
 * @param options - Selection and adapter options.
 * @returns An opened driver with schema version ensured.
 * @throws {NativeSqliteUnavailableError} When the native driver cannot open on a
 *   multi-process host.
 * @throws {import('./schema.js').IncompatibleSchemaError} When the database
 *   carries an unusable schema version.
 */
export async function openRunbookDriver(
  dbPath: string,
  options: OpenRunbookDriverOptions = {},
): Promise<SqlDriver> {
  const runtime = options.runtime ?? selectStorageRuntime(options.env);
  const driver = await openDriver(runtime, dbPath, options);
  await driver.immediate((tx) => {
    ensureSchema(tx);
  });
  return driver;
}

/**
 * Open the concrete driver for a runtime without touching the schema.
 *
 * @param runtime - Selected storage runtime.
 * @param dbPath - Path to the database file.
 * @param options - Adapter options.
 * @returns An opened driver.
 */
async function openDriver(
  runtime: StorageRuntime,
  dbPath: string,
  options: OpenRunbookDriverOptions,
): Promise<SqlDriver> {
  if (runtime === 'sqljs') {
    return openSqljsDriver(dbPath, options.sqljs);
  }
  try {
    return openNativeDriver(dbPath, options.native);
  } catch (err) {
    throw new NativeSqliteUnavailableError(getErrorMessage(err));
  }
}
