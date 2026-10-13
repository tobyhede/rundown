// packages/core/src/runbook/delegation-agent.ts

/**
 * Who runs `rundown claim` / `rundown release` (#907, ADR 0005).
 *
 * The agent id a claim records is the only authority a later release has, so
 * core decides what the front end's raw inputs mean: every `--agent-id` the
 * command line carried, and whether the command runs inside Claude Code
 * (read by the CLI from `CLAUDECODE`, never by core). In Claude Code the
 * plugin's Bash hook stamps `--agent-id` on a plain `rundown claim` /
 * `rundown release`; a claim the hook did not stamp is refused rather than
 * recorded without an agent.
 *
 * @module runbook/delegation-agent
 */

/** Refusal code for `rundown claim` inside Claude Code without an agent id. */
export const AGENT_ID_REQUIRED_CODE = 'AGENT_ID_REQUIRED';

/**
 * The agent a claim or release runs as.
 *
 * - `agent` — an identified agent, named by the one `--agent-id` the command
 *   carried. A claim records it; a release must match it.
 * - `anonymous` — no `--agent-id`. A claim records no agent; a release
 *   matches only a claim that recorded none.
 */
export type DelegationAgent =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'anonymous' };

/** The outcome of {@link resolveDelegationAgent}. */
export type DelegationAgentResolution =
  | { readonly kind: 'resolved'; readonly agent: DelegationAgent }
  | {
      readonly kind: 'refused';
      readonly code: 'INVALID_SYNTAX' | typeof AGENT_ID_REQUIRED_CODE;
      readonly message: string;
    };

/**
 * Decide which agent a claim or release runs as.
 *
 * More than one `--agent-id` is refused, never resolved last-wins: in Claude
 * Code the hook's stamp plus one the command smuggled in (through a variable,
 * say) would otherwise let the smuggled one win. Inside Claude Code a claim
 * must name its agent, since an unnamed claim is one the plugin's hook did
 * not stamp; outside it (a person, Codex, MCP, the scenario harness) an
 * unnamed claim records no agent, as before.
 *
 * @param input - The raw identities the front end saw.
 * @param input.agentIds - Every `--agent-id` value, in command-line order.
 * @param input.insideClaudeCode - Whether the command runs in a Claude Code
 *   Bash tool call.
 * @param input.command - The command resolving its agent.
 * @returns The resolved agent, or a refusal.
 */
export function resolveDelegationAgent(input: {
  readonly agentIds: readonly string[];
  readonly insideClaudeCode: boolean;
  readonly command: 'claim' | 'release';
}): DelegationAgentResolution {
  const { agentIds, insideClaudeCode, command } = input;
  if (agentIds.length > 1) {
    return {
      kind: 'refused',
      code: 'INVALID_SYNTAX',
      message: `--agent-id was given ${String(agentIds.length)} times; name the agent once.`,
    };
  }
  const agentId = agentIds.at(0);
  if (agentId === undefined) {
    if (insideClaudeCode && command === 'claim') {
      return {
        kind: 'refused',
        code: AGENT_ID_REQUIRED_CODE,
        message:
          "rundown claim inside Claude Code needs the claiming sub-agent's id, and none was given; nothing was written. With the rundown plugin, run it as a plain command, `rundown claim <ticket>`, from the sub-agent the ticket was dispatched to: the plugin stamps --agent-id on it. Without the plugin, pass --agent-id <a stable id of your own> by hand, and the same id to `rundown release`.",
      };
    }
    return { kind: 'resolved', agent: { kind: 'anonymous' } };
  }
  if (agentId.trim() === '') {
    return { kind: 'refused', code: 'INVALID_SYNTAX', message: '--agent-id must not be empty.' };
  }
  return { kind: 'resolved', agent: { kind: 'agent', agentId } };
}

/**
 * The agent id a claim records, or a release must match.
 *
 * @param agent - The resolved agent.
 * @returns The id of an identified agent; undefined for an anonymous one.
 */
export function recordedAgentId(agent: DelegationAgent): string | undefined {
  return agent.kind === 'agent' ? agent.agentId : undefined;
}
