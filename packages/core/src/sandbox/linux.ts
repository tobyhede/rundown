/**
 * Linux Landlock sandbox implementation.
 *
 * Uses the Landlock LSM (Linux Security Module) to enforce file access
 * restrictions at the kernel level. Requires Linux kernel 5.13+.
 *
 * For MVP, this implementation uses an external wrapper like Landrun.
 * Future versions could use native syscalls via a Node.js addon.
 *
 * @module
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

/**
 * System paths a sandboxed process needs to locate and *execute* its
 * interpreter, binaries, and shared libraries. landrun's `--ro` grants read
 * without execute, so these are granted with `--rox` (read + execute);
 * granting them `--ro` would deny exec of `/bin/sh` and the command itself.
 */
const SYSTEM_EXEC_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];

/**
 * System paths a sandboxed process reads but never executes (configuration,
 * CA bundles, name resolution). Granted read-only with `--ro`.
 */
const SYSTEM_READ_PATHS = ['/etc'];

/**
 * Build the landrun grant flags for the standard system paths, filtered to
 * those that actually exist on this host. Filtering matters because landrun
 * fails to build a ruleset for a non-existent path (e.g. `/lib64` is absent on
 * arm64). Shared between the availability probe and execution so the probe
 * exercises the same grants real commands run under.
 *
 * @returns Ordered landrun args, e.g. `['--rox', '/usr', '--ro', '/etc']`
 */
function buildSystemPathArgs(): string[] {
  const args: string[] = [];
  for (const path of SYSTEM_EXEC_PATHS) {
    if (existsSync(path)) {
      args.push('--rox', path);
    }
  }
  for (const path of SYSTEM_READ_PATHS) {
    if (existsSync(path)) {
      args.push('--ro', path);
    }
  }
  return args;
}

/**
 * Functionally verify that Landlock *enforces* in this environment.
 *
 * Reading `/sys/kernel/security/lsm` only reports whether the kernel exposes
 * the Landlock introspection interface — a false negative in containers where
 * securityfs is not mounted even though the syscalls work. But a naive "did the
 * wrapper run?" probe is also unsound: with `--best-effort`, landrun silently
 * runs *unsandboxed* on a kernel without Landlock, so a command exiting 0 does
 * not prove anything was enforced.
 *
 * This probe therefore does two things, both via the wrapper:
 *   1. Positive control — sandbox `/bin/true`; it must exit 0 (the wrapper can
 *      run and apply whatever ruleset the kernel supports).
 *   2. Enforcement control — sandbox a read of a file in a directory that was
 *      deliberately *not* granted; the read must be *denied*. If it succeeds,
 *      `--best-effort` fell back to no enforcement and we must report
 *      unavailable rather than claim a sandbox we don't have.
 *
 * This is the sole authority for availability — we do NOT trust the securityfs
 * `/sys/kernel/security/lsm` read as a positive shortcut. That file reports
 * whether the kernel *compiled in* Landlock, not whether the `landlock_*`
 * syscalls are actually permitted: a container can advertise landlock via the
 * host kernel while seccomp blocks the syscall. Trusting it would mark Landlock
 * available, and since execution runs with `--best-effort`, landrun would then
 * silently run unsandboxed while still reporting `sandboxed: true`.
 *
 * @param wrapperPath - Absolute path to the Landlock wrapper (e.g. landrun)
 * @returns True only if the wrapper ran *and* enforcement was observed
 */
function probeLandlockWrapper(wrapperPath: string): boolean {
  const spawnOpts = { stdio: 'ignore' as const, timeout: 5000, killSignal: 'SIGKILL' as const };
  const systemArgs = buildSystemPathArgs();

  try {
    // 1. Positive control: the wrapper can sandbox and run a trivial command.
    const ran = spawnSync(
      wrapperPath,
      ['--best-effort', ...systemArgs, '--', '/bin/true'],
      spawnOpts,
    );
    if (ran.status !== 0 || ran.error != null) {
      return false;
    }

    // 2. Enforcement control: a read outside the granted paths must be denied.
    // The probe directory lives under the OS temp dir, which is intentionally
    // absent from systemArgs, so a working sandbox blocks the read.
    const probeDir = mkdtempSync(join(tmpdir(), 'rundown-landlock-probe-'));
    try {
      const secret = join(probeDir, 'denied');
      writeFileSync(secret, 'x');
      const denied = spawnSync(
        wrapperPath,
        ['--best-effort', ...systemArgs, '--', '/bin/cat', secret],
        spawnOpts,
      );
      // status 0 => the ungranted file was readable => nothing was enforced.
      return denied.status !== 0 && denied.error == null;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}

/**
 * Find a Landlock wrapper executable.
 *
 * Checks for common Landlock CLI wrappers in PATH.
 *
 * @returns Path to wrapper executable or null
 */
function findLandlockWrapper(): string | null {
  // Check for common Landlock CLI tools
  const wrappers = ['landrun', 'landlocked'];

  for (const wrapper of wrappers) {
    // Check if wrapper is in PATH
    const result = spawnSync('which', [wrapper], {
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }

  return null;
}

/**
 * Landlock sandbox implementation for Linux.
 *
 * Uses the Landlock LSM to restrict file access at the kernel level.
 * This implementation delegates to an external wrapper (landrun) for MVP.
 *
 * Landlock features:
 * - Available since Linux 5.13
 * - No root privileges required
 * - File system access control (read, write, execute)
 * - TCP port binding/connection control (5.19+)
 */
export class LandlockSandbox implements SandboxImplementation {
  private availabilityCache: SandboxAvailability | null = null;
  private wrapperPath: string | null = null;

  /**
   * Check if Landlock sandboxing is available.
   *
   * @returns True if Landlock can be used
   */
  async isAvailable(): Promise<boolean> {
    const availability = await this.getAvailability();
    return availability.available;
  }

  /**
   * Get detailed availability information.
   *
   * @returns Sandbox availability details
   */
  getAvailability(): Promise<SandboxAvailability> {
    if (this.availabilityCache) {
      return Promise.resolve(this.availabilityCache);
    }

    // Check if we're on Linux
    if (process.platform !== 'linux') {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: 'Landlock is only available on Linux',
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    // Check for wrapper executable first — the functional kernel probe runs
    // through it, so without a wrapper there is nothing to enforce with.
    this.wrapperPath = findLandlockWrapper();
    if (!this.wrapperPath) {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: 'No Landlock wrapper found. Install landrun: https://github.com/Zouuup/landrun',
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    // Functionally verify enforcement via the wrapper. This is authoritative:
    // we do not trust the securityfs lsm read as a shortcut, because it cannot
    // tell whether the landlock_* syscalls are actually permitted (e.g. blocked
    // by container seccomp). Since execution uses --best-effort, trusting a
    // false positive here would silently run unsandboxed while reporting
    // sandboxed: true.
    if (!probeLandlockWrapper(this.wrapperPath)) {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason:
          `Landlock unavailable: a functional enforcement probe via ${this.wrapperPath} ` +
          `failed (the landlock_* syscalls did not enforce). Requires Linux 5.13+ with the ` +
          `Landlock LSM enabled and landlock_* syscalls permitted.`,
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    this.availabilityCache = {
      available: true,
      mechanism: 'landlock',
      platform: process.platform,
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
      supportsDenyPaths: false,
    };
    return Promise.resolve(this.availabilityCache);
  }

  /**
   * Execute a command with Landlock sandbox restrictions.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options with path restrictions
   * @returns Execution result
   */
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    if (options.denyPatterns.length > 0 || options.denyPaths.length > 0) {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        denialReason:
          'Linux sandbox backend cannot safely enforce deny-path policy. ' +
          'Execution was blocked to avoid weakening policy. Disable sandbox only for trusted runs.',
      };
    }

    // Ensure we have a wrapper
    if (!this.wrapperPath) {
      const availability = await this.getAvailability();
      if (!availability.available) {
        return {
          success: false,
          exitCode: 126,
          sandboxed: false,
          policyDenied: true,
          denialReason: availability.reason,
        };
      }
    }

    return this.executeWithLandrun(command, options);
  }

  /**
   * Execute a command using the landrun wrapper.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options
   * @returns Execution result
   */
  private executeWithLandrun(
    command: string,
    options: SandboxOptions,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      // Build landrun arguments.
      // --best-effort: enforce at the highest Landlock ABI the kernel supports
      // rather than hard-failing when landrun wants a newer ABI than is
      // available (e.g. landrun targets ABI v5 / kernel 6.12+, but common LTS
      // kernels only offer v4). Availability is gated by a probe that verifies
      // enforcement actually happens, so best-effort cannot silently downgrade
      // us to an unsandboxed run that still reports as sandboxed.
      const args: string[] = ['--best-effort'];

      // Add read-only paths
      for (const path of options.readOnlyPaths) {
        args.push('--ro', path);
      }

      // Add read-write paths
      for (const path of options.readWritePaths) {
        args.push('--rw', path);
      }

      // Add the system paths needed to exec the interpreter and load libraries
      // (granted --rox), filtered to those present on this host.
      args.push(...buildSystemPathArgs());

      // Execute the command
      args.push('--', '/bin/sh', '-c', command);

      // Enhance PATH to include node_modules/.bin for local package binaries
      const enhancedEnv = {
        ...options.env,
        PATH: buildEnhancedPathFromEnv(options.cwd, options.env),
      };

      // wrapperPath is guaranteed to be set at this point (checked at start of execute method)

      const child = spawn(this.wrapperPath!, args, {
        cwd: options.cwd,
        stdio: 'inherit',
        env: enhancedEnv,
      });

      child.on('close', (code) => {
        const exitCode = code ?? 1;

        resolve({
          success: exitCode === 0,
          exitCode,
          sandboxed: true,
          policyDenied: exitCode !== 0 ? undefined : false,
        });
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          exitCode: 1,
          sandboxed: true,
          policyDenied: true,
          denialReason: `Landlock execution error: ${err.message}`,
        });
      });
    });
  }
}

function buildEnhancedPathFromEnv(cwd: string, env: Record<string, string>): string {
  const binPath = join(cwd, 'node_modules', '.bin');
  const existingPath = env.PATH || env.Path || '';
  return existingPath ? `${binPath}:${existingPath}` : binPath;
}
