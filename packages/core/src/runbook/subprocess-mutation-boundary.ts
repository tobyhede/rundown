// packages/core/src/runbook/subprocess-mutation-boundary.ts
//
// Shared subprocess trust boundary for the plugin and MCP front ends.
//
// The plugin and MCP server reach the CLI by spawning a subprocess, so typed
// `CallerEvidence` cannot cross the process boundary — a spawned `rd pass`
// arrives as an ordinary `argv`, indistinguishable from a human invocation.
//
// DEFENSE-IN-DEPTH (post-R1): core itself now refuses ambient direct-CLI trust
// on every delegation-exposed run (`actorContextFromEvidence` grants the
// `direct_cli` lane only to standalone runs), so this boundary is no longer the
// primary gate against the #460 takeover class. Its remaining job is narrower:
// stop a spawned bare mutation from silently consuming the standalone-run
// convenience lane, and keep refusals rendered at the front end (a clear typed
// withhold instead of a downstream policy error). Explicitly-targeted
// mutations — `--claim-id` (claim evidence) and `--run` (named run-controller
// evidence) — carry their own authority and pass through.
//
// This predicate is the single source of truth for "which spawned commands carry
// only direct-CLI trust and must be withheld at the front end." It is a pure
// function over `argv` strings: no env reads, no source labels, no coupling to
// CLI internals. See
// docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md.

/**
 * CLI commands that perform role-specific lifecycle mutations whose only
 * available trust is direct-CLI (`trusted_run_controller`). A subprocess front
 * end cannot supply this trust as evidence, so a bare invocation of one of these
 * must be withheld rather than spawned.
 */
export type RoleSpecificMutationCommand =
  | 'pass'
  | 'fail'
  | 'delegate'
  | 'goto'
  | 'complete'
  | 'stop'
  | 'collect';

const ROLE_SPECIFIC_MUTATION_COMMANDS: ReadonlySet<RoleSpecificMutationCommand> = new Set([
  'pass',
  'fail',
  'delegate',
  'goto',
  'complete',
  'stop',
  'collect',
]);

function isRoleSpecificMutationCommand(value: string): value is RoleSpecificMutationCommand {
  return ROLE_SPECIFIC_MUTATION_COMMANDS.has(value as RoleSpecificMutationCommand);
}

/**
 * Canonical command → CLI alias forms. Single source of truth: the boundary
 * normalizes through this map AND the CLI command registration derives its
 * Commander aliases from it (see {@link mutationCommandAliases}), so the gate
 * and the CLI can never disagree on what counts as a `pass` / `fail` mutation.
 *
 * A subprocess front end can invoke an alias (`rd yes` → `pass`); Commander
 * canonicalizes it inside the CLI, so the pre-spawn boundary must canonicalize
 * it too or the alias would launder direct-CLI trust past the gate.
 */
const MUTATION_COMMAND_ALIASES: Readonly<Record<RoleSpecificMutationCommand, readonly string[]>> = {
  pass: ['yes', 'ok'],
  fail: ['no'],
  delegate: [],
  goto: [],
  // No aliases (decision #5): `done` is the `[message]` positional, not an alias.
  complete: [],
  stop: [],
  // No aliases: `collect` has no CLI alias forms.
  collect: [],
};

/**
 * Resolve a CLI token (canonical name or alias) to its canonical role-specific
 * mutation command.
 *
 * @param token - The `argv[0]` command token, or `undefined` for empty argv.
 * @returns The canonical command, or `undefined` when the token is neither a
 *   role-specific mutation nor one of its aliases.
 */
function canonicalMutationCommand(
  token: string | undefined,
): RoleSpecificMutationCommand | undefined {
  if (token === undefined) {
    return undefined;
  }
  if (isRoleSpecificMutationCommand(token)) {
    return token;
  }
  for (const command of ROLE_SPECIFIC_MUTATION_COMMANDS) {
    if (MUTATION_COMMAND_ALIASES[command].includes(token)) {
      return command;
    }
  }
  return undefined;
}

/**
 * CLI alias forms for a role-specific mutation command. Consumed by the CLI's
 * `pass` / `fail` command registration so its Commander aliases stay in lock-step
 * with the subprocess boundary's normalization (single source of truth).
 *
 * @param command - The canonical role-specific mutation command.
 * @returns The alias tokens registered for that command (empty for `delegate`).
 */
export function mutationCommandAliases(command: RoleSpecificMutationCommand): readonly string[] {
  return MUTATION_COMMAND_ALIASES[command];
}

/**
 * Canonical long names of the space-form value-taking options of the guarded
 * `pass` / `fail` commands. **Single source of truth.**
 *
 * Each option consumes the *following* argv token as its value (`--step
 * <stepId>`, `--index <number>`, `--claim-id <claimId>`). When scanning for claim
 * evidence we must skip those consumed values so an attacker cannot smuggle a
 * `--claim-id` token through an option's value position (e.g.
 * `--step --claim-id=foo`, where `--claim-id=foo` is the value of `--step`, not
 * a real flag).
 *
 * This list is the *minimal* set required to read flag position correctly. The
 * boundary scanner derives {@link PASS_FAIL_VALUE_TAKING_OPTIONS} from it AND the
 * CLI's `pass` / `fail` registration derives its Commander `.option(...)` calls
 * from it (see `packages/cli/src/helpers/transition-command.ts`), so the gate and
 * the actual CLI option surface can never drift: adding a future value-taking
 * option (e.g. `--note <text>`) without updating this list would either leave the
 * scanner blind to a smuggling slot or fail the CLI single-source invariant test.
 * `--text` is a boolean and consumes nothing, so it is intentionally absent. The
 * equals-forms (`--step=...`, `--index=...`) consume their value inline in a
 * single token and therefore need no skip — only the space-forms advance past the
 * next token.
 */
export const PASS_FAIL_VALUE_TAKING_OPTION_NAMES = [
  '--step',
  '--index',
  '--claim-id',
  '--claim-capability',
  '--run-capability',
  '--run',
] as const;

/**
 * A canonical value-taking `pass` / `fail` option long name (`--step`,
 * `--index`, `--claim-id`, or `--run`). Lets the CLI registration key its
 * presentation metadata by these names so TypeScript forces full, exact coverage.
 */
export type PassFailValueTakingOptionName = (typeof PASS_FAIL_VALUE_TAKING_OPTION_NAMES)[number];

/**
 * Space-form value-taking options of the guarded `pass` / `fail` commands,
 * derived from {@link PASS_FAIL_VALUE_TAKING_OPTION_NAMES} (single source of
 * truth). Used by {@link carriesClaimEvidence} to skip each option's consumed
 * value token while scanning for claim evidence.
 */
const PASS_FAIL_VALUE_TAKING_OPTIONS: ReadonlySet<string> = new Set(
  PASS_FAIL_VALUE_TAKING_OPTION_NAMES,
);

/**
 * Long names of the **program-level (global)** CLI options that consume the
 * following argv token as their value in space form (`--policy <file>`).
 * **Single source of truth.**
 *
 * The rundown CLI accepts these globals *before* the subcommand (e.g.
 * `rundown --policy foo.json pass`). To classify a spawned argv the boundary must
 * first locate the real command token, which means skipping each leading global
 * option — and a value-taking global also consumes the *next* token, so
 * `['--policy','foo','pass']`'s command is `pass` at index 2, not `foo` at index
 * 1. Misreading the value as the command would fail OPEN (a bare `pass` would be
 * read as a non-mutation `foo` and slip through).
 *
 * This list is the membership set of value-taking globals; the CLI's program
 * registration is pinned to it by a drift-guard test
 * (`packages/cli/__tests__/helpers/program-level-option-single-source.test.ts`),
 * which introspects the real `createProgram()` options and fails the build if a
 * new value-taking global is added without teaching this scanner that it consumes
 * a value. Boolean globals (`--deny-all`, `--no-color`, …) and unrecognized
 * leading flags need no enumeration: both consume no following token, so the
 * command-token scan skips exactly one for them. Only value-arity is
 * security-relevant, so only it is pinned.
 */
export const GLOBAL_VALUE_TAKING_OPTION_NAMES = [
  '--allow-run',
  '--allow-read',
  '--allow-write',
  '--allow-env',
  '--policy',
  '--helpers',
] as const;

/**
 * A canonical value-taking program-level option long name (one of
 * {@link GLOBAL_VALUE_TAKING_OPTION_NAMES}). Lets the CLI drift-guard test key
 * its assertions by these names with exhaustive type coverage.
 */
export type GlobalValueTakingOptionName = (typeof GLOBAL_VALUE_TAKING_OPTION_NAMES)[number];

/**
 * Space-form value-taking program-level options, derived from
 * {@link GLOBAL_VALUE_TAKING_OPTION_NAMES} (single source of truth). Used by
 * {@link locateCommandIndex} to skip each global's consumed value token while
 * scanning past leading globals to the real command token.
 */
const GLOBAL_VALUE_TAKING_OPTIONS: ReadonlySet<string> = new Set(GLOBAL_VALUE_TAKING_OPTION_NAMES);

/**
 * Locate the index of the real command token in a spawned argv, skipping any
 * leading program-level (global) options and the values they consume.
 *
 * The rundown CLI registers global options (`--deny-all`, `--policy <file>`,
 * `--no-color`, …) at program scope, so a subprocess front end can prefix the
 * subcommand with them. Classifying `argv[0]` blindly would let a bare mutation
 * behind a global flag (`['--deny-all','pass']`) slip past the gate — the exact
 * fail-open laundering this boundary exists to block.
 *
 * The scan is fail-closed: it never aborts and returns "no command" because of a
 * leading flag. Recognized value-taking globals (space form) consume two tokens;
 * an inline `--opt=value` token consumes one (its value is inline); every other
 * leading flag — a recognized boolean global *or* an unrecognized flag — consumes
 * exactly one. Treating an unknown leading flag as zero-arity means a following
 * bare mutation is still located and withheld rather than ignored. An unknown
 * leading flag cannot itself yield a dispatched mutation (commander rejects
 * unknown global options before any subcommand runs), so any argv the CLI would
 * actually dispatch as a bare mutation is prefixed only by *recognized* globals,
 * whose arities this scan models exactly. The `--` option terminator marks the
 * next token as the positional command.
 *
 * @param argv - CLI argument vector as it would be spawned.
 * @returns The index of the command token. May equal `argv.length` when the argv
 *   is all options (no command), in which case `argv[index]` is `undefined`.
 */
function locateCommandIndex(argv: readonly string[]): number {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--') {
      // Option terminator: the next token is the command in positional form.
      return i + 1;
    }
    if (!token.startsWith('-')) {
      // First non-option token is the command.
      return i;
    }
    if (token.includes('=')) {
      // Inline value form (`--policy=foo`): a single token consuming nothing else.
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE_TAKING_OPTIONS.has(token)) {
      // Space-form value-taking global: skip the option AND its value token, so
      // the value is never misread as the command (which would fail open).
      i += 2;
      continue;
    }
    // Recognized boolean global OR an unrecognized leading flag: both consume no
    // following token. Skip exactly one and keep scanning (fail-closed).
    i += 1;
  }
  return argv.length;
}

/**
 * Whether a guarded `pass` / `fail` argv carries claim evidence via a real
 * `--claim-id` flag in *flag position* (either `--claim-id <value>` or
 * `--claim-id=<value>`).
 *
 * A `--claim-id` mutation is a `claim_controller` mutation whose evidence is
 * reconstructable CLI-side from the resolved claim record; it does not rely on
 * direct-CLI trust and so is never bare. The scan walks argv left-to-right and
 * skips the value token consumed by each space-form value-taking option, so a
 * `--claim-id` token appearing as another option's *value* is correctly NOT
 * treated as evidence. This is a fail-closed reading: any `--claim-id` token we
 * cannot confirm is in flag position is not exempted (it stays withheld). Scanning
 * stops at the `--` option terminator: every token after it is positional, so a
 * trailing `--claim-id` there is content, not evidence, and the mutation stays
 * bare (withheld).
 *
 * @param argv - CLI argument vector. The command may be preceded by program-level
 *   global options, so its position is supplied via `commandIndex`. Every
 *   non-`delegate` guarded command (`pass` / `fail` / `complete` / `stop` /
 *   `collect`) reaches this function; `delegate` is claim-less and never exempted.
 * @param commandIndex - Index of the command token in `argv` (from
 *   {@link locateCommandIndex}). Scanning starts after it; options before it are
 *   program-level globals, not the command's own flags.
 * @returns `true` when a real `--claim-id` flag occupies a flag position.
 */
function carriesClaimEvidence(argv: readonly string[], commandIndex: number): boolean {
  // Start after the command token; everything before it is a program-level
  // global option (or the command itself), never a `pass` / `fail` claim flag.
  for (let i = commandIndex + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Option terminator: every later token is positional, never a flag. A
      // trailing `--claim-id` is content, so the mutation is bare and withheld.
      return false;
    }
    if (arg === '--claim-id' || arg.startsWith('--claim-id=')) {
      // A real `--claim-id` flag in flag position: claim evidence is present.
      return true;
    }
    if (PASS_FAIL_VALUE_TAKING_OPTIONS.has(arg)) {
      // Space-form value-taking option: its value is the next token. Skip it so
      // a `--claim-id` token sitting in that value slot is not misread as a flag.
      i++;
    }
  }
  return false;
}

/**
 * Whether a guarded mutation argv carries an explicit `--run` target in *flag
 * position* (either `--run <value>` or `--run=<value>`).
 *
 * A `--run` mutation names its authority explicitly: core maps it to
 * `run_controller` evidence over exactly the named run and refuses an
 * id/target mismatch, so it never relies on ambient direct-CLI trust and is
 * not bare. Mirrors {@link carriesClaimEvidence} exactly: the scan walks argv
 * left-to-right, skips the value token consumed by each space-form
 * value-taking option (the skip set already contains `--run` itself), and
 * stops at the `--` option terminator — a `--run` token in a value slot or
 * after the terminator is content, not evidence (fail-closed).
 *
 * @param argv - CLI argument vector (command optionally preceded by globals).
 * @param commandIndex - Index of the command token in `argv` (from
 *   {@link locateCommandIndex}). Scanning starts after it.
 * @returns `true` when a real `--run` flag occupies a flag position.
 */
function carriesExplicitRunTarget(argv: readonly string[], commandIndex: number): boolean {
  for (let i = commandIndex + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      // Option terminator: every later token is positional, never a flag.
      return false;
    }
    if (arg === '--run' || arg.startsWith('--run=')) {
      return true;
    }
    if (PASS_FAIL_VALUE_TAKING_OPTIONS.has(arg)) {
      // Space-form value-taking option: skip its consumed value token so a
      // `--run` sitting in that value slot is not misread as a flag.
      i++;
    }
  }
  return false;
}

/**
 * Classify a spawned CLI argv as a bare role-specific lifecycle mutation.
 *
 * A call is bare iff its command is `pass`, `fail`, `delegate`, `complete`,
 * `stop`, or `collect` and it carries neither claim evidence (`--claim-id`)
 * nor an explicit run target (`--run`). These are exactly the invocations
 * whose only available trust is direct-CLI, so a subprocess front end
 * (plugin / MCP) must withhold them rather than let them silently inherit
 * `{ kind: 'direct_cli' }` trust. This is defense-in-depth: core's
 * exposure-conditional `direct_cli` mapping is the primary gate (it refuses
 * ambient trust on every delegation-exposed run); the boundary keeps the
 * standalone-run convenience lane from being consumed silently by a spawned
 * subprocess and keeps the refusal front-end-rendered.
 *
 * `delegate` is claim-less (`--claim-id` never exempts it) but DOES carry the
 * `--run` explicit-targeting form — a `--run`-carrying delegate names the run
 * it issues from and is not bare. Every other guarded command (`pass` / `fail`
 * / `complete` / `stop` / `collect`) is exempted by either a real `--claim-id`
 * or a real `--run` flag in *flag position* — a token consumed as the value of
 * a preceding value-taking option (`--step`, `--index`, `--claim-id`, `--run`)
 * is not evidence (see {@link carriesClaimEvidence} /
 * {@link carriesExplicitRunTarget}). The boundary fails closed: when neither
 * form can be confirmed in flag position, the call is treated as bare and
 * withheld. Read-only / inspect commands fall outside this set entirely.
 *
 * The command token may be preceded by program-level global options
 * (`['--deny-all','pass']`, `['--policy','foo','pass']`): the rundown CLI accepts
 * globals before the subcommand, so the command is located via
 * {@link locateCommandIndex} — examining only `argv[0]` would let a bare mutation
 * behind a global flag launder direct-CLI trust past this gate (fail open).
 *
 * @param argv - CLI argument vector as it would be spawned (a command token
 *   optionally preceded by program-level global options).
 * @returns The matched command when the argv is a bare role-specific mutation,
 *   otherwise `undefined` (claim-evidenced, read-only, or empty argv).
 */
export function bareRoleSpecificMutation(
  argv: readonly string[],
): RoleSpecificMutationCommand | undefined {
  // Locate the real command token past any leading program-level global options,
  // then normalise it (canonical name or alias such as `yes` / `ok` / `no`) to
  // its canonical command. An empty argv (or all-options argv) yields `undefined`.
  // Aliases must be resolved here: the CLI canonicalizes them after spawn, so
  // leaving them unrecognized would let `rd yes` launder direct-CLI trust.
  const commandIndex = locateCommandIndex(argv);
  const command = canonicalMutationCommand(argv[commandIndex]);
  if (command === undefined) {
    return undefined;
  }
  // Explicit `--run` targeting exempts ALL six commands, including `delegate`
  // (delegation issuance is the quintessential orchestrator mutation; naming
  // the run is exactly the evidence the roadmap's explicit-`--run` path asks
  // for). This is explicit targeting, not silent trust inheritance.
  if (carriesExplicitRunTarget(argv, commandIndex)) {
    return undefined;
  }
  // `delegate` has no claim form, so a `--claim-id` token never exempts it.
  // Every other guarded command (`pass` / `fail` / `complete` / `stop` /
  // `collect`) carries a legitimate `--claim-id` claim-controller form whose
  // evidence is reconstructable CLI-side, so those are exempted here. See
  // docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md
  // § Blocking scope.
  if (command !== 'delegate' && carriesClaimEvidence(argv, commandIndex)) {
    return undefined;
  }
  return command;
}

/** Stable error code for rejecting `--claim-id` on claim-less `delegate`. */
export const DELEGATE_CLAIM_ID_REJECTED_CODE = 'INVALID_DELEGATE_CLAIM_ID';

/**
 * Build the validation message for a `delegate` invocation that carries
 * `--claim-id`. Delegation issuance has no claim-controller form; claimed
 * children are completed through claim-aware commands such as `pass` / `fail`.
 *
 * @returns Single-line validation message.
 */
export function delegateClaimIdRejectionMessage(): string {
  return (
    '`rundown delegate` does not accept --claim-id; complete claimed children with ' +
    '`rundown pass --claim-id <claimId>` or `rundown fail --claim-id <claimId>`.'
  );
}

/**
 * Reject `--claim-id` tokens on `delegate` argv before those arguments are used.
 *
 * This intentionally scans every delegate argv token, including positional and
 * option-value positions. `delegate` is claim-less, so a claim-id-looking token
 * is never evidence and should not be accepted as ordinary delegate input. If a
 * literal filename begins with this flag text, callers can disambiguate it with
 * a path prefix such as `./--claim-id=foo`.
 *
 * The `delegate` command may sit behind program-level global options
 * (`['--deny-all','delegate','--claim-id','x']`), so it is located via
 * {@link locateCommandIndex} rather than assumed at `argv[0]`; the claim-id scan
 * then runs over the command's own arguments only.
 *
 * @param argv - CLI argument vector (a command token optionally preceded by
 *   program-level global options).
 * @returns Stable validation error details when `delegate` carries `--claim-id`;
 *   otherwise `undefined`.
 */
export function delegateClaimIdValidationError(
  argv: readonly string[],
): { readonly code: typeof DELEGATE_CLAIM_ID_REJECTED_CODE; readonly message: string } | undefined {
  const commandIndex = locateCommandIndex(argv);
  if (argv[commandIndex] !== 'delegate') return undefined;
  for (const arg of argv.slice(commandIndex + 1)) {
    if (arg === '--claim-id' || arg.startsWith('--claim-id=')) {
      return {
        code: DELEGATE_CLAIM_ID_REJECTED_CODE,
        message: delegateClaimIdRejectionMessage(),
      };
    }
  }
  return undefined;
}

/**
 * Stable error code surfaced when a subprocess front end withholds a bare
 * role-specific lifecycle mutation. Shared so the plugin and MCP render the
 * refusal consistently.
 */
export const SUBPROCESS_MUTATION_WITHHELD_CODE = 'SUBPROCESS_MUTATION_WITHHELD';

/**
 * Build the human-readable refusal message for a withheld bare role-specific
 * mutation. Names the command and points to both explicit-targeting
 * remediations — `--run` (named orchestrator authority) and `--claim-id`
 * (claim evidence); never mentions a source label.
 *
 * @param command - The withheld role-specific mutation command.
 * @returns Single-line refusal message.
 */
export function subprocessMutationWithheldMessage(command: RoleSpecificMutationCommand): string {
  return (
    `Refusing to run a bare \`rundown ${command}\` from a subprocess front end: it would ` +
    `silently inherit direct-CLI trust over the active run. Name the run you control with ` +
    `\`rundown ${command} --run <rd_…>\`, resolve a delegated ` +
    `child with \`rundown ${command === 'delegate' ? 'pass' : command} --claim-id <claimId>\`, ` +
    `or run \`rundown ${command}\` directly.`
  );
}
