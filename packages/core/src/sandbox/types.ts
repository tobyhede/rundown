/**
 * Types for OS-level sandbox enforcement.
 *
 * Provides type definitions for the sandbox system that enforces
 * file access policies at the OS level using Landlock (Linux) or
 * Seatbelt (macOS).
 *
 * @module
 */

/**
 * Options for sandbox execution.
 */
export interface SandboxOptions {
  /** Working directory for command execution */
  cwd: string;

  /** Repository root path (for read-only access by default) */
  repoRoot: string;

  /** Paths that should be readable (read-only access) */
  readOnlyPaths: string[];

  /** Paths that should be writable (read-write access) */
  readWritePaths: string[];

  /** Paths that should be explicitly denied (overrides allow) */
  denyPaths: string[];

  /** Whether to allow execution without sandbox if unavailable */
  allowUnsandboxed?: boolean;
}

/**
 * Result of a sandboxed command execution.
 */
export interface SandboxExecutionResult {
  /** True if the command exited with code 0 */
  success: boolean;

  /** The numeric exit code from the process */
  exitCode: number;

  /** Whether the command was denied by policy/sandbox */
  policyDenied?: boolean;

  /** Reason for denial if command was blocked */
  denialReason?: string;

  /** Whether sandbox was actually used for this execution */
  sandboxed: boolean;

  /** Standard output from the command (if captured) */
  stdout?: string;

  /** Standard error from the command (if captured) */
  stderr?: string;
}

/**
 * Information about sandbox availability on the current platform.
 */
export interface SandboxAvailability {
  /** Whether any sandbox mechanism is available */
  available: boolean;

  /** The sandbox mechanism being used */
  mechanism: 'landlock' | 'seatbelt' | 'none';

  /** Detailed reason if sandbox is unavailable */
  reason?: string;

  /** Platform information */
  platform: NodeJS.Platform;

  /** Whether the sandbox supports file read restrictions */
  supportsReadRestrictions: boolean;

  /** Whether the sandbox supports file write restrictions */
  supportsWriteRestrictions: boolean;
}

/**
 * Executor function type for sandbox implementations.
 */
export type SandboxExecutor = (
  command: string,
  options: SandboxOptions
) => Promise<SandboxExecutionResult>;

/**
 * Sandbox implementation interface.
 */
export interface SandboxImplementation {
  /** Check if this sandbox mechanism is available */
  isAvailable(): Promise<boolean>;

  /** Get availability information */
  getAvailability(): Promise<SandboxAvailability>;

  /** Execute a command with sandbox restrictions */
  execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult>;
}
