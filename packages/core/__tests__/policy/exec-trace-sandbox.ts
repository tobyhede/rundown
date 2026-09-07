/**
 * The hermetic exec-tracing sandbox and differential oracle, extracted from
 * `tokenize-shell-exec-differential.integration.test.ts` so the observation path
 * itself can be unit-tested.
 *
 * The extraction exists for one reason. The oracle's soundness claim rests
 * entirely on the trace being GROUND TRUTH, and the original
 * `runInSandbox` could not tell "the shell executed nothing" apart from "the
 * shell could not be started": it inspected `spawnSync`'s `result.error` only
 * to detect a timeout and discarded every other failure, returning an empty
 * head set. An empty set makes `runOracle` report no divergence, so a run in
 * which no shell ever started reported the security property as HELD. Nothing
 * in the harness could observe that, because the code that would have to be
 * mocked to prove it lived inside the test file itself.
 *
 * See `exec-trace-sandbox.test.ts` for the witnesses.
 *
 * @module
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import { getErrorMessage, isNodeError } from '../../src/index.js';

/** Repo root the harness policy is evaluated against. */
export const repoRoot = '/test/repo';

/** Executables the harness policy will allow. Everything else is denied. */
export const ALLOWED = ['git', 'echo'] as const;

/**
 * The full shim vocabulary. Deliberately includes dangerous-sounding names so
 * the fuzzer can *try* to invoke them and the harness proves they are caught:
 * every one of these resolves to an inert trace-only script, so even a
 * successful "injection" runs nothing but a logger.
 */
export const SHIM_NAMES = [
  // allowed heads
  'git',
  'echo',
  // denied heads the fuzzer tries to smuggle
  'curl',
  'wget',
  'rm',
  'sh',
  'bash',
  'cat',
  'nc',
  'sudo',
  'chmod',
  'python',
  'perl',
  'env',
  'cp',
  'mv',
  'ls',
  'true',
  'false',
] as const;

/**
 * Hard timeout for each real `sh -c` spawn.
 *
 * This is a safety net against a wedged shell, NOT a performance budget, and it
 * was previously tight enough to act as one. Measured on macOS: a cold spawn of
 * `git status` under this harness cost 1435ms against the old 2000ms, and the
 * four-head self-check command hit 2002ms and was SIGKILLed with a TRUNCATED
 * trace (`git, rm, curl` — no `sh`). Warm spawns of the same command cost
 * 16-18ms, so the budget was being spent on process start-up, not on the shell
 * doing anything.
 *
 * That mattered because the truncated trace was reported as ground truth: see
 * `runOracle`, which now refuses it. Raising the ceiling is what keeps that
 * refusal rare enough to mean something — a guard that fires on healthy runs
 * teaches people to ignore it.
 */
export const SHELL_TIMEOUT_MS = 15_000;

/**
 * Build a deny-mode policy whose run allowlist is exactly the given names.
 *
 * @param allow - Executable names to allow (exact glob entries)
 * @returns A policy config with `mode: 'deny'` and the given run allowlist
 */
export const denyRunPolicy = (allow: readonly string[]): PolicyConfig => ({
  ...DEFAULT_POLICY,
  default: {
    ...DEFAULT_POLICY.default,
    mode: 'deny',
    run: { allow: [...allow], deny: [] },
  },
});

// ---------------------------------------------------------------------------
// Hermetic shim sandbox
// ---------------------------------------------------------------------------

/**
 * A hermetic shim environment: a temp dir of inert tracer shims plus the
 * machinery to run a command under it and read back the executed heads.
 */
export interface ShimSandbox {
  /** Directory containing the inert shim executables (the sole `PATH` entry). */
  readonly shimDir: string;
  /** Root temp dir holding the shims, trace file, and throwaway cwd. */
  readonly root: string;
  /** Delete the entire sandbox (shims, traces, cwds). */
  cleanup(): void;
}

/**
 * Create the hermetic shim sandbox: one inert tracer script per
 * {@link SHIM_NAMES} entry.
 *
 * Each shim writes ONLY its own (generation-time hardcoded) basename to the
 * trace file named by `$RD_TRACE_FILE`, using the shell builtin `printf` so it
 * needs no external command (important: under `env -i` the only thing on `PATH`
 * is the shim dir itself, so `basename`/`echo`-as-program would not resolve).
 * It then exits 0. It never deletes, writes elsewhere, or networks.
 *
 * @returns The sandbox handle (shim dir + cleanup)
 * @throws If the temp dir or shim scripts cannot be created
 */
export function createShimSandbox(): ShimSandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-exec-diff-'));
  const shimDir = path.join(root, 'shims');
  fs.mkdirSync(shimDir);

  for (const name of SHIM_NAMES) {
    const shimPath = path.join(shimDir, name);
    // The basename is embedded as a single-quoted literal so no generated
    // argument can influence what is recorded. Pure shell builtins only.
    const script = `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$RD_TRACE_FILE"\nexit 0\n`;
    fs.writeFileSync(shimPath, script, { mode: 0o755 });
  }

  return {
    shimDir,
    root,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Outcome of executing one command under the hermetic shim sandbox. */
export interface ExecTrace {
  /** Distinct command-head basenames the real shell actually exec'd. */
  heads: Set<string>;
  /** Whether the shell process timed out (trace is still authoritative for what ran before). */
  timedOut: boolean;
}

/**
 * Run a single command string under `sh -c` in the hermetic sandbox and return
 * the set of command heads the shell actually executed.
 *
 * Hermeticity controls applied here:
 * - `env -i`-equivalent: the spawned `sh` receives ONLY `PATH=<shimDir>` and
 *   `RD_TRACE_FILE` (we set `env` explicitly and do not inherit `process.env`).
 * - Fresh `mkdtemp` cwd, deleted after the run, so relative redirects are inert.
 * - `stdio: ['ignore','ignore','ignore']` and a {@link SHELL_TIMEOUT_MS} timeout
 *   so no input can wedge or block the suite.
 *
 * @param sandbox - The hermetic shim sandbox
 * @param command - The raw command string to execute
 * @returns The executed-head set and whether the shell timed out
 * @throws If the throwaway cwd cannot be created or the trace file cannot be read
 */
export function runInSandbox(sandbox: ShimSandbox, command: string): ExecTrace {
  const runCwd = fs.mkdtempSync(path.join(sandbox.root, 'cwd-'));
  const traceFile = path.join(runCwd, '.rd-trace');
  fs.writeFileSync(traceFile, '');

  try {
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: runCwd,
      // Hermetic env: no inheritance from process.env. Only the shim PATH and
      // the trace-file pointer. Equivalent to `env -i PATH=... RD_TRACE_FILE=...`.
      env: { PATH: sandbox.shimDir, RD_TRACE_FILE: traceFile },
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: SHELL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    // spawnSync surfaces a timeout via `result.error.code === 'ETIMEDOUT'`, and
    // the SIGKILL we use to kill the timed-out child via `result.signal`.
    const timedOut =
      (result.error !== undefined && isTimeoutError(result.error)) || result.signal === 'SIGKILL';

    // A spawn that never happened is NOT an observation of a shell that ran
    // nothing, and the difference is the whole value of this harness. The trace
    // file is pre-created empty above, so a failed spawn reads back as `''` and
    // would otherwise yield an empty head set — which `runOracle` reads as "no
    // unauthorized head ran" and reports as the security property HOLDING.
    // Under a full test run, worker fan-out can exhaust the process table, and
    // `EAGAIN` here would turn the entire differential green without executing
    // one shell. Refuse loudly instead.
    if (result.error !== undefined && !timedOut) {
      throw new Error(
        `exec-trace sandbox could not spawn /bin/sh: ${getErrorMessage(result.error)}. ` +
          `This is an infrastructure failure, not an observation: the trace is empty ` +
          `because nothing ran, not because the shell executed nothing.`,
      );
    }
    // Belt and braces for the same condition without an `error` attached: a
    // process that neither exited nor was signalled produced no observation.
    if (!timedOut && result.status === null && result.signal === null) {
      throw new Error(
        'exec-trace sandbox spawned no shell: /bin/sh neither exited nor was signalled, ' +
          'so the empty trace is not an observation.',
      );
    }

    let raw = '';
    try {
      raw = fs.readFileSync(traceFile, 'utf8');
    } catch (err) {
      // A missing/unreadable trace file means nothing ran; treat as empty.
      if (!isNodeError(err) || err.code !== 'ENOENT') {
        throw new Error(`failed to read trace file: ${getErrorMessage(err)}`);
      }
    }

    const heads = new Set(
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );

    return { heads, timedOut };
  } finally {
    fs.rmSync(runCwd, { recursive: true, force: true });
  }
}

/**
 * Detect whether a `spawnSync` error indicates the timeout fired.
 *
 * @param err - The error returned on `result.error`
 * @returns True when the error code is the spawn timeout code
 */
function isTimeoutError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ETIMEDOUT';
}

// ---------------------------------------------------------------------------
// The differential oracle
// ---------------------------------------------------------------------------

/** A real policy bypass: the shell ran a head the policy allowed but did not authorize. */
export interface Divergence {
  /** The minimal reproducing command. */
  command: string;
  /** The policy decision (always allowed for a divergence). */
  policyAllowed: boolean;
  /** Ground-truth heads the real shell executed. */
  shellHeads: string[];
  /** Executed heads that are NOT in the allowed set — the bypass. */
  unauthorized: string[];
}

/** Outcome of running the exec-tracing oracle on one command. */
export interface OracleResult {
  /** Whether the policy evaluator allowed the command. */
  policyAllowed: boolean;
  /** The divergence (bypass) details, or `null` if the invariant held. */
  divergence: Divergence | null;
}

/**
 * Run the exec-tracing oracle on a single command string.
 *
 * Gets the policy decision from a deny-mode `{git, echo}` evaluator. If the
 * policy DENIES, no bypass is possible (the command never reaches `spawn`), so
 * the oracle returns immediately WITHOUT running the shell. If the policy
 * ALLOWS, the command is executed in the hermetic sandbox and every executed
 * head must be in the allowed set.
 *
 * @param sandbox - The hermetic shim sandbox
 * @param command - The candidate command
 * @returns The policy verdict and any divergence found
 * @throws If {@link PolicyEvaluator.checkCommand} throws on the input
 */
export function runOracle(sandbox: ShimSandbox, command: string): OracleResult {
  const evaluator = new PolicyEvaluator(denyRunPolicy(ALLOWED), { repoRoot });

  let decision: ReturnType<PolicyEvaluator['checkCommand']>;
  try {
    decision = evaluator.checkCommand(command);
  } catch (err) {
    throw new Error(`checkCommand threw on ${JSON.stringify(command)}: ${getErrorMessage(err)}`);
  }

  if (!decision.allowed) {
    return { policyAllowed: false, divergence: null };
  }

  const { heads, timedOut } = runInSandbox(sandbox, command);
  const allowedSet = new Set<string>(ALLOWED);
  const unauthorized = [...heads].filter((h) => !allowedSet.has(h));

  if (unauthorized.length === 0) {
    // A truncated run is authoritative for a bypass it DID observe — a head
    // that already exec'd is a real bypass whether or not the shell later timed
    // out — but it is not evidence of soundness. Absence of a divergence under
    // a run that was cut short says nothing, so it must not be reported as the
    // invariant holding. `timedOut` was computed here from the start and read
    // by no caller, which is what let a 2s timeout under load stand in for
    // ground truth.
    if (timedOut) {
      throw new Error(
        `exec-trace sandbox timed out after ${String(SHELL_TIMEOUT_MS)}ms on ` +
          `${JSON.stringify(command)} without observing a divergence. A truncated ` +
          `trace cannot establish that no unauthorized head ran.`,
      );
    }
    return { policyAllowed: true, divergence: null };
  }

  return {
    policyAllowed: true,
    divergence: {
      command,
      policyAllowed: decision.allowed,
      shellHeads: [...heads],
      unauthorized,
    },
  };
}
