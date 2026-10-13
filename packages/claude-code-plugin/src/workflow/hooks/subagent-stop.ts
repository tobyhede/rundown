// src/workflow/hooks/subagent-stop.ts
import { existsSync } from 'node:fs';
import { ClaimedDelegationsResponseSchema, dbPath } from '@rundown-org/core';
import type { z } from 'zod';
import type { HookInput } from '../../shared/index.js';
import { rundown } from './rundown.js';

/**
 * Result from handling a SubagentStop hook event.
 *
 * Returned by {@link handleSubagentStop} to communicate whether the subagent
 * stop produced actionable context or a policy/runtime violation.
 */
export interface SubagentStopResult {
  /** Summary of the action taken. Undefined when no action was needed. */
  context?: string;
  /** Description of the policy or runtime error that caused the stop. Undefined when the subagent stopped normally. */
  violation?: string;
}

/** The Delegations that still hold an agent, as `status --claimed-by` reports them. */
type HeldDelegations = z.infer<typeof ClaimedDelegationsResponseSchema>['delegations'];

/**
 * The finish-or-release instruction the gate blocks with.
 *
 * @param held - The children still holding the agent.
 * @returns The block reason, fed back to the sub-agent as its next instruction.
 */
export function finishOrReleaseInstruction(held: HeldDelegations): string {
  const children = held
    .map(
      (child) => `- ${child.runId} (${child.runbook}, for ${child.step} of ${child.parentRunId})`,
    )
    .join('\n');
  return [
    'You claimed a delegated Rundown child that is still running and its parent still counts it, so you cannot stop yet:',
    children,
    '',
    'Finish it: drive it with `rundown pass|fail --token <its owner_token> --step <step>` until it reports `runbook_completed` or `runbook_stopped`, or end it with `rundown stop --token <its owner_token>`.',
    'If you lost its owner_token, release it with `rundown release <child run id>` (the plugin stamps your agent id); its parent collects it as a fail.',
    'Then stop.',
  ].join('\n');
}

/**
 * Handle a SubagentStop hook event (#907, ADR 0005).
 *
 * Asks the CLI, never the store, which Delegations still hold the stopping
 * sub-agent: `rundown status --claimed-by <agent_id>`, whose answer core
 * decides (running, claimed under this agent id, still counted by its
 * parent). While any is held the stop is blocked with the finish-or-release
 * instruction; once each is finished, abandoned or cancelled the stop is
 * allowed. It keeps no counter and records nothing, so a sub-agent that
 * ignores the instruction is blocked again on every stop until a person
 * interrupts it (accepted by the ADR).
 *
 * A stop with no `agent_id`, or in a project with no Rundown store, holds
 * nothing: the Bash hook refuses every claim made without an agent id, and
 * no claim exists before the store does. The store is never created here.
 *
 * @param input - Hook event payload
 * @returns A violation while a child holds the agent; otherwise empty
 * @throws {Error} When the CLI cannot be run or its answer is not the expected
 *   JSON; the gate converts this into a blocking decision (fail closed).
 */
export function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  const agentId = input.agent_id;
  if (agentId === undefined || agentId === '') return Promise.resolve({});
  if (!existsSync(dbPath(input.cwd))) return Promise.resolve({});
  const answer = ClaimedDelegationsResponseSchema.parse(
    JSON.parse(rundown(['status', '--claimed-by', agentId], input.cwd)),
  );
  if (answer.delegations.length === 0) return Promise.resolve({});
  return Promise.resolve({ violation: finishOrReleaseInstruction(answer.delegations) });
}
