/**
 * The plugin's delegation hooks against the real CLI (#907, ADR 0005).
 *
 * A parent run delegates one child. The orchestrator dispatches a sub-agent
 * with the Claim Ticket marker; the sub-agent's `rundown claim` goes through
 * the Bash hook, which stamps its `--agent-id` on every claim and release it
 * reads with confidence, and the CLI — run with `CLAUDECODE=1`, as in a
 * Claude Code Bash call — refuses a claim the hook did not stamp; then the SubagentStop gate blocks
 * the sub-agent while the child is running and counted, and lets it stop once
 * the child finished, was released (abandoned), or was cancelled by `retry`.
 * Every hook call goes through `dispatch` and `buildHookOutput`, as the hook
 * entrypoint runs them; every rundown command runs the built CLI.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { dispatch } from '../../../src/dispatcher.js';
import { buildHookOutput } from '../../../src/hook-output.js';
import type { HookInput } from '../../../src/shared/index.js';
import { getCliPath, runCli, withOwnerToken } from '../../helpers/test-utils.js';

const PARENT = `# Parent

## 1. Delegate
- DELEGATE
- PASS ALL CONTINUE
- FAIL ANY STOP

- child.runbook.md

## 2. After
- PASS COMPLETE
- FAIL STOP

Finish.
`;

const CHILD = `# Child

## 1. Check
- PASS COMPLETE
- FAIL STOP

Check by hand.
`;

type Event = Record<string, unknown>;

function events(stdout: string): Event[] {
  try {
    // A single (pretty-printed) JSON document, such as an error envelope.
    return [JSON.parse(stdout) as Event];
  } catch {
    // An event stream: one JSON document per line.
  }
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Event);
}

let cwd: string;
const sessionProjectDir = process.env.CLAUDE_PROJECT_DIR;

beforeEach(async () => {
  // The gate reads CLAUDE_PROJECT_DIR when Claude Code sets it; these tests
  // stand in for Claude Code, so they set it only where they mean to.
  delete process.env.CLAUDE_PROJECT_DIR;
  cwd = await mkdtemp(path.join(tmpdir(), 'rd-plugin-hooks-'));
  await writeFile(path.join(cwd, 'parent.runbook.md'), PARENT);
  await writeFile(path.join(cwd, 'child.runbook.md'), CHILD);
});

afterEach(async () => {
  if (sessionProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = sessionProjectDir;
  await rm(cwd, { recursive: true, force: true });
});

/** Start the parent; return its run id and the child's ticket. */
function start(): { parentId: string; ticket: string } {
  const run = events(runCli(['run', 'parent.runbook.md'], cwd).stdout);
  const started = run.find((event) => event.type === 'runbook_started');
  const entered = run.find((event) => event.type === 'step_entered');
  const child = ((entered?.children ?? []) as { ticket?: string }[]).at(0);
  return { parentId: String(started?.runbookId), ticket: String(child?.ticket) };
}

/**
 * Run a Bash command as Claude Code would after the PreToolUse(Bash) hook:
 * the hook's rewrite, if any, under `CLAUDECODE=1`.
 */
async function bashAs(agentId: string | undefined, command: string) {
  const input: HookInput = {
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Bash',
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    tool_input: { command },
  };
  const output = buildHookOutput(input, await dispatch(input));
  const hook = output.hookSpecificOutput;
  if (hook?.permissionDecision === 'deny') {
    return { denied: String(hook.permissionDecisionReason), events: [] as Event[] };
  }
  const rewritten = hook?.updatedInput?.command;
  const run = typeof rewritten === 'string' ? rewritten : command;
  const result = spawnSync('bash', ['-c', run], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1', RUNDOWN_LOG: '0', CLAUDECODE: '1' },
  });
  return { ran: run, events: events(result.stdout) };
}

/** The CLI as a Bash command string. */
function rundownCommand(args: string): string {
  return `node ${getCliPath()} ${args}`;
}

/** What the SubagentStop gate tells a stopping sub-agent, whose cwd may have moved. */
async function stop(agentId: string, at: string = cwd) {
  const input: HookInput = { hook_event_name: 'SubagentStop', cwd: at, agent_id: agentId };
  return buildHookOutput(input, await dispatch(input));
}

/** Dispatch the sub-agent, then claim as it, through the hooks. */
async function claimAsSubAgent(ticket: string, agentId: string) {
  const dispatched = await dispatch({
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Agent',
    tool_input: { prompt: `Review it.\nRD_CLAIM_TICKET=${ticket}` },
  });
  expect(String(dispatched.updatedInput?.prompt)).toContain(`rundown claim ${ticket}`);

  const claim = await bashAs(agentId, rundownCommand(`claim ${ticket}`));
  expect(claim.ran).toBe(rundownCommand(`claim --agent-id '${agentId}' ${ticket}`));
  const started = claim.events.find((event) => event.type === 'runbook_started');
  return { childId: String(started?.runbookId), childToken: String(started?.owner_token) };
}

describe('the delegation hooks over the real CLI (#907)', () => {
  it('refuses claim outside a sub-agent and creates nothing', async () => {
    const { parentId, ticket } = start();

    const claim = await bashAs(undefined, rundownCommand(`claim ${ticket}`));

    expect(claim.denied).toMatch(/CLAIM_OUTSIDE_SUBAGENT/);
    expect(claim.denied).toMatch(/sub-agent/);
    const status = JSON.parse(runCli(['status', '--run', parentId], cwd).stdout) as Event;
    expect(status.children).toEqual([expect.objectContaining({ status: 'reserved' })]);
  });

  it('blocks the claiming sub-agent while its child runs, and allows it once the child finished', async () => {
    const { ticket } = start();
    const { childId, childToken } = await claimAsSubAgent(ticket, 'sub-1');

    const blocked = await stop('sub-1');
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain(childId);
    expect(blocked.reason).toMatch(/rundown release <child run id>/);
    expect(await stop('sub-2')).toEqual({});
    // No counter: a second stop is blocked again.
    expect((await stop('sub-1')).decision).toBe('block');

    runCli(['pass', '--token', childToken, '--step', '1'], cwd);
    expect(await stop('sub-1')).toEqual({});
  });

  it('allows the stop once the sub-agent released its child, with release stamped by the hook', async () => {
    const { ticket } = start();
    const { childId } = await claimAsSubAgent(ticket, 'sub-1');

    // A spoofed id is replaced by the hook's own, so the release is authorized.
    const release = await bashAs('sub-1', rundownCommand(`release ${childId} --agent-id sub-9`));
    expect(release.ran).toBe(rundownCommand(`release --agent-id 'sub-1' ${childId}`));
    expect(release.events).toEqual([expect.objectContaining({ type: 'runbook_abandoned' })]);

    expect(await stop('sub-1')).toEqual({});
  });

  it("never lets another agent release the child: the hook stamps that agent's own id", async () => {
    const { ticket } = start();
    const { childId } = await claimAsSubAgent(ticket, 'sub-1');

    const other = await bashAs('sub-2', rundownCommand(`release ${childId} --agent-id sub-1`));
    const topLevel = await bashAs(undefined, rundownCommand(`release ${childId} --agent-id sub-1`));

    expect(other.events).toEqual([expect.objectContaining({ code: 'AGENT_MISMATCH' })]);
    expect(topLevel.events).toEqual([expect.objectContaining({ code: 'AGENT_MISMATCH' })]);
    expect((await stop('sub-1')).decision).toBe('block');
  });

  it('allows the stop once the parent cancelled the child by retry', async () => {
    const { parentId, ticket } = start();
    await claimAsSubAgent(ticket, 'sub-1');

    const retry = runCli([...withOwnerToken(['retry', '--step', '1.1'], cwd, parentId)], cwd);
    expect(retry.exitCode).toBe(0);

    expect(await stop('sub-1')).toEqual({});
  });

  // Review findings H1-H3. The hook stamps what it reads with confidence and
  // leaves the rest untouched; the CLI fails closed on what it missed.
  it.each([undefined, 'sub-1'])(
    'fails closed on a claim spelled through a variable (agent %s): the hook leaves it, the CLI refuses it unstamped',
    async (agentId) => {
      const { parentId, ticket } = start();
      const command = `S=claim; ${rundownCommand(`$S ${ticket}`)}`;

      const claim = await bashAs(agentId, command);

      expect(claim.ran).toBe(command);
      expect(claim.events).toEqual([expect.objectContaining({ code: 'AGENT_ID_REQUIRED' })]);
      const status = JSON.parse(runCli(['status', '--run', parentId], cwd).stdout) as Event;
      expect(status.children).toEqual([expect.objectContaining({ status: 'reserved' })]);
    },
  );

  it('stamps a claim run under a wrapper such as timeout', async () => {
    const { ticket } = start();

    const claim = await bashAs('sub-1', `timeout 30 ${rundownCommand(`claim ${ticket}`)}`);

    expect(claim.ran).toBe(`timeout 30 ${rundownCommand(`claim --agent-id 'sub-1' ${ticket}`)}`);
    expect(claim.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'runbook_started' })]),
    );
    expect((await stop('sub-1')).decision).toBe('block');
  });

  it('never lets an --agent-id smuggled through a variable release under another agent', async () => {
    const { ticket } = start();
    const { childId } = await claimAsSubAgent(ticket, 'sub-1');

    const release = await bashAs(
      'sub-2',
      `A=--agent-id=sub-1; ${rundownCommand(`release $A ${childId}`)}`,
    );

    expect(release.events).toEqual([expect.objectContaining({ code: 'INVALID_SYNTAX' })]);
    expect((await stop('sub-1')).decision).toBe('block');
  });

  it('blocks a sub-agent that moved into a subdirectory: the gate asks in CLAUDE_PROJECT_DIR (H5)', async () => {
    const { ticket } = start();
    await claimAsSubAgent(ticket, 'sub-1');
    const nested = path.join(cwd, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    process.env.CLAUDE_PROJECT_DIR = cwd;

    expect((await stop('sub-1', nested)).decision).toBe('block');
  });

  it('still blocks when CLAUDE_PROJECT_DIR names another directory than the run store', async () => {
    const { ticket } = start();
    await claimAsSubAgent(ticket, 'sub-1');
    const elsewhere = path.join(cwd, 'elsewhere');
    await mkdir(elsewhere);
    process.env.CLAUDE_PROJECT_DIR = elsewhere;

    expect((await stop('sub-1')).decision).toBe('block');
  });

  it('allows a stop with no Rundown store and never creates one', async () => {
    expect(await stop('sub-1')).toEqual({});
    expect(spawnSync('ls', ['-A', cwd], { encoding: 'utf-8' }).stdout).not.toContain('.rundown');
  });
});
