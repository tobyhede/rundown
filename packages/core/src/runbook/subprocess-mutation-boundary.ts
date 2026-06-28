// packages/core/src/runbook/subprocess-mutation-boundary.ts
//
// Shared subprocess trust boundary for the plugin and MCP front ends.
//
// The plugin and MCP server reach the CLI by spawning a subprocess, so typed
// `CallerEvidence` cannot cross the process boundary — a spawned `rd pass`
// arrives as an ordinary `argv`, indistinguishable from a human invocation. A
// bare (default-target) `rd pass` / `rd fail` / `rd delegate` maps to
// `{ kind: 'direct_cli' }` and therefore to full `trusted_run_controller` trust;
// a subprocess front end must not be able to mint that trust silently.
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
export type RoleSpecificMutationCommand = 'pass' | 'fail' | 'delegate';

const ROLE_SPECIFIC_MUTATION_COMMANDS: ReadonlySet<RoleSpecificMutationCommand> = new Set([
  'pass',
  'fail',
  'delegate',
]);

function isRoleSpecificMutationCommand(value: string): value is RoleSpecificMutationCommand {
  return ROLE_SPECIFIC_MUTATION_COMMANDS.has(value as RoleSpecificMutationCommand);
}

/**
 * Space-form value-taking options of the guarded `pass` / `fail` commands.
 *
 * Each consumes the *following* argv token as its value (`--step <stepId>`,
 * `--index <number>`, `--claim-id <claimId>`). When scanning for claim evidence
 * we must skip those consumed values so an attacker cannot smuggle a
 * `--claim-id` token through an option's value position (e.g.
 * `--step --claim-id=foo`, where `--claim-id=foo` is the value of `--step`, not
 * a real flag). This is the only place this predicate couples to a CLI option
 * set; it is the *minimal* set required to read flag position correctly and is
 * kept in lock-step with the options registered in
 * `packages/cli/src/helpers/transition-command.ts` (`--step`, `--index`,
 * `--claim-id`; `--text` is a boolean and consumes nothing). The equals-forms
 * (`--step=...`, `--index=...`) consume their value inline in a single token and
 * therefore need no skip — only the space-forms advance past the next token.
 */
const PASS_FAIL_VALUE_TAKING_OPTIONS: ReadonlySet<string> = new Set([
  '--step',
  '--index',
  '--claim-id',
]);

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
 * cannot confirm is in flag position is left unexempted (withheld).
 *
 * @param argv - CLI argument vector (command name first). Only `pass` / `fail`
 *   reach this function; `delegate` is claim-less and never exempted.
 * @returns `true` when a real `--claim-id` flag occupies a flag position.
 */
function carriesClaimEvidence(argv: readonly string[]): boolean {
  // Start at 1 to skip the command name (argv[0]); it is never a flag.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
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
 * Classify a spawned CLI argv as a bare role-specific lifecycle mutation.
 *
 * A call is bare iff its command is `pass`, `fail`, or `delegate` and it carries
 * no claim evidence. These are exactly the invocations whose only available
 * trust is direct-CLI, so a subprocess front end (plugin / MCP) must withhold
 * them rather than let them silently inherit `{ kind: 'direct_cli' }` trust.
 *
 * `delegate` is claim-less and is ALWAYS bare: no `--claim-id` token can exempt
 * it. Only `pass` / `fail` carry a legitimate `--claim-id` claim-controller
 * form, and only a real `--claim-id` flag in *flag position* exempts them — a
 * `--claim-id` token consumed as the value of a preceding value-taking option
 * (`--step`, `--index`, `--claim-id`) is not evidence (see
 * {@link carriesClaimEvidence}). The boundary fails closed: when claim evidence
 * cannot be confirmed in flag position, the call is treated as bare and
 * withheld. Read-only / inspect commands fall outside this set entirely.
 *
 * @param argv - CLI argument vector as it would be spawned (command name first).
 * @returns The matched command when the argv is a bare role-specific mutation,
 *   otherwise `undefined` (claim-evidenced, read-only, or empty argv).
 */
export function bareRoleSpecificMutation(
  argv: readonly string[],
): RoleSpecificMutationCommand | undefined {
  // An empty argv yields `undefined` here at runtime; the membership check below
  // rejects it (the set holds only the three command literals), so no explicit
  // undefined guard is needed.
  const command = argv[0];
  if (!isRoleSpecificMutationCommand(command)) {
    return undefined;
  }
  // `delegate` has no claim form, so every subprocess `delegate` is bare and
  // withheld — a stray `--claim-id` cannot make it claim-evidenced. Only
  // `pass` / `fail` carry a legitimate `--claim-id` claim-controller form whose
  // evidence is reconstructable CLI-side, so only they are exempted here. See
  // docs/superpowers/specs/2026-06-28-plugin-mcp-caller-evidence-ingress-design.md
  // § Blocking scope.
  if (command !== 'delegate' && carriesClaimEvidence(argv)) {
    return undefined;
  }
  return command;
}

/**
 * Stable error code surfaced when a subprocess front end withholds a bare
 * role-specific lifecycle mutation. Shared so the plugin and MCP render the
 * refusal consistently.
 */
export const SUBPROCESS_MUTATION_WITHHELD_CODE = 'SUBPROCESS_MUTATION_WITHHELD';

/**
 * Build the human-readable refusal message for a withheld bare role-specific
 * mutation. Names the command and points to the `--claim-id` claim-evidence
 * alternative; never mentions a source label.
 *
 * @param command - The withheld role-specific mutation command.
 * @returns Single-line refusal message.
 */
export function subprocessMutationWithheldMessage(command: RoleSpecificMutationCommand): string {
  return (
    `Refusing to run a bare \`rd ${command}\` from a subprocess front end: it would ` +
    `silently inherit direct-CLI trust over the active run. Complete a delegated ` +
    `child with \`rd ${command === 'delegate' ? 'pass' : command} --claim-id <claimId>\`, ` +
    `or run \`rd ${command}\` directly.`
  );
}
