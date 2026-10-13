// src/workflow/hooks/stamp-agent-id.ts

import type { HookInput } from '../../shared/index.js';
import {
  rundownInvocationOf,
  runsAnotherCommandLine,
  scanShellCommand,
  shellQuote,
  type RundownInvocation,
} from './shell-command.js';

/**
 * What the PreToolUse(Bash) hook does with a command (#907, ADR 0005).
 *
 * - `allow` — the command runs as written.
 * - `rewrite` — the command runs as `command`: every `rundown claim` /
 *   `rundown release` in it carries the hook's `--agent-id` and no other.
 *   Claude Code still applies the user's permission rules to the rewrite.
 * - `deny` — the command does not run; `reason` tells the agent why.
 */
export type BashCommandDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'rewrite'; readonly command: string }
  | { readonly kind: 'deny'; readonly reason: string };

/** Refusal for `rundown claim` outside a sub-agent. */
export const CLAIM_OUTSIDE_SUBAGENT_REASON =
  'Rundown refused `rundown claim` here: a Claim Ticket is claimed by the sub-agent it was dispatched to, never by the orchestrating agent, and this call carries no sub-agent identity. Dispatch an Agent whose prompt carries the ticket (`RD_CLAIM_TICKET=<ticket>`), and collect its result with `rundown collect --token <owner_token>`.';

/**
 * Refusal for a command the hook cannot read that may hide a claim or release.
 *
 * @param construct - The construct the scanner would not see through.
 * @returns The reason shown to the agent.
 */
function opaqueReason(construct: string): string {
  return `Rundown refused this command: it may run \`rundown claim\` or \`rundown release\` through ${construct}, where the plugin cannot stamp your agent id. Run \`rundown claim <ticket>\` / \`rundown release <child run id>\` as a plain command.`;
}

/** Text that may name a claim or a release, for the opaque-command check. */
const MAY_CLAIM = /\b(rundown|rd|cli\.js)\b[\s\S]*\b(claim|release)\b/;

/**
 * Decide what the Bash hook does with a command: stamp the calling agent's id
 * on `rundown claim` and `rundown release`, replacing any `--agent-id` the
 * agent passed itself, so no agent can claim or release under another's id.
 *
 * Release is authorized by the agent id its claim recorded, matched in core
 * (both absent match). A call with no `agent_id` — the top-level agent — has
 * none: its `rundown claim` is refused outright, and its `rundown release` is
 * stripped of any `--agent-id` it passed, so it matches only a claim recorded
 * without one (a person's, or the scenario harness's) and never a sub-agent's.
 *
 * @param command - The Bash command the agent is about to run.
 * @param agentId - The hook input's `agent_id`, absent outside a sub-agent.
 * @returns Allow, rewrite with the stamped command, or deny with a reason.
 */
export function decideBashCommand(
  command: string,
  agentId: string | undefined,
): BashCommandDecision {
  const scan = scanShellCommand(command);
  if (scan.kind === 'opaque') {
    return MAY_CLAIM.test(command)
      ? { kind: 'deny', reason: opaqueReason(scan.construct) }
      : { kind: 'allow' };
  }
  if (MAY_CLAIM.test(command) && scan.commands.some(runsAnotherCommandLine)) {
    return { kind: 'deny', reason: opaqueReason('another shell or interpreter') };
  }
  const invocations = scan.commands.flatMap((words) => rundownInvocationOf(words) ?? []);
  if (invocations.length === 0) return { kind: 'allow' };
  if (agentId === undefined && invocations.some((found) => found.subcommand === 'claim')) {
    return { kind: 'deny', reason: CLAIM_OUTSIDE_SUBAGENT_REASON };
  }
  const rewritten = stamp(command, invocations, agentId);
  return rewritten === command ? { kind: 'allow' } : { kind: 'rewrite', command: rewritten };
}

/**
 * Splice the stamp into the source: delete every `--agent-id` the agent
 * passed, and insert the hook's own right after each subcommand word.
 *
 * @param command - The original command.
 * @param invocations - The claim and release invocations found in it.
 * @param agentId - The id to stamp, or undefined to stamp none.
 * @returns The rewritten command.
 */
function stamp(
  command: string,
  invocations: readonly RundownInvocation[],
  agentId: string | undefined,
): string {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const invocation of invocations) {
    for (const span of invocation.agentIds) {
      // Take the whitespace before the flag with it, so no gap is left behind.
      let start = span.start;
      while (start > 0 && (command[start - 1] === ' ' || command[start - 1] === '\t')) start -= 1;
      edits.push({ start, end: span.end, text: '' });
    }
    if (agentId !== undefined) {
      const at = invocation.subcommandWord.end;
      edits.push({ start: at, end: at, text: ` --agent-id ${shellQuote(agentId)}` });
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = command;
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * Handle a PreToolUse(Bash) hook event.
 *
 * @param input - Hook input; reads `tool_input.command` and `agent_id`.
 * @returns The decision for the command; `allow` when there is no command.
 */
export function handleBashCommand(input: HookInput): BashCommandDecision {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return { kind: 'allow' };
  const agentId =
    input.agent_id === undefined || input.agent_id === '' ? undefined : input.agent_id;
  return decideBashCommand(command, agentId);
}
