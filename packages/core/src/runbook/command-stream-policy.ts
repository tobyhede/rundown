import type { ChildProcess, StdioOptions } from 'node:child_process';

/**
 * Runtime routing for stdout/stderr emitted by a command subprocess.
 */
export type CommandOutputStreamPolicy = 'inherit' | 'stderr';

/**
 * Runtime-only stream options for command subprocess execution.
 */
export interface CommandExecutionStreamOptions {
  /** Where command stdout/stderr should be routed. Defaults to inherited stdio. */
  readonly commandOutput?: CommandOutputStreamPolicy;
}

/**
 * Convert a command output policy into Node stdio options.
 *
 * @param policy - Runtime stream routing policy, or undefined for inherited stdio.
 * @returns Stdio configuration for `child_process.spawn`.
 */
export function stdioForCommandOutput(policy: CommandOutputStreamPolicy | undefined): StdioOptions {
  return policy === 'stderr' ? ['inherit', 'pipe', 'pipe'] : 'inherit';
}

/**
 * Forward piped command stdout/stderr chunks to the parent stderr stream.
 *
 * @param child - Spawned command process.
 * @param policy - Runtime stream routing policy, or undefined for inherited stdio.
 */
export function pipeCommandOutputToStderr(
  child: ChildProcess,
  policy: CommandOutputStreamPolicy | undefined,
): void {
  if (policy !== 'stderr') return;
  forwardCommandStreamToStderr(child.stdout);
  forwardCommandStreamToStderr(child.stderr);
}

function forwardCommandStreamToStderr(stream: ChildProcess['stdout']): void {
  if (!stream) return;
  stream.on('error', () => {
    /* Stream errors are already reflected in command lifecycle events. */
  });
  if (typeof stream.pipe === 'function') {
    stream.pipe(process.stderr, { end: false });
    return;
  }
  stream.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });
}
