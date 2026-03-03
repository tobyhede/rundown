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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

/**
 * Check if Landlock is enabled in the kernel.
 *
 * @returns True if Landlock is available
 */
function isLandlockKernelSupported(): boolean {
  try {
    // Check /sys/kernel/security/lsm for landlock
    const lsmPath = '/sys/kernel/security/lsm';
    if (existsSync(lsmPath)) {
      const lsm = readFileSync(lsmPath, 'utf8');
      return lsm.includes('landlock');
    }

    // Alternative: check /proc/sys/kernel/unprivileged_userns_clone
    // Landlock doesn't require this, but it's often a good indicator
    // of a modern kernel with security features

    return false;
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

    // Check if Landlock is supported by kernel
    if (!isLandlockKernelSupported()) {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: 'Landlock not enabled in kernel. Requires Linux 5.13+ with Landlock LSM enabled.',
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    // Check for wrapper executable
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
      // Build landrun arguments
      const args: string[] = [];

      // Add read-only paths
      for (const path of options.readOnlyPaths) {
        args.push('--ro', path);
      }

      // Add read-write paths
      for (const path of options.readWritePaths) {
        args.push('--rw', path);
      }

      // Add system paths that are typically needed
      args.push('--ro', '/usr');
      args.push('--ro', '/bin');
      args.push('--ro', '/sbin');
      args.push('--ro', '/lib');
      args.push('--ro', '/lib64');
      args.push('--ro', '/etc');

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
  const existingPath = env.PATH ?? env.Path ?? '';
  return existingPath ? `${binPath}:${existingPath}` : binPath;
}
