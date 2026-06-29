// workflow/hooks/rundown.ts
// Helper for executing rundown CLI from installed dependency

import { createRequire } from 'node:module';
import { execFileSync as nodeExecFileSync, type ExecFileSyncOptions } from 'node:child_process';
import {
  bareRoleSpecificMutation,
  delegateClaimIdValidationError,
  subprocessMutationWithheldMessage,
} from '@rundown-org/core';

const require = createRequire(import.meta.url);

// Allow injection for testing
let execFileSyncImpl: typeof nodeExecFileSync = nodeExecFileSync;

/**
 * Replace the execFileSync implementation (for testing).
 *
 * @param fn - Replacement function matching the execFileSync signature
 */
export function setExecSync(fn: typeof nodeExecFileSync): void {
  execFileSyncImpl = fn;
}

/**
 * Get the path to the rundown CLI entry point.
 * Uses require.resolve to find the installed `@rundown-org/cli` package.
 * @returns Absolute path to the CLI entry point module
 * @throws {Error} If `@rundown-org/cli` package cannot be resolved
 */
export function getRundownCliPath(): string {
  return require.resolve('@rundown-org/cli');
}

/** Options for executing a rundown CLI command. */
export interface RundownExecOptions {
  /** Environment variables to merge over the current process environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Execute a rundown CLI command.
 *
 * Uses execFileSync to avoid shell interpretation and prevent command injection.
 *
 * @param args - Command arguments as array (e.g., ['pass', '--claim-id', 'abc123'])
 * @param cwd - Working directory for the command
 * @param execOptions - Optional execution settings such as environment overrides
 * @returns Command output as string
 * @throws {Error} If `args` is a bare (no `--claim-id`) `pass` / `fail` /
 *   `delegate` mutation — the subprocess trust boundary withholds it rather than
 *   let it silently inherit direct-CLI trust.
 */
export function rundown(args: string[], cwd: string, execOptions: RundownExecOptions = {}): string {
  const delegateValidation = delegateClaimIdValidationError(args);
  if (delegateValidation !== undefined) {
    throw new Error(delegateValidation.message);
  }

  // Subprocess trust boundary: this helper is the single choke point for every
  // plugin->CLI spawn. A bare (no `--claim-id`) `pass` / `fail` / `delegate`
  // would arrive at the CLI as an ordinary argv and silently inherit direct-CLI
  // trust over the active run. Fail closed by withholding it here; `--claim-id`
  // mutations carry independent claim evidence and read-only commands pass
  // through. See subprocess-mutation-boundary.ts.
  const withheld = bareRoleSpecificMutation(args);
  if (withheld !== undefined) {
    throw new Error(subprocessMutationWithheldMessage(withheld));
  }
  const cliPath = getRundownCliPath();
  const options: ExecFileSyncOptions = {
    cwd,
    ...(execOptions.env ? { env: { ...process.env, ...execOptions.env } } : {}),
    stdio: 'pipe',
    encoding: 'utf-8',
  };
  return execFileSyncImpl('node', [cliPath, ...args], options) as string;
}
