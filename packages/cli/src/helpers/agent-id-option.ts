// packages/cli/src/helpers/agent-id-option.ts

import { resolveDelegationAgent, type DelegationAgent } from '@rundown-org/core';
import type { OutputEmitter } from '../services/output-emitter.js';

/**
 * Commander collector for a repeatable `--agent-id`: every value is kept, so
 * core can refuse a duplicate rather than commander silently taking the last.
 *
 * @param value - The value of this occurrence.
 * @param previous - The values collected so far.
 * @returns Every value, in command-line order.
 */
export function collectAgentId(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

/**
 * Resolve the agent a `claim` or `release` runs as (#907, ADR 0005).
 *
 * Reads `CLAUDECODE` — Claude Code sets it to `1` in every Bash tool command —
 * and hands core every `--agent-id` the command carried; core decides what
 * they mean. The environment read is the CLI's (a Category A side effect); a
 * refusal is rendered as an error envelope and sets exit code 1.
 *
 * @param command - The command resolving its agent.
 * @param agentIds - Every `--agent-id` value, or undefined when none was given.
 * @param output - Output emitter the refusal is rendered on.
 * @returns The resolved agent, or undefined after rendering a refusal.
 */
export function resolveAgentIdOption(
  command: 'claim' | 'release',
  agentIds: readonly string[] | undefined,
  output: OutputEmitter,
): DelegationAgent | undefined {
  const resolution = resolveDelegationAgent({
    agentIds: agentIds ?? [],
    insideClaudeCode: process.env.CLAUDECODE === '1',
    command,
  });
  if (resolution.kind === 'resolved') return resolution.agent;
  output.error(resolution.message, resolution.code);
  output.flush();
  process.exitCode = 1;
  return undefined;
}
