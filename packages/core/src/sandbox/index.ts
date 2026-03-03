/**
 * OS-level Sandbox System for Rundown
 *
 * Provides kernel-level file access enforcement using:
 * - Linux: Landlock LSM (kernel 5.13+)
 * - macOS: Seatbelt (sandbox-exec)
 *
 * This follows the approach used by OpenAI Codex CLI and Claude Code,
 * where argument parsing is insufficient for security and OS-level
 * enforcement is required.
 *
 * @module
 */

import { executeCommandWithEnv } from '../runbook/executor.js';
import type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

// Re-export types
export type {
  SandboxOptions,
  SandboxExecutionResult,
  SandboxAvailability,
  SandboxImplementation,
} from './types.js';

// Lazy-loaded implementations
let landlockImpl: SandboxImplementation | null = null;
let seatbeltImpl: SandboxImplementation | null = null;

/**
 * Get the appropriate sandbox implementation for the current platform.
 *
 * @returns The sandbox implementation or null if none available
 */
async function getSandboxImplementation(): Promise<SandboxImplementation | null> {
  const platform = process.platform;

  if (platform === 'linux') {
    if (!landlockImpl) {
      const { LandlockSandbox } = await import('./linux.js');
      landlockImpl = new LandlockSandbox();
    }
    if (await landlockImpl.isAvailable()) {
      return landlockImpl;
    }
  }

  if (platform === 'darwin') {
    if (!seatbeltImpl) {
      const { SeatbeltSandbox } = await import('./macos.js');
      seatbeltImpl = new SeatbeltSandbox();
    }
    if (await seatbeltImpl.isAvailable()) {
      return seatbeltImpl;
    }
  }

  return null;
}

/**
 * Check sandbox availability on the current platform.
 *
 * @returns Information about sandbox availability
 */
export async function checkSandboxAvailability(): Promise<SandboxAvailability> {
  const platform = process.platform;

  if (platform === 'linux') {
    if (!landlockImpl) {
      const { LandlockSandbox } = await import('./linux.js');
      landlockImpl = new LandlockSandbox();
    }
    return landlockImpl.getAvailability();
  }

  if (platform === 'darwin') {
    if (!seatbeltImpl) {
      const { SeatbeltSandbox } = await import('./macos.js');
      seatbeltImpl = new SeatbeltSandbox();
    }
    return seatbeltImpl.getAvailability();
  }

  // Unsupported platform
    return {
      available: false,
      mechanism: 'none',
      reason: `Sandbox not supported on platform: ${platform}. Use WSL on Windows.`,
      platform,
      supportsReadRestrictions: false,
      supportsWriteRestrictions: false,
      supportsDenyPaths: false,
    };
  }

/**
 * Execute a command with OS-level sandbox restrictions.
 *
 * If sandboxing is available on the current platform, the command will be
 * executed with file access restricted according to the provided options.
 * If sandboxing is unavailable and allowUnsandboxed is true, the command
 * will execute without restrictions (with a warning).
 *
 * @param command - The shell command to execute
 * @param options - Sandbox options including allowed paths
 * @returns Execution result with sandbox status
 *
 * @example
 * ```typescript
 * const result = await executeWithSandbox('cat /etc/passwd', {
 *   cwd: '/home/user/project',
 *   repoRoot: '/home/user/project',
 *   readOnlyPaths: ['/home/user/project'],
 *   readWritePaths: ['/tmp'],
 *   denyPaths: ['/etc/passwd'],
 *   allowUnsandboxed: false,
 * });
 *
 * if (result.policyDenied) {
 *   console.error('Blocked by sandbox:', result.denialReason);
 * }
 * ```
 */
export async function executeWithSandbox(
  command: string,
  options: SandboxOptions,
): Promise<SandboxExecutionResult> {
  const impl = await getSandboxImplementation();

  if (impl) {
    return impl.execute(command, options);
  }

  // Fallback: no sandbox available
  if (!options.allowUnsandboxed) {
    return {
      success: false,
      exitCode: 126,
      policyDenied: true,
      denialReason: 'Sandbox unavailable and --allow-unsandboxed not set',
      sandboxed: false,
    };
  }

  // Execute without sandbox (trust mode)
  console.warn('Warning: Executing without sandbox. File policies not enforced.');
  const result = await executeCommandWithEnv(command, options.cwd, options.env);

  return {
    ...result,
    sandboxed: false,
  };
}

/**
 * Check if sandbox is available on the current platform.
 *
 * @returns True if any sandbox mechanism is available
 */
export async function isSandboxAvailable(): Promise<boolean> {
  const availability = await checkSandboxAvailability();
  return availability.available;
}
