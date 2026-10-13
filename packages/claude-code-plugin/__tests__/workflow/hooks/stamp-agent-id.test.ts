// __tests__/workflow/hooks/stamp-agent-id.test.ts
//
// The PreToolUse(Bash) hook (#907, ADR 0005): it stamps the calling agent's
// id on `rundown claim` / `rundown release`, replaces any id the agent typed,
// and refuses `claim` outside a sub-agent. Driven through the hook's public
// decision and through the dispatcher, as Claude Code calls it.
import { describe, expect, it } from '@jest/globals';
import { dispatch } from '../../../src/dispatcher.js';
import { buildHookOutput } from '../../../src/hook-output.js';
import type { HookInput } from '../../../src/shared/index.js';
import { decideBashCommand } from '../../../src/workflow/hooks/stamp-agent-id.js';

const TICKET = `rdt_${'A'.repeat(43)}`;
const CHILD = `rd_${'0123456789abcdef'.repeat(2)}`;

describe('stamping --agent-id on claim and release', () => {
  it.each([
    [`rundown claim ${TICKET}`, `rundown claim --agent-id 'agent-1' ${TICKET}`],
    [`rd claim ${TICKET}`, `rd claim --agent-id 'agent-1' ${TICKET}`],
    [`rundown release ${CHILD}`, `rundown release --agent-id 'agent-1' ${CHILD}`],
    [
      `cd /repo && RUNDOWN_LOG=0 rundown claim ${TICKET}`,
      `cd /repo && RUNDOWN_LOG=0 rundown claim --agent-id 'agent-1' ${TICKET}`,
    ],
    [
      `env RUNDOWN_LOG=0 npx rundown claim ${TICKET} | tee out.json`,
      `env RUNDOWN_LOG=0 npx rundown claim --agent-id 'agent-1' ${TICKET} | tee out.json`,
    ],
    [
      `rundown --policy p.yaml claim ${TICKET} 2>&1`,
      `rundown --policy p.yaml claim --agent-id 'agent-1' ${TICKET} 2>&1`,
    ],
    [
      `node packages/cli/dist/cli.js claim ${TICKET}`,
      `node packages/cli/dist/cli.js claim --agent-id 'agent-1' ${TICKET}`,
    ],
    [
      `rundown status; rundown release ${CHILD} > release.json`,
      `rundown status; rundown release --agent-id 'agent-1' ${CHILD} > release.json`,
    ],
  ])('rewrites %s', (command, expected) => {
    expect(decideBashCommand(command, 'agent-1')).toEqual({ kind: 'rewrite', command: expected });
  });

  it('replaces an agent id the agent passed itself, in either spelling', () => {
    expect(decideBashCommand(`rundown claim ${TICKET} --agent-id other`, 'agent-1')).toEqual({
      kind: 'rewrite',
      command: `rundown claim --agent-id 'agent-1' ${TICKET}`,
    });
    expect(
      decideBashCommand(`rundown release --agent-id="spoofed id" ${CHILD}`, 'agent-1'),
    ).toEqual({ kind: 'rewrite', command: `rundown release --agent-id 'agent-1' ${CHILD}` });
  });

  it('quotes an agent id as one shell word', () => {
    expect(decideBashCommand(`rundown claim ${TICKET}`, "a'; rm -rf ~; '")).toEqual({
      kind: 'rewrite',
      command: `rundown claim --agent-id 'a'\\''; rm -rf ~; '\\''' ${TICKET}`,
    });
  });

  it('stamps every claim and release of a compound command', () => {
    expect(
      decideBashCommand(`rundown claim ${TICKET} && rundown release ${CHILD}`, 'agent-1'),
    ).toEqual({
      kind: 'rewrite',
      command: `rundown claim --agent-id 'agent-1' ${TICKET} && rundown release --agent-id 'agent-1' ${CHILD}`,
    });
  });

  it.each([
    'rundown pass --token rdo_x --step 1',
    'rundown status --claimed-by agent-1',
    'git commit -m "rundown claim docs"',
    'echo claim release',
    `rundown run claim.runbook.md`,
  ])('leaves %s alone', (command) => {
    expect(decideBashCommand(command, 'agent-1')).toEqual({ kind: 'allow' });
  });
});

describe('outside a sub-agent (no agent_id)', () => {
  it('refuses claim, naming the dispatch it should have been', () => {
    const decision = decideBashCommand(`rundown claim ${TICKET}`, undefined);
    expect(decision).toMatchObject({ kind: 'deny' });
    expect(decision.kind === 'deny' && decision.reason).toMatch(/sub-agent/);
    expect(decision.kind === 'deny' && decision.reason).not.toContain(TICKET);
  });

  it('refuses a claim it carries an agent id for, too: the top level cannot borrow one', () => {
    expect(
      decideBashCommand(`rundown claim ${TICKET} --agent-id agent-1`, undefined),
    ).toMatchObject({ kind: 'deny' });
  });

  it('strips any agent id from release, so it matches only an unstamped claim', () => {
    expect(decideBashCommand(`rundown release ${CHILD} --agent-id agent-1`, undefined)).toEqual({
      kind: 'rewrite',
      command: `rundown release ${CHILD}`,
    });
    expect(decideBashCommand(`rundown release ${CHILD}`, undefined)).toEqual({ kind: 'allow' });
  });
});

describe('commands the hook cannot read', () => {
  it.each([
    `echo $(rundown claim ${TICKET})`,
    `x=\`rundown claim ${TICKET}\``,
    `bash -c "rundown claim ${TICKET}"`,
    `echo ${TICKET} | xargs rundown claim`,
  ])('fails closed on %s', (command) => {
    expect(decideBashCommand(command, 'agent-1')).toMatchObject({ kind: 'deny' });
  });

  it('allows an opaque command that names no claim or release', () => {
    expect(decideBashCommand('echo $(date)', 'agent-1')).toEqual({ kind: 'allow' });
  });
});

describe('PreToolUse(Bash) through the dispatcher', () => {
  function bash(command: string, agentId?: string): HookInput {
    return {
      hook_event_name: 'PreToolUse',
      cwd: '/repo',
      tool_name: 'Bash',
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
      tool_input: { command, description: 'Claim the child', timeout: 60000 },
    };
  }

  it('rewrites the command in updatedInput, keeping the other fields, with no permission decision', async () => {
    const input = bash(`rundown claim ${TICKET}`, 'agent-1');
    const output = buildHookOutput(input, await dispatch(input));

    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          command: `rundown claim --agent-id 'agent-1' ${TICKET}`,
          description: 'Claim the child',
          timeout: 60000,
        },
      },
    });
  });

  it('denies claim without an agent_id', async () => {
    const input = bash(`rundown claim ${TICKET}`);
    const output = buildHookOutput(input, await dispatch(input));

    expect(output.hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringMatching(/sub-agent/),
    });
  });

  it('emits nothing for an ordinary command', async () => {
    const input = bash('rundown pass --token rdo_x --step 1', 'agent-1');
    expect(buildHookOutput(input, await dispatch(input))).toEqual({});
  });
});
