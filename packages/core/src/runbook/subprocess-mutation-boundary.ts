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
 * Whether the argv carries claim evidence via `--claim-id` (in either
 * `--claim-id <value>` or `--claim-id=<value>` form).
 *
 * A `--claim-id` mutation is a `claim_controller` mutation whose evidence is
 * reconstructable CLI-side from the resolved claim record; it does not rely on
 * direct-CLI trust and so is never bare.
 *
 * @param argv - CLI argument vector (command name first).
 * @returns `true` when an element is `--claim-id` or starts with `--claim-id=`.
 */
function carriesClaimEvidence(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--claim-id' || arg.startsWith('--claim-id='));
}

/**
 * Classify a spawned CLI argv as a bare role-specific lifecycle mutation.
 *
 * A call is bare iff its command is `pass`, `fail`, or `delegate` and it carries
 * no `--claim-id` claim evidence. These are exactly the invocations whose only
 * available trust is direct-CLI, so a subprocess front end (plugin / MCP) must
 * withhold them rather than let them silently inherit `{ kind: 'direct_cli' }`
 * trust. `--claim-id` pass/fail, `delegate` is claim-less so always bare, and
 * read-only / inspect commands all fall outside this set.
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
  if (carriesClaimEvidence(argv)) {
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
