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

import { logger } from '../logger.js';
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
 * Device nodes a sandboxed command opens directly. `/dev/null` is the common
 * case: a shell opens it *for writing* on every `> /dev/null` redirect, so a
 * read-only grant is insufficient — without a read-write grant the redirect
 * fails with `cannot create /dev/null: Permission denied`. landrun 0.1.x has no
 * dedicated device flag, so these are granted as individual read-write
 * filesystem nodes with `--rw`, filtered to those present on the host.
 */
const DEVICE_RW_PATHS = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'];

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
 * Build the landrun `--rw` grants for the device nodes a sandboxed command may
 * open directly (e.g. `/dev/null` on a `> /dev/null` redirect), filtered to
 * those that exist on this host.
 *
 * @returns Ordered landrun args, e.g. `['--rw', '/dev/null', '--rw', '/dev/zero']`
 */
function buildDevicePathArgs(): string[] {
  const args: string[] = [];
  for (const path of DEVICE_RW_PATHS) {
    if (existsSync(path)) {
      args.push('--rw', path);
    }
  }
  return args;
}

/**
 * Build landrun grant flags for caller-supplied policy paths, filtered to those
 * that exist on this host.
 *
 * landrun aborts ruleset construction on any grant path that does not exist
 * (the same constraint that {@link buildSystemPathArgs} handles for system
 * paths). A policy may resolve write-allow globs to concrete paths that have not
 * been created yet (e.g. an opted-in `dist/` before the first build, or
 * `.claude/` in a project that does not use the Claude Code plugin), so those
 * are dropped rather than passed through. Dropping is safe: the repo root is
 * granted read-only, so a sandboxed command could not create such a path
 * regardless of the grant. Rundown's own state directories are ensured to exist
 * before sandbox setup (see `ensureStateDirs`), so they are never dropped here.
 *
 * @param flag - landrun access flag (`--ro` for read-only, `--rw` for read-write)
 * @param paths - Candidate paths to grant
 * @returns Ordered landrun args for the paths that exist, e.g. `['--rw', '/a']`
 */
function buildGrantArgs(flag: '--ro' | '--rw', paths: string[]): string[] {
  const args: string[] = [];
  for (const path of paths) {
    if (existsSync(path)) {
      args.push(flag, path);
    } else {
      void logger.debug('sandbox: skipping non-existent grant path', { flag, path });
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

    // Honor the availability result (memoized). Gating on wrapperPath alone is
    // unsafe: getAvailability() sets wrapperPath when landrun is found but may
    // still cache unavailable if the enforcement probe failed. Running anyway
    // would execute landrun --best-effort and report sandboxed: true while not
    // actually enforcing — the exact fallback the probe exists to prevent.
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

      // Add read-only and read-write policy paths, filtered to those that exist
      // (landrun aborts ruleset construction on a non-existent grant path).
      args.push(...buildGrantArgs('--ro', options.readOnlyPaths));
      args.push(...buildGrantArgs('--rw', options.readWritePaths));

      // Add the system paths needed to exec the interpreter and load libraries
      // (granted --rox), filtered to those present on this host.
      args.push(...buildSystemPathArgs());

      // Grant the device nodes a command opens directly (e.g. /dev/null).
      args.push(...buildDevicePathArgs());

      // Enhance PATH to include node_modules/.bin for local package binaries.
      const enhancedEnv = {
        ...options.env,
        PATH: buildEnhancedPathFromEnv(options.cwd, options.env),
      };

      // landrun runs the sandboxed command with an EMPTY environment unless each
      // variable is explicitly forwarded. Without this, PATH never reaches the
      // command and `#!/usr/bin/env node` shebangs (rdx, rd, npm — all under
      // /usr/local/bin) fail with exit 127 because /usr/local/bin is absent from
      // glibc's fallback PATH. Use the `--env KEY` pass-through form (not
      // `--env KEY=VALUE`) so values are read from landrun's own environment
      // (set on spawn below) rather than placed in argv, where they would be
      // world-visible via /proc/<pid>/cmdline. The env reaching here is already
      // policy-filtered by the executor, so forwarding every key leaks nothing
      // the policy means to block.
      for (const key of Object.keys(enhancedEnv)) {
        args.push('--env', key);
      }

      // Execute the command. Keep '/bin/sh -c <command>' as the final three argv
      // elements (after the `--` delimiter); env/grant flags must precede them.
      args.push('--', '/bin/sh', '-c', command);

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
