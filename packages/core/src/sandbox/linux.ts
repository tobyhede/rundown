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
}

/** The JSON spec written to the helper's fd 3. */
export interface LandlockSpec {
  command: string;
  strict: boolean;
  ro: string[];
  rox: string[];
  rw: string[];
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

/** Hard cap on the fd-4 status buffer; overflow is a protocol violation. */
const MAX_STATUS_BYTES = 8192;
/** Default startup window for the fd-4 status line to arrive. */
const DEFAULT_STATUS_TIMEOUT_MS = 5000;

/** Parsed fd-4 status. */
type HelperStatus =
  | { status: 'applied'; abi: number; downgraded: boolean }
  | { status: 'denied'; abi: number; missing: string }
  | { status: 'error'; message: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
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
function parseStatus(line: string): HelperStatus | null {
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
      return isFiniteNumber(o.abi) && o.abi >= 1 && typeof o.downgraded === 'boolean'
        ? { status: 'applied', abi: o.abi, downgraded: o.downgraded }
        : null;
    case 'denied':
      return isFiniteNumber(o.abi) && typeof o.missing === 'string'
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

  /**
   * Construct a LandlockSandbox.
   *
   * @param opts - Test seams: `helperPath` overrides arch resolution
   *   (`null` simulates an unsupported architecture); `distRoot` overrides
   *   the core `dist` root used to resolve the bundled helper; `probeEnv`
   *   supplies extra environment variables for the `--probe` invocation;
   *   `statusTimeoutMs` overrides the fd-4 status startup window.
   */
  constructor(opts: LandlockSandboxOptions = {}) {
    const distRoot = opts.distRoot ?? defaultDistRoot();
    this.helperPath =
      opts.helperPath !== undefined ? opts.helperPath : resolveHelperPath(process.arch, distRoot);
    this.probeEnv = opts.probeEnv ?? {};
    this.statusTimeoutMs = opts.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS;
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
    // closed instead of throwing out of this synchronous helper.
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
      const child = spawn(this.helperPath as string, [], {
        cwd: options.cwd,
        env,
        stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
        detached: true,
      });

      const specPipe = child.stdio[3] as NodeJS.WritableStream;
      const statusPipe = child.stdio[4] as NodeJS.ReadableStream;

      let statusRaw = '';
      let statusHandled = false;
      let settled = false;
      let appliedStatus: HelperStatus | null = null;
      let childClosed = false;
      let childCode = 1;
      let startupTimer: ReturnType<typeof setTimeout>;

      const settle = (r: SandboxExecutionResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
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
          if (childClosed) settle(this.resolveStatus(status, childCode));
        } else if (status?.status === 'denied') {
          settle(this.resolveStatus(status, 126));
        } else {
          // error / missing / malformed / oversized / timed-out → protocol
          // violation (Task 19 adds process-group teardown to handleViolation).
          this.handleViolation(child, status, settle);
        }
      };

      // Startup timeout: the helper must deliver a status line promptly.
      startupTimer = setTimeout(() => dispatch(null), this.statusTimeoutMs);

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
        settle(this.failClosed(`rd-landlock failed to start: ${getErrorMessage(err)}`));
      });

      child.on('close', (code) => {
        childClosed = true;
        childCode = code ?? 1;
        if (appliedStatus) settle(this.resolveStatus(appliedStatus, childCode));
      });

      specPipe.write(`${JSON.stringify(spec)}\n`);
      specPipe.end();
    });
  }

  /** Map an `applied`/`denied` status to a result. Task 18 fills the denied branch. */
  private resolveStatus(status: HelperStatus, exitCode: number): SandboxExecutionResult {
    if (status.status === 'applied') {
      return {
        success: exitCode === 0,
        exitCode,
        sandboxed: true,
        policyDenied: false,
        landlockAbi: status.abi,
        enforcementDowngraded: status.downgraded,
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
        denialReason:
          `Landlock ABI ${status.abi} (kernel <6.2) cannot enforce ${status.missing}; ` +
          'read-only grants would be bypassable. Refusing under strict mode. ' +
          'Re-run with sandboxStrict:false to override.',
      };
    }
    // unreachable if only called with 'applied' or 'denied'; but this helps TS narrowing
    return this.failClosed('unknown status variant');
  }

  /**
   * Handle a protocol violation (error / missing / malformed status). Task 17
   * fails closed directly; Task 19 replaces this to tear down the process group
   * first. Fails closed regardless of strict.
   */
  private handleViolation(
    _child: import('node:child_process').ChildProcess,
    status: HelperStatus | null,
    settle: (r: SandboxExecutionResult) => void,
  ): void {
    const detail = status?.status === 'error' ? status.message : 'missing or malformed fd-4 status';
    settle(this.failClosed(`rd-landlock protocol violation: ${detail}`));
  }

  private failClosed(reason: string): SandboxExecutionResult {
    return {
      success: false,
      exitCode: 126,
      sandboxed: false,
      policyDenied: true,
      denialReason: reason,
    };
  }
}
