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

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
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

/** System paths granted read + execute (interpreter, libraries). */
const SYSTEM_EXEC_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64'];

/** System paths granted read-only (config, CA bundles, name resolution). */
const SYSTEM_READ_PATHS = ['/etc'];

/** Device nodes a command opens directly (e.g. `> /dev/null`), granted rw. */
const DEVICE_RW_PATHS = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom'];

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
  /** Startup window (ms) for the fd-4 status line; default 5000. Test seam. */
  statusTimeoutMs?: number;
  /** Test seam: an extra inherited stdio fd appended as fd 5. */
  extraStdioFd?: number;
  /** Grace (ms) between SIGTERM and SIGKILL during teardown; default 1000. */
  teardownGraceMs?: number;
  /** Max wait (ms) for confirmed reap before teardown is declared failed; default 5000. */
  teardownReapMs?: number;
}

/** The JSON spec written to the helper's fd 3. */
export interface LandlockSpec {
  command: string;
  strict: boolean;
  ro: string[];
  rox: string[];
  rw: string[];
  network: 'deny' | 'allow';
}

/**
 * Filter a list of paths to only those that exist on the filesystem.
 *
 * Landlock aborts if a grant path does not exist. Non-existent paths are
 * logged at debug level and filtered out to prevent execution failure.
 *
 * @param paths - List of paths to filter.
 * @returns Paths that exist, as determined by existsSync.
 */
function existing(paths: string[]): string[] {
  return paths.filter((p) => {
    if (existsSync(p)) return true;
    void logger.debug('sandbox: skipping non-existent grant path', { path: p });
    return false;
  });
}

/**
 * Build the fd-3 spec from sandbox options. Grant categories mirror the old
 * landrun flags: `rox` system exec paths, `ro` policy reads + `/etc`, `rw`
 * policy writes + device nodes. All filtered to existing paths (Landlock
 * aborts on a missing grant path). `strict = !allowUnsandboxed`.
 *
 * @param command - Shell command to run under the sandbox.
 * @param options - Resolved sandbox options.
 * @returns The spec object serialised to fd 3.
 */
export function buildSpec(command: string, options: SandboxOptions): LandlockSpec {
  return {
    command,
    strict: !options.allowUnsandboxed,
    rox: existing(SYSTEM_EXEC_PATHS),
    ro: existing([...options.readOnlyPaths, ...SYSTEM_READ_PATHS]),
    rw: existing([...options.readWritePaths, ...DEVICE_RW_PATHS]),
    network: options.network,
  };
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
 * Prepend the local `node_modules/.bin` directory to PATH for the helper's
 * spawned command, mirroring the old landrun backend's behaviour so scripts
 * can invoke locally-installed binaries without an absolute path.
 *
 * @param cwd - Working directory the command runs in.
 * @param env - The base environment to enhance.
 * @returns The enhanced PATH value.
 */
function buildEnhancedPathFromEnv(cwd: string, env: Record<string, string>): string {
  const binPath = join(cwd, 'node_modules', '.bin');
  const existingPath = env.PATH || env.Path || '';
  return existingPath ? `${binPath}:${existingPath}` : binPath;
}

/**
 * Forward terminal interrupts (`SIGINT`/`SIGTERM`) to a detached sandbox child's
 * process group, then re-raise so this process still terminates as it did before
 * the child was detached.
 *
 * The helper is spawned `detached` (Task 19 needs it a process-group leader so
 * the whole group — including any grandchildren — can be torn down). A side
 * effect is that terminal-generated signals reach only Rundown's process group,
 * not the command's, so a `Ctrl-C` would otherwise leave the sandboxed command
 * running after the CLI is interrupted (unlike the previous non-detached spawn).
 * This restores the prior behaviour: the signal is delivered to the command's
 * group (`kill(-pid)`), then re-raised to this process so its default
 * disposition runs (critically, `SIGTERM` must still be able to stop Rundown
 * while a command is running).
 *
 * @param child - The detached child (its `pid` leads the target group)
 * @returns A cleanup function that removes the installed signal listeners; call
 *   it once the command has settled so the handlers do not leak across commands
 */
export function installInterruptForwarding(child: ChildProcess): () => void {
  function forward(signal: NodeJS.Signals): void {
    if (child.pid != null) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone; nothing to forward to.
      }
    }
    // Restore the default disposition and re-raise so the CLI terminates as it
    // did before detaching (the terminal previously signalled both).
    cleanup();
    try {
      process.kill(process.pid, signal);
    } catch {
      // No default action available; nothing more to do.
    }
  }
  function cleanup(): void {
    process.removeListener('SIGINT', forward);
    process.removeListener('SIGTERM', forward);
  }
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  return cleanup;
}

/** Hard cap on the fd-4 status buffer; overflow is a protocol violation. */
const MAX_STATUS_BYTES = 8192;
/** Default startup window for the fd-4 status line to arrive. */
const DEFAULT_STATUS_TIMEOUT_MS = 5000;

/** Parsed fd-4 status. */
type HelperStatus =
  | { status: 'applied'; abi: number; downgraded: boolean; network: 'deny' | 'allow' }
  | { status: 'denied'; abi: number; missing: string }
  | { status: 'error'; message: string };

function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function isNetworkPolicy(v: unknown): v is 'deny' | 'allow' {
  return v === 'deny' || v === 'allow';
}

/**
 * Schema-strict parse of a single fd-4 status line. Every variant's required
 * fields must be present with the right types, or the line is rejected
 * (→ null → protocol violation → fail closed). `{"status":"applied"}` (missing
 * abi) and `{"status":"applied","abi":"3",...}` (wrong type) are NOT accepted.
 *
 * @param line - One status line (no trailing newline).
 * @returns The validated status, or `null` if malformed.
 */
export function parseStatus(line: string): HelperStatus | null {
  let v: unknown;
  try {
    v = JSON.parse(line.trim());
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  switch (o.status) {
    case 'applied':
      return isPositiveInteger(o.abi) &&
        typeof o.downgraded === 'boolean' &&
        isNetworkPolicy(o.network)
        ? { status: 'applied', abi: o.abi, downgraded: o.downgraded, network: o.network }
        : null;
    case 'denied':
      return isPositiveInteger(o.abi) && typeof o.missing === 'string'
        ? { status: 'denied', abi: o.abi, missing: o.missing }
        : null;
    case 'error':
      return typeof o.message === 'string' ? { status: 'error', message: o.message } : null;
    default:
      return null;
  }
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
  private readonly statusTimeoutMs: number;
  private readonly extraStdioFd?: number;
  private readonly teardownGraceMs: number;
  private readonly teardownReapMs: number;

  /**
   * Construct a LandlockSandbox.
   *
   * @param opts - Test seams: `helperPath` overrides arch resolution
   *   (`null` simulates an unsupported architecture); `distRoot` overrides
   *   the core `dist` root used to resolve the bundled helper; `probeEnv`
   *   supplies extra environment variables for the `--probe` invocation;
   *   `statusTimeoutMs` overrides the fd-4 status startup window;
   *   `extraStdioFd` appends an extra inherited stdio fd (fd 5) to the
   *   helper spawn; `teardownGraceMs` / `teardownReapMs` override the
   *   SIGTERM→SIGKILL grace and the confirmed-reap window used by
   *   `terminateGroup`.
   */
  constructor(opts: LandlockSandboxOptions = {}) {
    const distRoot = opts.distRoot ?? defaultDistRoot();
    this.helperPath =
      opts.helperPath !== undefined ? opts.helperPath : resolveHelperPath(process.arch, distRoot);
    this.probeEnv = opts.probeEnv ?? {};
    this.statusTimeoutMs = opts.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
    this.extraStdioFd = opts.extraStdioFd;
    this.teardownGraceMs = opts.teardownGraceMs ?? 1000;
    this.teardownReapMs = opts.teardownReapMs ?? 5000;
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
    // closed instead of throwing out of this synchronous helper. `parsed`'s
    // declared type reflects the *expected* shape, not the actual runtime
    // value: JSON.parse returns `any` for output from an external process, so
    // `null`/non-object is reachable at runtime even though TS can't see it.
    // This is a load-bearing fail-closed guard, not dead code.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
   * Runs two preflight checks before delegating to the helper:
   * 1. Deny-path preflight: Landlock is allow-list-only and cannot enforce
   *    deny exceptions from an allowed subtree, so any deny policy is
   *    unenforceable and must block execution to avoid policy weakening.
   * 2. Availability check: If Landlock is unavailable, block execution with
   *    exit 126 and the unavailability reason.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options with path restrictions
   * @returns Execution result with exit code, stdout/stderr, and policy denial status
   */
  async execute(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    // Deny preflight: Landlock is allow-list-only and cannot carve a deny
    // exception out of an allowed subtree, so any deny policy is unenforceable
    // and must block *before* the helper is spawned (preserves linux.ts:320).
    if (options.denyPatterns.length > 0 || options.denyPaths.length > 0) {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        denialReason:
          'Linux sandbox backend cannot safely enforce deny-path policy. ' +
          'Execution was blocked to avoid weakening policy. Disable sandbox only for trusted runs.',
        networkPolicy: options.network,
        networkSandboxed: false,
      };
    }

    const availability = await this.getAvailability();
    if (!availability.available) {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        denialReason: availability.reason,
        networkPolicy: options.network,
        networkSandboxed: false,
      };
    }

    return this.runHelper(command, options); // filled in Task 17
  }

  /**
   * Delegate command execution to the rd-landlock helper.
   *
   * Spawns the helper detached with fd 3 (spec-in) and fd 4 (status-out)
   * piped, fds 0/1/2 inherited. The decision is driven by the first complete
   * newline-delimited fd-4 status line as soon as it arrives — never by
   * waiting for the child's `close` first — so a helper that emits a bad
   * status then hangs is still torn down promptly via the startup timeout /
   * buffer cap. The fd-4 buffer is capped at {@link MAX_STATUS_BYTES} and a
   * startup timeout ({@link LandlockSandboxOptions.statusTimeoutMs}) bounds a
   * silent hang.
   *
   * @param command - The shell command to execute
   * @param options - Sandbox options with path restrictions
   * @returns The execution result: `applied` runs to completion and surfaces
   *   the command's real exit code (a non-zero exit is not a policy denial);
   *   any protocol violation (missing/malformed/oversized/absent status)
   *   fails closed regardless of `allowUnsandboxed`.
   */
  private runHelper(command: string, options: SandboxOptions): Promise<SandboxExecutionResult> {
    return new Promise((resolve) => {
      const env = {
        ...options.env,
        PATH: buildEnhancedPathFromEnv(options.cwd, options.env),
      };
      const spec = buildSpec(command, options);

      // fds 0/1/2 inherited; fd 3 = spec-in; fd 4 = status-out; detached so the
      // helper leads its own process group (see terminateGroup, Task 19).
      const stdio: Array<'inherit' | 'pipe' | number> = [
        'inherit',
        'inherit',
        'inherit',
        'pipe',
        'pipe',
      ];
      if (this.extraStdioFd !== undefined) {
        stdio.push(this.extraStdioFd); // fd 5 for tests
      }
      const child = spawn(this.helperPath!, [], {
        cwd: options.cwd,
        env,
        stdio,
        detached: true,
      });

      // `detached` moves the command into its own process group, so terminal
      // interrupts reach only the CLI; forward them to the command's group (and
      // re-raise) so Ctrl-C / kill still stop the sandboxed command.
      const stopForwarding = installInterruptForwarding(child);

      const specPipe = child.stdio[3] as Writable;
      const statusPipe = child.stdio[4] as Readable;

      // A helper that dies (or is torn down by terminateGroup) with fd-3/fd-4
      // data in flight surfaces EPIPE/ECONNRESET on these streams. A stream
      // 'error' with no listener throws and crashes the process, so both pipes
      // need handlers. The result is never decided by a pipe error: the status
      // protocol (data/end), the startup timeout, and child 'close' already
      // settle every path fail-closed.
      const onPipeError = (err: Error): void => {
        void logger.debug('sandbox: rd-landlock stdio pipe error', {
          error: getErrorMessage(err),
        });
      };
      specPipe.on('error', onPipeError);
      statusPipe.on('error', onPipeError);

      let statusRaw = '';
      let statusHandled = false;
      let settled = false;
      let appliedStatus: HelperStatus | null = null;
      let childClosed = false;
      let childCode = 1;

      const settle = (r: SandboxExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        stopForwarding();
        // The decision is final: release the fd-3/fd-4 pipes and the child
        // handle so a helper that outlives the decision (e.g. an unkillable
        // group whose reap was not confirmed) cannot keep the event loop
        // alive through leaked stdio or process handles.
        specPipe.destroy();
        statusPipe.destroy();
        child.unref();
        resolve(r);
      };

      // Act on the first complete status line (or a bounded/absent status).
      const dispatch = (status: HelperStatus | null): void => {
        if (statusHandled) return;
        statusHandled = true;
        clearTimeout(startupTimer);
        if (status?.status === 'applied') {
          // Command is (or will be) running; its exit code arrives on 'close'.
          appliedStatus = status;
          if (childClosed) settle(this.resolveStatus(status, childCode, options.network));
        } else if (status?.status === 'denied') {
          settle(this.resolveStatus(status, 126, options.network));
        } else {
          // error / missing / malformed / oversized / timed-out → protocol
          // violation (Task 19 adds process-group teardown to handleViolation).
          this.handleViolation(child, status, options.network, settle);
        }
      };

      // Startup timeout: the helper must deliver a status line promptly.
      const startupTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        dispatch(null);
      }, this.statusTimeoutMs);

      statusPipe.setEncoding('utf8');
      statusPipe.on('data', (c: string) => {
        if (statusHandled) return;
        statusRaw += c;
        if (statusRaw.length > MAX_STATUS_BYTES) {
          dispatch(null); // unbounded/oversized status → protocol violation
          return;
        }
        const nl = statusRaw.indexOf('\n');
        if (nl !== -1) dispatch(parseStatus(statusRaw.slice(0, nl)));
      });
      statusPipe.on('end', () => {
        // EOF with no newline-terminated line: strict-parse the remainder
        // (empty/partial → null → protocol violation).
        if (!statusHandled) dispatch(parseStatus(statusRaw));
      });

      child.on('error', (err) => {
        settle(
          this.failClosed(`rd-landlock failed to start: ${getErrorMessage(err)}`, options.network),
        );
      });

      child.on('close', (code) => {
        childClosed = true;
        childCode = code ?? 1;
        if (appliedStatus) settle(this.resolveStatus(appliedStatus, childCode, options.network));
      });

      specPipe.write(`${JSON.stringify(spec)}\n`);
      specPipe.end();
    });
  }

  /**
   * Map an `applied`/`denied` status to a result.
   *
   * @param status - The validated fd-4 status (`applied` or `denied`).
   * @param exitCode - The command's real exit code, used only for `applied`
   *   (ignored for `denied`, where the fixed exit code 126 is used instead).
   * @param requestedNetwork - Network posture sent to the helper in the fd-3 spec.
   * @returns The corresponding execution result.
   */
  private resolveStatus(
    status: HelperStatus,
    exitCode: number,
    requestedNetwork: 'deny' | 'allow',
  ): SandboxExecutionResult {
    if (status.status === 'applied') {
      if (requestedNetwork === 'deny' && status.network !== 'deny') {
        return this.failClosed(
          `network policy mismatch: requested deny but helper reported ${status.network}`,
          requestedNetwork,
        );
      }
      return {
        success: exitCode === 0,
        exitCode,
        sandboxed: true,
        policyDenied: false,
        landlockAbi: status.abi,
        enforcementDowngraded: status.downgraded,
        networkPolicy: status.network,
        networkSandboxed: status.network === 'deny',
      };
    }
    // denied — the negotiated ABI fell below the required floor under strict.
    if (status.status === 'denied') {
      return {
        success: false,
        exitCode: 126,
        sandboxed: false,
        policyDenied: true,
        landlockAbi: status.abi,
        networkPolicy: requestedNetwork,
        networkSandboxed: false,
        denialReason:
          `Landlock ABI ${String(status.abi)} (kernel <6.2) cannot enforce ${status.missing}; ` +
          'read-only grants would be bypassable. Refusing under strict mode. ' +
          'Re-run with sandboxStrict:false to override.',
      };
    }
    // unreachable if only called with 'applied' or 'denied'; but this helps TS narrowing
    return this.failClosed('unknown status variant', requestedNetwork);
  }

  /**
   * Handle a protocol violation (error / missing / malformed status). The
   * helper may already have exec'd a command whose grandchildren are running,
   * so tear down the whole detached group, then fail closed. Fails closed
   * regardless of strict; the unsandboxed fallback is reserved strictly for
   * preflight "sandbox unavailable" and the explicit ABI downgrade.
   *
   * @param child - The helper's child process handle, used to target teardown.
   * @param status - The offending status (an `error` variant, or `null` for a
   *   missing/malformed/oversized/timed-out status line).
   * @param requestedNetwork - Network posture sent to the helper in the fd-3 spec.
   * @param settle - Callback that resolves the outer `execute()` promise.
   */
  private handleViolation(
    child: ChildProcess,
    status: HelperStatus | null,
    requestedNetwork: 'deny' | 'allow',
    settle: (r: SandboxExecutionResult) => void,
  ): void {
    const detail = status?.status === 'error' ? status.message : 'missing or malformed fd-4 status';
    void this.terminateGroup(child).then((reaped) => {
      const base = `rd-landlock protocol violation: ${detail}`;
      // Fail closed either way; surface an unconfirmed teardown so a leaked
      // process group is visible rather than silently treated as success.
      const reason = reaped
        ? base
        : `${base} (process-group teardown did NOT confirm reap within timeout — possible leaked processes)`;
      settle(this.failClosed(reason, requestedNetwork));
    });
  }

  /**
   * Signal the helper's whole process group and reap it. The negative PID
   * targets the group (only valid because the child was spawned `detached`, so
   * it leads its own group and the signal cannot reach core's group). SIGTERM
   * first, SIGKILL after `teardownGraceMs`.
   *
   * @param child - The helper's child process handle whose process group is
   *   signalled and awaited.
   * @returns `true` only when the child's `exit` confirmed reaping; `false`
   *   (a teardown FAILURE) if reaping is not confirmed within `teardownReapMs`.
   *   Never resolves the timeout branch as success.
   */
  private terminateGroup(child: ChildProcess): Promise<boolean> {
    return new Promise((resolve) => {
      const pid = child.pid;
      // The helper may already be reaped (its 'exit' event fired before this
      // call and will never fire again); waiting on a future 'exit' would time
      // out and misreport the teardown as a leak. Its exit is the confirmation
      // the normal path waits for, so signal any surviving grandchildren in
      // the group best-effort and resolve success immediately.
      if (child.exitCode !== null || child.signalCode !== null) {
        try {
          if (pid != null) process.kill(-pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
        resolve(true);
        return;
      }
      let done = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reaped: boolean): void => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        clearTimeout(reapTimer);
        resolve(reaped);
      };
      const signalGroup = (sig: NodeJS.Signals): void => {
        try {
          if (pid != null) process.kill(-pid, sig);
        } catch {
          /* group already gone */
        }
      };
      // Confirmed reap is the ONLY success path.
      child.once('exit', () => {
        finish(true);
      });
      if (pid != null) {
        signalGroup('SIGTERM');
        killTimer = setTimeout(() => {
          signalGroup('SIGKILL');
        }, this.teardownGraceMs);
      }
      // Unconfirmed within the window → teardown FAILURE (resolve false).
      const reapTimer = setTimeout(() => {
        finish(false);
      }, this.teardownReapMs);
    });
  }

  private failClosed(reason: string, requestedNetwork?: 'deny' | 'allow'): SandboxExecutionResult {
    return {
      success: false,
      exitCode: 126,
      sandboxed: false,
      policyDenied: true,
      ...(requestedNetwork === undefined
        ? {}
        : { networkPolicy: requestedNetwork, networkSandboxed: false }),
      denialReason: reason,
    };
  }
}
