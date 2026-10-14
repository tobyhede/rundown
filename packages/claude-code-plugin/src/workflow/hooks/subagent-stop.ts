// src/workflow/hooks/subagent-stop.ts
import { existsSync, realpathSync } from 'node:fs';
import { ClaimedDelegationsResponseSchema, dbPath, resolveProjectRoot } from '@rundown-org/core';
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
 * The project roots whose Rundown store may hold a claim by the stopping agent.
 *
 * Two starting points: the session's project directory, `CLAUDE_PROJECT_DIR`,
 * which Claude Code exports to every command hook as the directory the
 * session started in, independent of later `cd`s; and the hook input's
 * `cwd`, which follows the agent's `cd`. Each is mapped to its project root
 * the way the CLI maps its own working directory (`resolveProjectRoot`: the
 * nearest directory holding `.rundown/`), so a claim made from a
 * subdirectory is found in the root store it went to. Both are read, so a
 * claim in either project holds the agent. Roots are compared by their real
 * paths, so one store reached through two spellings is asked once.
 *
 * @param input - Hook event payload.
 * @returns The distinct project roots to ask, the project directory's first.
 */
export function storeDirectories(input: HookInput): readonly string[] {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const starts =
    projectDir === undefined || projectDir === '' ? [input.cwd] : [projectDir, input.cwd];
  return [...new Set(starts.map((start) => canonical(resolveProjectRoot(start))))];
}

/**
 * A path's canonical spelling, so two spellings of one project root (a
 * symlink, or `/tmp` and `/private/tmp` on macOS) ask its store once.
 *
 * @param dir - A project root.
 * @returns Its real path, or `dir` itself when it cannot be resolved.
 */
function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
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
 * The question is asked in the project roots of the session's project
 * directory and of the hook's `cwd` (see {@link storeDirectories}), so a
 * sub-agent that moved into a subdirectory is still held.
 *
 * A stop with no `agent_id`, or where neither project root has a Rundown store, holds
 * nothing: a claim with no agent id records none, so it holds no sub-agent,
 * and no claim exists before the store does. The store is never created here.
 *
 * @param input - Hook event payload
 * @returns A violation while a child holds the agent; otherwise empty
 * @throws {Error} When the CLI cannot be run or its answer is not the expected
 *   JSON; the gate converts this into a blocking decision (fail closed).
 */
export function handleSubagentStop(input: HookInput): Promise<SubagentStopResult> {
  const agentId = input.agent_id;
  if (agentId === undefined || agentId === '') return Promise.resolve({});
  const held = storeDirectories(input)
    .filter((dir) => existsSync(dbPath(dir)))
    .flatMap(
      (dir) =>
        ClaimedDelegationsResponseSchema.parse(
          JSON.parse(rundown(['status', '--claimed-by', agentId], dir)),
        ).delegations,
    );
  if (held.length === 0) return Promise.resolve({});
  return Promise.resolve({ violation: finishOrReleaseInstruction(held) });
}
