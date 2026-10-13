// __tests__/workflow/hooks/stamp-agent-id.test.ts
//
// The PreToolUse(Bash) hook (#907, ADR 0005): it stamps the calling
// sub-agent's id on every `rundown claim` / `rundown release` it can read with
// confidence, strips any `--agent-id` the agent typed, and denies a claim it
// reads from an agent with no `agent_id`. Every other command — including one
// it cannot read — passes through byte for byte, so the user's Bash
// permission rules still match it; the CLI refuses an unstamped claim inside
// Claude Code (delegation-hooks.integration.test.ts drives that).
import { describe, expect, it } from '@jest/globals';
import { dispatch } from '../../../src/dispatcher.js';
import { buildHookOutput } from '../../../src/hook-output.js';
import type { HookInput } from '../../../src/shared/index.js';
import { decideBashCommand } from '../../../src/workflow/hooks/stamp-agent-id.js';

const TICKET = `rdt_${'A'.repeat(43)}`;
const CHILD = `rd_${'0123456789abcdef'.repeat(2)}`;
const STAMP = "--agent-id 'agent-1'";

describe('stamping --agent-id on a claim or release it reads with confidence', () => {
  it.each([
    [`rundown claim ${TICKET}`, `rundown claim ${STAMP} ${TICKET}`],
    [`rd claim ${TICKET}`, `rd claim ${STAMP} ${TICKET}`],
    [`rundown release ${CHILD}`, `rundown release ${STAMP} ${CHILD}`],
    [
      `cd /repo && RUNDOWN_LOG=0 rundown claim ${TICKET}`,
      `cd /repo && RUNDOWN_LOG=0 rundown claim ${STAMP} ${TICKET}`,
    ],
    [
      `env RUNDOWN_LOG=0 rundown claim ${TICKET} | tee out.json`,
      `env RUNDOWN_LOG=0 rundown claim ${STAMP} ${TICKET} | tee out.json`,
    ],
    [`timeout 30 rundown claim ${TICKET}`, `timeout 30 rundown claim ${STAMP} ${TICKET}`],
    [
      `timeout -k 5 --signal=TERM 2m rundown claim ${TICKET}`,
      `timeout -k 5 --signal=TERM 2m rundown claim ${STAMP} ${TICKET}`,
    ],
    [`nice -n 10 rundown claim ${TICKET}`, `nice -n 10 rundown claim ${STAMP} ${TICKET}`],
    [`npx @rundown-org/cli claim ${TICKET}`, `npx @rundown-org/cli claim ${STAMP} ${TICKET}`],
    [`npx -y rundown claim ${TICKET}`, `npx -y rundown claim ${STAMP} ${TICKET}`],
    [`pnpm exec rundown claim ${TICKET}`, `pnpm exec rundown claim ${STAMP} ${TICKET}`],
    [
      `node packages/cli/dist/cli.js claim ${TICKET}`,
      `node packages/cli/dist/cli.js claim ${STAMP} ${TICKET}`,
    ],
    [
      `rundown status; rundown release ${CHILD} > release.json`,
      `rundown status; rundown release ${STAMP} ${CHILD} > release.json`,
    ],
    [
      `rundown claim ${TICKET} && rundown release ${CHILD}`,
      `rundown claim ${STAMP} ${TICKET} && rundown release ${STAMP} ${CHILD}`,
    ],
  ])('rewrites %s', (command, expected) => {
    expect(decideBashCommand(command, 'agent-1')).toEqual({ kind: 'rewrite', command: expected });
  });

  it('strips an agent id the agent typed, in either spelling', () => {
    expect(decideBashCommand(`rundown claim ${TICKET} --agent-id other`, 'agent-1')).toEqual({
      kind: 'rewrite',
      command: `rundown claim ${STAMP} ${TICKET}`,
    });
    expect(
      decideBashCommand(`rundown release --agent-id="spoofed id" ${CHILD}`, 'agent-1'),
    ).toEqual({ kind: 'rewrite', command: `rundown release ${STAMP} ${CHILD}` });
  });

  it('quotes an agent id as one shell word', () => {
    expect(decideBashCommand(`rundown claim ${TICKET}`, "a'; rm -rf ~; '")).toEqual({
      kind: 'rewrite',
      command: `rundown claim --agent-id 'a'\\''; rm -rf ~; '\\''' ${TICKET}`,
    });
  });
});

describe('outside a sub-agent (no agent_id)', () => {
  it('denies a claim it reads, naming the dispatch it should have been', () => {
    const decision = decideBashCommand(`timeout 30 rundown claim ${TICKET}`, undefined);
    expect(decision).toMatchObject({ kind: 'deny' });
    expect(decision.kind === 'deny' && decision.reason).toMatch(/CLAIM_OUTSIDE_SUBAGENT/);
    expect(decision.kind === 'deny' && decision.reason).toMatch(/sub-agent/);
    expect(decision.kind === 'deny' && decision.reason).not.toContain(TICKET);
  });

  it('strips any agent id from a release, so it matches only an unstamped claim', () => {
    expect(decideBashCommand(`rundown release ${CHILD} --agent-id agent-1`, undefined)).toEqual({
      kind: 'rewrite',
      command: `rundown release ${CHILD}`,
    });
    expect(decideBashCommand(`rundown release ${CHILD}`, undefined)).toEqual({ kind: 'allow' });
  });
});

describe('commands it leaves byte for byte, never denying on doubt', () => {
  const HEREDOC_COMMIT = [
    "git commit -m \"$(cat <<'EOF'",
    'fix(plugin): rundown release notes',
    '',
    'rundown claim is stamped by the hook.',
    'EOF',
    ')"',
  ].join('\n');

  it.each([
    'git status',
    'rundown pass --token rdo_x --step 1',
    'rundown status --claimed-by agent-1',
    'git commit -m "rundown claim docs"',
    'echo claim release',
    'rundown run claim.runbook.md',
    HEREDOC_COMMIT,
    `echo $(rundown claim ${TICKET})`,
    `x=\`rundown claim ${TICKET}\``,
    `bash -c "rundown claim ${TICKET}"`,
    `eval "rundown claim ${TICKET}"`,
    `echo ${TICKET} | xargs rundown claim`,
    `S=claim; rundown $S ${TICKET}`,
    `R=rundown; $R claim ${TICKET}`,
    `rundown --policy p.yaml claim ${TICKET}`,
    `sudo -u other rundown claim ${TICKET}`,
    `rundown claim ${TICKET} 'unterminated`,
  ])('allows %j untouched, for any caller', (command) => {
    expect(decideBashCommand(command, 'agent-1')).toEqual({ kind: 'allow' });
    expect(decideBashCommand(command, undefined)).toEqual({ kind: 'allow' });
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
          command: `rundown claim ${STAMP} ${TICKET}`,
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

  it('emits nothing for an ordinary command, so permission rules see it as typed', async () => {
    const input = bash('git status', 'agent-1');
    expect(buildHookOutput(input, await dispatch(input))).toEqual({});
  });
});
