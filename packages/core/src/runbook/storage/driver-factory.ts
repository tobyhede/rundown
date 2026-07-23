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

import { getErrorMessage, isNodeError } from '../../errors.js';
import { ensureSchema } from './schema.js';
import { openNativeDriver, type NativeDriverOptions } from './native-sqlite-driver.js';
import { openSqljsDriver, type SqljsDriverOptions } from './sqljs-driver.js';
import type { SqlDriver } from './sql-driver.js';

/** Concrete storage runtimes. */
export type StorageRuntime = 'native' | 'sqljs';

/**
 * Environment override forcing a specific driver.
 *
 * User-reachable, so it can only force the SAFE direction. `native` is honored
 * on any host; `sqljs` is honored only where the WebContainer marker already
 * holds, because the single-writer adapter on a real multi-process host is the
 * unsafe downgrade this module exists to prevent.
 */
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
   * `code` of the underlying failure, when it carried one.
   *
   * A bad path, a permission denial and a corrupt database all arrive here, and
   * only the original code distinguishes them. It is mirrored onto the refusal
   * (and the error itself kept as `cause`) so diagnosing the host does not
   * require unwrapping.
   */
  readonly code: string | undefined;

  /**
   * Construct a typed native-unavailable startup error.
   *
   * @param cause - The underlying initialization failure.
   */
  constructor(cause: unknown) {
    super(
      `Native SQLite (node:sqlite) is unavailable on this multi-process host: ${getErrorMessage(cause)}. Rundown does not downgrade to the single-writer sql.js adapter outside WebContainer.`,
      { cause },
    );
    this.name = 'NativeSqliteUnavailableError';
    this.code = isNodeError(cause) ? cause.code : undefined;
  }
}

/**
 * Raised when sql.js is explicitly forced onto a host that is not WebContainer.
 *
 * sql.js provides no cross-process write serialization of its own; the adapter
 * substitutes an advisory file lock, which is sound only where the runtime is
 * genuinely single-writer. Honoring the override anywhere else would make the
 * env var a supported way to reintroduce the hazard.
 */
export class SqljsUnsupportedHostError extends Error {
  /** Construct the typed unsupported-host refusal. */
  constructor() {
    super(
      `${STORAGE_RUNTIME_ENV}=sqljs is only supported inside WebContainer: the sql.js adapter is single-writer and does not serialize writes across OS processes. Unset it to use the native driver.`,
    );
    this.name = 'SqljsUnsupportedHostError';
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
 * An explicit {@link STORAGE_RUNTIME_ENV} override wins, but only in the safe
 * direction: forcing `sqljs` is refused unless the WebContainer marker holds,
 * so the env var cannot be used to opt a real multi-process host into the
 * single-writer adapter. Otherwise a positively identified WebContainer selects
 * `sqljs`; every other host selects `native`.
 *
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns The selected storage runtime.
 * @throws {Error} When the override env var holds an unrecognized value.
 * @throws {SqljsUnsupportedHostError} When `sqljs` is forced outside WebContainer.
 */
export function selectStorageRuntime(env: NodeJS.ProcessEnv = process.env): StorageRuntime {
  const override = env[STORAGE_RUNTIME_ENV];
  if (override !== undefined) {
    if (override === 'native') {
      return override;
    }
    if (override === 'sqljs') {
      if (!isWebContainerRuntime(env)) {
        throw new SqljsUnsupportedHostError();
      }
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
  /**
   * Force a specific runtime, bypassing host detection.
   *
   * TEST SEAM ONLY. Unlike {@link STORAGE_RUNTIME_ENV} this is not gated on the
   * WebContainer marker, so it CAN select the single-writer adapter on a
   * multi-process host — which is exactly what the sql.js adapter's own tests
   * need and what production must never do. Never wire this to user input,
   * config, or an environment value; production selection goes through
   * {@link selectStorageRuntime}.
   */
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
  try {
    await driver.immediate((tx) => {
      ensureSchema(tx);
    });
  } catch (err) {
    // The caller never receives the driver, so it can never dispose it: an
    // incompatible schema would otherwise leak the connection (and, for sql.js,
    // the adapter's lock bookkeeping) for the process lifetime. Disposal must
    // not replace the refusal that caused it.
    await disposeQuietly(driver);
    throw err;
  }
  return driver;
}

/**
 * Dispose a driver, swallowing any disposal failure.
 *
 * Used only on a failure path, where the original error is the one worth
 * surfacing and a disposal fault must not mask it.
 *
 * @param driver - The half-initialized driver to close.
 */
async function disposeQuietly(driver: SqlDriver): Promise<void> {
  try {
    await driver[Symbol.asyncDispose]();
  } catch {
    // Nothing actionable: the open failure is already propagating.
  }
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
    throw new NativeSqliteUnavailableError(err);
  }
}
