/**
 * Linux Landlock sandbox implementation.
 *
 * Uses the Landlock LSM (Linux Security Module) to enforce file access
 * restrictions at the kernel level. Availability and execution are delegated
 * to the bundled `rd-landlock` native helper (see `native/rd-landlock`),
 * which speaks a small `--probe` / spec protocol described in
 * `docs/internal/architecture.md`.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';
import { getErrorMessage } from '../errors.js';
import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

/** Allow-listed Node arch → bundled binary subdir. Never falls back. */
const ARCH_DIRS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: 'linux-x64',
  arm64: 'linux-arm64',
};

/**
 * Resolve the bundled `rd-landlock` binary path for the given architecture.
 *
 * @param arch - `process.arch` value.
 * @param distRoot - The core package `dist` directory.
 * @returns Absolute helper path, or `null` for an unsupported architecture.
 */
export function resolveHelperPath(arch: NodeJS.Architecture, distRoot: string): string | null {
  const sub = ARCH_DIRS[arch];
  return sub ? join(distRoot, 'native', sub, 'rd-landlock') : null;
}

/** Options for constructing a LandlockSandbox. Test seams only. */
export interface LandlockSandboxOptions {
  /** Override the resolved helper path (`null` simulates unsupported arch). */
  helperPath?: string | null;
  /** Override the core `dist` root used for arch resolution. */
  distRoot?: string;
  /** Extra env for the `--probe` invocation (test seam). */
  probeEnv?: Record<string, string>;
}

/**
 * Default dist root: two levels up from this compiled module (dist/sandbox/).
 *
 * @returns Absolute path to the core package's `dist` directory.
 */
function defaultDistRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Landlock sandbox implementation for Linux.
 *
 * Delegates both availability detection and execution to the bundled
 * `rd-landlock` native helper. Availability is determined by running
 * `<helper> --probe`, which reports `{"available":bool,"abi":N}` reflecting
 * whether the kernel enforces Landlock and which ABI it negotiated. The
 * result is memoized for the lifetime of the instance.
 *
 * Landlock features:
 * - Available since Linux 5.13 (ABI negotiation via `--probe` since 6.2)
 * - No root privileges required
 * - File system access control (read, write, execute)
 * - Allow-list only: Landlock cannot express deny rules on top of a broader
 *   allow, so {@link SandboxAvailability.supportsDenyPaths} is always false.
 */
export class LandlockSandbox implements SandboxImplementation {
  private availabilityCache: SandboxAvailability | null = null;
  private readonly helperPath: string | null;
  private readonly probeEnv: Record<string, string>;

  /**
   * Construct a LandlockSandbox.
   *
   * @param opts - Test seams: `helperPath` overrides arch resolution
   *   (`null` simulates an unsupported architecture); `distRoot` overrides
   *   the core `dist` root used to resolve the bundled helper; `probeEnv`
   *   supplies extra environment variables for the `--probe` invocation.
   */
  constructor(opts: LandlockSandboxOptions = {}) {
    const distRoot = opts.distRoot ?? defaultDistRoot();
    this.helperPath =
      opts.helperPath !== undefined ? opts.helperPath : resolveHelperPath(process.arch, distRoot);
    this.probeEnv = opts.probeEnv ?? {};
  }

  /**
   * Check if Landlock sandboxing is available.
   *
   * @returns True if Landlock can be used
   */
  async isAvailable(): Promise<boolean> {
    return (await this.getAvailability()).available;
  }

  /**
   * Get detailed availability information, running `<helper> --probe` on
   * first call and memoizing the result thereafter.
   *
   * @returns Sandbox availability details
   */
  getAvailability(): Promise<SandboxAvailability> {
    if (this.availabilityCache) {
      return Promise.resolve(this.availabilityCache);
    }
    this.availabilityCache = this.computeAvailability();
    return Promise.resolve(this.availabilityCache);
  }

  /**
   * Run the fail-closed availability checks: platform, helper resolution,
   * helper presence, then the `--probe` invocation itself. Any ambiguity —
   * a non-zero exit, a spawn error, missing stdout, malformed JSON, or an
   * `available:true` response without a valid positive ABI — is treated as
   * unavailable.
   *
   * @returns The computed availability result (not yet cached by the caller)
   */
  private computeAvailability(): SandboxAvailability {
    const unavailable = (reason: string): SandboxAvailability => ({
      available: false,
      mechanism: 'none',
      reason,
      platform: process.platform,
      supportsReadRestrictions: false,
      supportsWriteRestrictions: false,
      supportsDenyPaths: false,
    });

    if (process.platform !== 'linux') {
      return unavailable('Landlock is only available on Linux');
    }
    if (!this.helperPath) {
      return unavailable(`Landlock unavailable: unsupported architecture ${process.arch}`);
    }
    if (!existsSync(this.helperPath)) {
      return unavailable(`Landlock unavailable: bundled helper missing at ${this.helperPath}`);
    }

    const probe = spawnSync(this.helperPath, ['--probe'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: { ...process.env, ...this.probeEnv },
    });
    if (probe.status !== 0 || probe.error != null || !probe.stdout) {
      if (probe.error != null) {
        void logger.debug('sandbox: rd-landlock --probe failed to spawn', {
          error: getErrorMessage(probe.error),
        });
      }
      return unavailable('Landlock unavailable: rd-landlock --probe failed to run');
    }
    let parsed: { available?: boolean; abi?: number };
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- validated below
      parsed = JSON.parse(probe.stdout.trim());
    } catch {
      return unavailable('Landlock unavailable: rd-landlock --probe returned malformed JSON');
    }
    // JSON.parse succeeds on `null` and non-object primitives, which are not
    // caught by the try/catch above. Guard before property access so a
    // helper emitting `null` (bug, version mismatch, corruption) fails
    // closed instead of throwing out of this synchronous helper.
    if (parsed === null || typeof parsed !== 'object') {
      return unavailable('Landlock unavailable: rd-landlock --probe returned malformed JSON');
    }
    if (
      typeof parsed.available !== 'boolean' ||
      (parsed.available &&
        (typeof parsed.abi !== 'number' || !Number.isInteger(parsed.abi) || parsed.abi < 1))
    ) {
      return unavailable('Landlock unavailable: rd-landlock --probe returned malformed JSON');
    }
    if (!parsed.available) {
      return unavailable(
        'Landlock unavailable: the kernel does not enforce Landlock (probe reported unavailable). ' +
          'Requires Linux 6.2+ with the Landlock LSM enabled and landlock_* syscalls permitted.',
      );
    }
    return {
      available: true,
      mechanism: 'landlock',
      platform: process.platform,
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
      supportsDenyPaths: false,
      landlockAbi: parsed.abi,
    };
  }

  /**
   * Execute a command with Landlock sandbox restrictions.
   *
   * Not yet implemented — the full spec-based execution path lands across
   * Tasks 15-19.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options with path restrictions
   * @returns Never resolves; always throws
   * @throws {Error} Always — execution is not yet implemented
   */
  // async matches the stable Tasks 15-19 execute() contract; body fills in incrementally.
  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    void command;
    void options;
    throw new Error('not implemented until Task 17');
  }
}
