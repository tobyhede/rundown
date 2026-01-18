/**
 * macOS Seatbelt sandbox implementation.
 *
 * Uses sandbox-exec with dynamically generated Seatbelt profiles
 * to enforce file access restrictions at the OS level.
 *
 * @module
 */

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

/**
 * Generate a Seatbelt profile for the given sandbox options.
 *
 * The profile uses the Scheme-like Seatbelt DSL to define
 * file access restrictions.
 *
 * @param options - Sandbox options with path restrictions
 * @returns Seatbelt profile content
 */
function generateSeatbeltProfile(options: SandboxOptions): string {
  // Escape paths for Seatbelt (handle special characters)
  const escapePath = (p: string): string => p.replace(/"/g, '\\"');

  // Build read-only path rules
  const readOnlyRules = options.readOnlyPaths
    .map(p => `(allow file-read* (subpath "${escapePath(p)}"))`)
    .join('\n');

  // Build read-write path rules
  const readWriteRules = options.readWritePaths
    .map(p => `(allow file-read* file-write* (subpath "${escapePath(p)}"))`)
    .join('\n');

  // Note: Seatbelt doesn't have a direct "deny subpath" after allowing parent.
  // The approach is to be specific about what's allowed.
  // Deny paths are handled by not including them in allow rules.

  return `
(version 1)

;; Default deny all file operations
(deny default)

;; Allow process execution
(allow process-exec)
(allow process-fork)

;; Allow basic system operations
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow system-socket)

;; Allow reading system paths (required for shell execution)
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System")
  (subpath "/Library/Frameworks")
  (subpath "/Library/Preferences")
  (subpath "/private/var/db")
  (subpath "/private/etc")
  (subpath "/dev")
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private")
)

;; Allow /dev access for stdio
(allow file-read* file-write*
  (subpath "/dev/fd")
  (subpath "/dev/null")
  (subpath "/dev/tty")
  (subpath "/dev/urandom")
  (subpath "/dev/random")
)

;; Allow temp directory access
(allow file-read* file-write*
  (subpath "/private/tmp")
  (subpath "/var/folders")
  (subpath "${escapePath(tmpdir())}")
)

;; Allow user home directory basics
(allow file-read*
  (subpath "/Users/Shared")
)

;; Custom read-only paths
${readOnlyRules}

;; Custom read-write paths
${readWriteRules}

;; Allow network (can be restricted further if needed)
(allow network-outbound)
(allow network-inbound)
`;
}

/**
 * Seatbelt sandbox implementation for macOS.
 *
 * Uses the sandbox-exec command which is built into macOS since 10.5.
 * Note: While sandbox-exec is deprecated for new development, it remains
 * functional and is used by production tools like Claude Code.
 */
export class SeatbeltSandbox implements SandboxImplementation {
  private availabilityCache: SandboxAvailability | null = null;

  /**
   * Check if sandbox-exec is available.
   *
   * @returns True if sandbox-exec exists and is executable
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

    // Check if we're on macOS
    if (process.platform !== 'darwin') {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: 'Seatbelt is only available on macOS',
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    // Check if sandbox-exec exists
    const sandboxExecPath = '/usr/bin/sandbox-exec';
    if (!existsSync(sandboxExecPath)) {
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: 'sandbox-exec not found at /usr/bin/sandbox-exec',
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    this.availabilityCache = {
      available: true,
      mechanism: 'seatbelt',
      platform: process.platform,
      supportsReadRestrictions: true,
      supportsWriteRestrictions: true,
    };
    return Promise.resolve(this.availabilityCache);
  }

  /**
   * Execute a command with Seatbelt sandbox restrictions.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options with path restrictions
   * @returns Execution result
   */
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    // Generate profile
    const profile = generateSeatbeltProfile(options);
    const profilePath = join(tmpdir(), `rundown-sandbox-${String(Date.now())}-${Math.random().toString(36).slice(2)}.sb`);

    try {
      // Write profile to temp file
      writeFileSync(profilePath, profile, { mode: 0o600 });

      // Execute with sandbox-exec
      return await this.executeWithProfile(command, profilePath, options.cwd);
    } finally {
      // Clean up profile file
      try {
        unlinkSync(profilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Execute a command using a Seatbelt profile file.
   *
   * @param command - The shell command to execute
   * @param profilePath - Path to the Seatbelt profile
   * @param cwd - Working directory
   * @returns Execution result
   */
  private executeWithProfile(
    command: string,
    profilePath: string,
    cwd: string
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const child = spawn(
        '/usr/bin/sandbox-exec',
        ['-f', profilePath, '/bin/sh', '-c', command],
        {
          cwd,
          stdio: 'inherit',
          env: process.env,
        }
      );

      child.on('close', (code) => {
        // Exit code 1 with sandbox-exec can mean sandbox violation
        // The actual violation info would be in system logs
        const exitCode = code ?? 1;

        resolve({
          success: exitCode === 0,
          exitCode,
          sandboxed: true,
          // Sandbox violations typically result in EPERM errors
          // which manifest as non-zero exit codes
          policyDenied: exitCode !== 0 ? undefined : false,
        });
      });

      child.on('error', (err) => {
        resolve({
          success: false,
          exitCode: 1,
          sandboxed: true,
          policyDenied: true,
          denialReason: `Sandbox execution error: ${err.message}`,
        });
      });
    });
  }
}
