/**
 * macOS Seatbelt sandbox implementation.
 *
 * Uses sandbox-exec with dynamically generated Seatbelt profiles
 * to enforce file access restrictions at the OS level.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { isError } from '../errors.js';
import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

function buildEnhancedPathFromEnv(cwd: string, env: Record<string, string>): string {
  const binPath = join(cwd, 'node_modules', '.bin');
  const existingPath = env.PATH || env.Path || '';
  return existingPath ? `${binPath}:${existingPath}` : binPath;
}

/**
 * Get paths required for Node.js and CLI execution.
 * Returns the directories containing the Node.js binary and the CLI script.
 *
 * @returns Array of paths to allow for execution
 */
function getNodeExecutionPaths(): string[] {
  const paths: string[] = [];

  try {
    // Get the real path to the current Node.js executable
    const nodeExecutable = process.execPath;
    const realNodePath = realpathSync(nodeExecutable);
    const nodeBinDir = dirname(realNodePath);

    // Allow the Node.js installation directory
    // Go up to the installation root (e.g., .../node/24.9.0 for mise)
    const nodeInstallDir = dirname(nodeBinDir);
    paths.push(nodeInstallDir);

    // Also allow the parent directory for version managers like mise
    // (e.g., ~/.local/share/mise/installs)
    const versionManagerDir = dirname(nodeInstallDir);
    if (
      versionManagerDir.includes('mise') ||
      versionManagerDir.includes('nvm') ||
      versionManagerDir.includes('nodenv')
    ) {
      paths.push(versionManagerDir);
    }
  } catch {
    // Fallback: allow common Node.js installation paths
  }

  return paths;
}

/**
 * Cached script directory path (computed once)
 */
let cachedScriptDir: string | null = null;

/**
 * Get the directory containing the currently running script.
 * This helps allow reading the CLI package when symlinked.
 *
 * @returns Path to the script directory, or null if not determinable
 */
function getScriptDirectory(): string | null {
  if (cachedScriptDir !== null) {
    return cachedScriptDir === '' ? null : cachedScriptDir;
  }

  try {
    // process.argv[1] contains the path to the script being executed
    // This works in both CommonJS and ESM
    const scriptPath = process.argv[1];
    if (scriptPath) {
      // Resolve symlinks to get the real path
      const realPath = realpathSync(scriptPath);
      // Go up several levels to get the package root
      // (e.g., from packages/cli/dist/cli.js to packages/cli)
      let dir = dirname(realPath);
      // Go up to find package.json or stop at reasonable depth
      for (let i = 0; i < 3; i++) {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      cachedScriptDir = dir;
      return dir;
    }
  } catch {
    // Script path resolution failed
  }

  cachedScriptDir = '';
  return null;
}

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
  // Escape paths for Seatbelt (handle special characters).
  // Order matters: backslashes first, then quotes, then control chars
  // to prevent C-string truncation or Seatbelt parser confusion.
  const escapePath = (p: string): string =>
    p
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\0/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');

  // Build read-only path rules from policy
  const readOnlyRules = options.readOnlyPaths
    .map((p) => `(allow file-read* (subpath "${escapePath(p)}"))`)
    .join('\n');

  // Build read-write path rules from policy
  const readWriteRules = options.readWritePaths
    .map((p) => `(allow file-read* file-write* (subpath "${escapePath(p)}"))`)
    .join('\n');

  const denyRules = options.denyPaths
    .flatMap((p) => [
      `(deny file-read* file-write* (literal "${escapePath(p)}"))`,
      `(deny file-read* file-write* (subpath "${escapePath(p)}"))`,
    ])
    .join('\n');

  // Get Node.js execution paths dynamically
  const executionPaths = getNodeExecutionPaths();

  // Add the script directory if available (for symlinked CLI)
  const scriptDir = getScriptDirectory();
  if (scriptDir) {
    executionPaths.push(scriptDir);
  }

  const nodePathRules = executionPaths
    .filter((p) => p) // Remove empty strings
    .map((p) => `  (subpath "${escapePath(p)}")`)
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
  (literal "/")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/System")
  (subpath "/Library")
  (subpath "/dev")
  (literal "/etc")
  (literal "/tmp")
  (literal "/var")
  (literal "/private")
  (subpath "/private/etc")
  (subpath "/private/var/db")
  (subpath "/private/var/select")
  (subpath "/private/tmp")
)

;; Allow metadata operations (lstat, stat) on /private/var for path traversal
;; This is needed for Node.js module resolution through temp directories
;; but does NOT allow reading file contents (file-read-data)
(allow file-read-metadata
  (subpath "/private/var")
)

;; Allow /dev access for stdio
(allow file-read* file-write*
  (subpath "/dev/fd")
  (subpath "/dev/null")
  (subpath "/dev/tty")
  (subpath "/dev/urandom")
  (subpath "/dev/random")
)

;; Allow reading from common package manager locations
(allow file-read*
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
)

;; Allow reading from Node.js installation paths (detected dynamically)
(allow file-read*
${nodePathRules}
)

;; Allow read/write to the cwd node_modules for local package binaries
(allow file-read*
  (subpath "${escapePath(join(options.cwd, 'node_modules'))}")
)

;; Explicit deny paths (derived from effective policy)
;; Must appear before allow rules — seatbelt uses first-match-wins
${denyRules}

;; Custom read-only paths (from policy)
${readOnlyRules}

;; Custom read-write paths (from policy)
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
        supportsDenyPaths: false,
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
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    }

    // Verify that sandbox-exec can actually apply a profile in this
    // environment, not just that the binary exists. Some CI/container
    // configurations expose /usr/bin/sandbox-exec but deny profile
    // application with EPERM.
    const profilePath = join(tmpdir(), `rundown-sandbox-probe-${randomUUID()}.sb`);
    try {
      writeFileSync(profilePath, '(version 1)\n(allow default)\n', { mode: 0o600 });
      // Probe with /usr/bin/true: macOS ships no /bin/true, and an ENOENT exec
      // would falsely report the sandbox unavailable (#544) — which under the
      // fail-closed strict default denies every command step.
      const probe = spawnSync('/usr/bin/sandbox-exec', ['-f', profilePath, '/usr/bin/true'], {
        stdio: 'ignore',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });
      const available: boolean = probe.status === 0 && probe.error == null;
      this.availabilityCache = available
        ? {
            available: true,
            mechanism: 'seatbelt',
            platform: process.platform,
            supportsReadRestrictions: true,
            supportsWriteRestrictions: true,
            supportsDenyPaths: true,
          }
        : {
            available: false,
            mechanism: 'none',
            reason: `sandbox-exec could not run in this environment${probe.error ? `: ${probe.error.message}` : ''}`,
            platform: process.platform,
            supportsReadRestrictions: false,
            supportsWriteRestrictions: false,
            supportsDenyPaths: false,
          };
      return Promise.resolve(this.availabilityCache);
    } catch (error: unknown) {
      const reason = isError(error) ? error.message : String(error);
      this.availabilityCache = {
        available: false,
        mechanism: 'none',
        reason: `sandbox-exec probe failed: ${reason}`,
        platform: process.platform,
        supportsReadRestrictions: false,
        supportsWriteRestrictions: false,
        supportsDenyPaths: false,
      };
      return Promise.resolve(this.availabilityCache);
    } finally {
      try {
        unlinkSync(profilePath);
      } catch {
        // Ignore cleanup errors
      }
    }
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
    const profilePath = join(tmpdir(), `rundown-sandbox-${randomUUID()}.sb`);

    try {
      // Write profile to temp file
      writeFileSync(profilePath, profile, { mode: 0o600 });

      // Execute with sandbox-exec
      return await this.executeWithProfile(command, profilePath, options);
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
   * @param options - Sandbox options including cwd and env
   * @returns Execution result
   */
  private executeWithProfile(
    command: string,
    profilePath: string,
    options: SandboxOptions,
  ): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      // Enhance PATH to include node_modules/.bin for local package binaries
      const enhancedEnv = {
        ...options.env,
        PATH: buildEnhancedPathFromEnv(options.cwd, options.env),
      };

      const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '/bin/sh', '-c', command], {
        cwd: options.cwd,
        stdio: 'inherit',
        env: enhancedEnv,
      });

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
