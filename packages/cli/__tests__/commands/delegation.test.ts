/**
 * `rundown claim` and `rundown collect` through the in-process CLI (#904).
 *
 * The scenario fixtures under `runbooks/delegation/` pin the protocol end to
 * end; this file pins what only the command surface shows: refusal envelopes
 * and exit codes, what the JSON events carry (and never carry), and the text
 * rendering. Status must never show a Claim Ticket.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RunbookStateManager } from '@rundown-org/core';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

const PARENT = [
  '# Parent',
  '',
  '## 1. Delegate',
  '',
  '- DELEGATE',
  '- PASS ALL CONTINUE',
  '- FAIL ANY STOP',
  '',
  '- child.runbook.md',
  '',
  '## 2. After',
  '',
  '- PASS COMPLETE',
  '- FAIL GOTO 1',
  '',
  'Finish.',
  '',
].join('\n');

const CHILD = [
  '# Child',
  '',
  '## Check',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
  '',
  'Check.',
  '',
].join('\n');

const MANUAL = ['# Manual', '', '## 1. Only', '', '- PASS COMPLETE', '', 'Do it.', ''].join('\n');

type Envelope = Record<string, unknown>;

function envelopes(stdout: string): Envelope[] {
  return parseConcatenatedJson(stdout).filter(
    (value): value is Envelope =>
      typeof value === 'object' && value !== null && !Array.isArray(value),
  );
}

function errorEnvelope(stdout: string): Envelope | undefined {
  return envelopes(stdout).find((document) => document.kind === 'error');
}

/** The children the last `step_entered` of `stdout` lists. */
function enteredChildren(stdout: string): Envelope[] {
  const entered = envelopes(stdout).filter((event) => event.type === 'step_entered');
  return (entered.at(-1)?.children ?? []) as Envelope[];
}

describe('rundown claim / rundown collect (#904)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), PARENT);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
    await writeFile(join(workspace.cwd, 'manual.runbook.md'), MANUAL);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function start(): Promise<{ token: string; runId: string; ticket: string }> {
    const result = await runCliInProcess('run parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    const [child] = enteredChildren(result.stdout);
    return {
      token: requireOwnerToken(result.stdout),
      runId: requireRunId(result.stdout),
      ticket: String(child.ticket),
    };
  }

  it('lists each child with its ticket on step_entered, and status never shows one', async () => {
    const { runId } = await start();

    const status = await runCliInProcess(['status', '--run', runId], workspace);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toMatch(/rdt_/);
    expect(envelopes(status.stdout)[0]?.children).toEqual([
      { runId: expect.stringMatching(/^rd_/), step: '1.1', status: 'reserved' },
    ]);
  });

  it('claims the child: runbook_started names the parent and prints the child token once', async () => {
    const { runId, ticket } = await start();

    const claim = await runCliInProcess(['claim', ticket, '--agent-id', 'agent-1'], workspace);

    expect(claim.exitCode).toBe(0);
    const [started] = envelopes(claim.stdout).filter((event) => event.type === 'runbook_started');
    expect(started).toMatchObject({
      parent: { runId, step: '1.1' },
      owner_token: expect.stringMatching(/^rdo_/),
    });
    expect(claim.stdout.match(/rdo_/g)).toHaveLength(1);
    const status = await runCliInProcess(['status', '--run', runId], workspace);
    expect(envelopes(status.stdout)[0]?.children).toEqual([
      { runId: started.runbookId, step: '1.1', status: 'running' },
    ]);
  });

  it('refuses a second claim ALREADY_CLAIMED, exit 1', async () => {
    const { ticket } = await start();
    await runCliInProcess(['claim', ticket], workspace);

    const again = await runCliInProcess(['claim', ticket], workspace);

    expect(again.exitCode).toBe(1);
    expect(errorEnvelope(again.stdout)).toMatchObject({
      code: 'ALREADY_CLAIMED',
      command: 'claim',
    });
  });

  it('refuses a malformed ticket INVALID_SYNTAX without echoing it, and an unknown one UNKNOWN_TICKET', async () => {
    await start();
    const near = `rdt_${'x'.repeat(10)}`;

    const malformed = await runCliInProcess(['claim', near], workspace);
    expect(malformed.exitCode).toBe(1);
    expect(errorEnvelope(malformed.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });
    expect(malformed.stdout).not.toContain(near);

    const unknown = await runCliInProcess(['claim', `rdt_${'A'.repeat(43)}`], workspace);
    expect(unknown.exitCode).toBe(1);
    expect(errorEnvelope(unknown.stdout)).toMatchObject({ code: 'UNKNOWN_TICKET' });
  });

  it('collect requires the owner token and refuses --run', async () => {
    const { runId } = await start();

    const bare = await runCliInProcess('collect', workspace);
    expect(bare.exitCode).toBe(1);
    expect(errorEnvelope(bare.stdout)).toMatchObject({
      code: 'TOKEN_REQUIRED',
      command: 'collect',
    });

    const byRun = await runCliInProcess(['collect', '--run', runId], workspace);
    expect(byRun.exitCode).toBe(1);
    expect(errorEnvelope(byRun.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });
  });

  it('collect reports each child on children_collected and continues the parent', async () => {
    const { token, ticket } = await start();
    const claim = await runCliInProcess(['claim', ticket], workspace);
    const childToken = requireOwnerToken(claim.stdout);

    const pending = await runCliInProcess(['collect', '--token', token], workspace);
    expect(pending.exitCode).toBe(0);
    expect(envelopes(pending.stdout).map((event) => event.type)).toEqual(['children_collected']);
    expect(envelopes(pending.stdout)[0]?.children).toEqual([
      expect.objectContaining({ step: '1.1', status: 'pending' }),
    ]);

    await runCliInProcess(['pass', '--token', childToken, '--step', 'Check'], workspace);
    const collected = await runCliInProcess(['collect', '--token', token], workspace);
    expect(collected.exitCode).toBe(0);
    const events = envelopes(collected.stdout);
    expect(events[0]).toMatchObject({
      type: 'children_collected',
      children: [expect.objectContaining({ status: 'collected', result: 'pass' })],
    });
    expect(events.find((event) => event.type === 'step_entered')).toMatchObject({
      position: { current: '2' },
    });
  });

  it('collect on a step that delegates nothing is NOTHING_TO_COLLECT, exit 1', async () => {
    const manual = await runCliInProcess('run manual.runbook.md', workspace);
    const token = requireOwnerToken(manual.stdout);

    const result = await runCliInProcess(['collect', '--token', token], workspace);

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({ code: 'NOTHING_TO_COLLECT' });
  });

  it("refuses a cancelled child's command DELEGATION_CANCELLED, exit 1", async () => {
    const { token, ticket } = await start();
    const childToken = requireOwnerToken(
      (await runCliInProcess(['claim', ticket], workspace)).stdout,
    );
    await runCliInProcess(['pass', '--token', token, '--step', '1.1'], workspace);
    await runCliInProcess(['fail', '--token', token, '--step', '2'], workspace);

    const stale = await runCliInProcess(
      ['pass', '--token', childToken, '--step', 'Check'],
      workspace,
    );

    expect(stale.exitCode).toBe(1);
    expect(errorEnvelope(stale.stdout)).toMatchObject({
      code: 'DELEGATION_CANCELLED',
      command: 'pass',
    });
  });

  it('lets a cancelled child stop, exit 0, while its complete stays DELEGATION_CANCELLED', async () => {
    const { token, ticket } = await start();
    const claim = await runCliInProcess(['claim', ticket], workspace);
    const childToken = requireOwnerToken(claim.stdout);
    const childId = requireRunId(claim.stdout);
    await runCliInProcess(['pass', '--token', token, '--step', '1.1'], workspace);

    const complete = await runCliInProcess(['complete', '--token', childToken], workspace);
    expect(complete.exitCode).toBe(1);
    expect(errorEnvelope(complete.stdout)).toMatchObject({ code: 'DELEGATION_CANCELLED' });

    const stop = await runCliInProcess(['stop', '--token', childToken], workspace);
    expect(stop.exitCode).toBe(0);
    const status = await runCliInProcess(['status', '--run', childId], workspace);
    expect(envelopes(status.stdout)[0]).toMatchObject({
      active: false,
      lastAction: { action: 'STOP' },
    });
  });

  it('refuses a child whose parent was pruned PARENT_RUN_FINISHED, and lets it stop', async () => {
    const { token, ticket } = await start();
    const childToken = requireOwnerToken(
      (await runCliInProcess(['claim', ticket], workspace)).stdout,
    );
    await runCliInProcess(['stop', '--token', token], workspace);
    expect((await runCliInProcess(['prune', '--stopped'], workspace)).exitCode).toBe(0);

    const pass = await runCliInProcess(
      ['pass', '--token', childToken, '--step', 'Check'],
      workspace,
    );
    expect(pass.exitCode).toBe(1);
    expect(errorEnvelope(pass.stdout)).toMatchObject({
      code: 'PARENT_RUN_FINISHED',
      command: 'pass',
    });

    const stop = await runCliInProcess(['stop', '--token', childToken], workspace);
    expect(stop.exitCode).toBe(0);
  });

  it('renders tickets on the entry and the collect report in --text', async () => {
    const run = await runCliInProcess('run parent.runbook.md --text', workspace);
    expect(run.stdout).toMatch(
      /Delegation 1\.1: child\.runbook\.md \(rd_[0-9a-f]{32}\) ticket rdt_/,
    );
    const token = /Owner token: (rdo_\S+)/.exec(run.stdout)?.[1] ?? '';

    const collect = await runCliInProcess(['collect', '--token', token, '--text'], workspace);
    expect(collect.stdout).toMatch(/Child 1\.1 rd_[0-9a-f]{32}: unclaimed/);
  });

  describe('rundown retry (#905)', () => {
    it('prints the fresh child and its new ticket on delegation_retried; the old ticket is cancelled', async () => {
      const { token, runId, ticket } = await start();

      const retry = await runCliInProcess(['retry', '--token', token, '--step', '1.1'], workspace);

      expect(retry.exitCode).toBe(0);
      const [retried] = envelopes(retry.stdout);
      expect(retried).toMatchObject({
        type: 'delegation_retried',
        runbookId: runId,
        step: '1.1',
        cancelledRunId: expect.stringMatching(/^rd_/),
        children: [
          {
            step: '1.1',
            runId: expect.stringMatching(/^rd_/),
            runbook: 'child.runbook.md',
            ticket: expect.stringMatching(/^rdt_/),
          },
        ],
      });
      const [fresh] = retried.children as Envelope[];
      expect(fresh.ticket).not.toBe(ticket);
      expect(retry.stdout.match(/rdt_/g)).toHaveLength(1);

      const stale = await runCliInProcess(['claim', ticket], workspace);
      expect(stale.exitCode).toBe(1);
      expect(errorEnvelope(stale.stdout)).toMatchObject({
        code: 'DELEGATION_CANCELLED',
        command: 'claim',
      });
      const status = await runCliInProcess(['status', '--run', runId], workspace);
      expect(status.stdout).not.toMatch(/rdt_/);
      expect(envelopes(status.stdout)[0]?.children).toEqual([
        { runId: fresh.runId, step: '1.1', status: 'reserved' },
      ]);
      expect((await runCliInProcess(['claim', String(fresh.ticket)], workspace)).exitCode).toBe(0);
    });

    it("refuses the retried child's commands DELEGATION_CANCELLED", async () => {
      const { token, ticket } = await start();
      const childToken = requireOwnerToken(
        (await runCliInProcess(['claim', ticket], workspace)).stdout,
      );
      await runCliInProcess(['retry', '--token', token, '--step', '1.1'], workspace);

      const stale = await runCliInProcess(
        ['pass', '--token', childToken, '--step', 'Check'],
        workspace,
      );

      expect(stale.exitCode).toBe(1);
      expect(errorEnvelope(stale.stdout)).toMatchObject({ code: 'DELEGATION_CANCELLED' });
    });

    it('requires the owner token, refuses --run, and refuses a step it cannot retry', async () => {
      const { token, runId } = await start();

      const bare = await runCliInProcess(['retry', '--step', '1.1'], workspace);
      expect(bare.exitCode).toBe(1);
      expect(errorEnvelope(bare.stdout)).toMatchObject({
        code: 'TOKEN_REQUIRED',
        command: 'retry',
      });

      const byRun = await runCliInProcess(['retry', '--run', runId, '--step', '1.1'], workspace);
      expect(errorEnvelope(byRun.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });

      const wrongStep = await runCliInProcess(
        ['retry', '--token', token, '--step', '2'],
        workspace,
      );
      expect(wrongStep.exitCode).toBe(1);
      expect(errorEnvelope(wrongStep.stdout)).toMatchObject({ code: 'INVALID_STEP' });

      // Step 1 has the one substep 1.1: naming one it does not have is a
      // wrong position, not a substep with nothing to retry.
      const noSuchSubstep = await runCliInProcess(
        ['retry', '--token', token, '--step', '1.2'],
        workspace,
      );
      expect(noSuchSubstep.exitCode).toBe(1);
      expect(errorEnvelope(noSuchSubstep.stdout)).toMatchObject({
        code: 'INVALID_STEP',
        error: expect.stringContaining('has no substep "2"'),
      });
    });

    it('renders the retried child and its ticket in --text', async () => {
      const { token } = await start();
      const retry = await runCliInProcess(
        ['retry', '--token', token, '--step', '1.1', '--text'],
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toMatch(/Retried 1\.1: cancelled rd_[0-9a-f]{32}/);
      expect(retry.stdout).toMatch(
        /Delegation 1\.1: child\.runbook\.md \(rd_[0-9a-f]{32}\) ticket rdt_/,
      );
    });
  });

  describe('rundown release (#905)', () => {
    async function claimAs(agentId?: string) {
      const { token, runId, ticket } = await start();
      const claim = await runCliInProcess(
        ['claim', ticket, ...(agentId !== undefined ? ['--agent-id', agentId] : [])],
        workspace,
      );
      return { token, runId, childId: requireRunId(claim.stdout) };
    }

    it('abandons the child for the agent that claimed it, and collect applies it as fail', async () => {
      const { token, runId, childId } = await claimAs('agent-1');

      const release = await runCliInProcess(
        ['release', childId, '--agent-id', 'agent-1'],
        workspace,
      );

      expect(release.exitCode).toBe(0);
      expect(envelopes(release.stdout)).toEqual([
        expect.objectContaining({
          type: 'runbook_abandoned',
          runbookId: childId,
          parent: { standing: 'current', runId, step: '1.1' },
          abandonedInline: [],
        }),
      ]);
      const status = await runCliInProcess(['status', '--run', runId], workspace);
      expect(envelopes(status.stdout)[0]?.children).toEqual([
        { runId: childId, step: '1.1', status: 'abandoned', result: 'fail' },
      ]);
      const collect = await runCliInProcess(['collect', '--token', token], workspace);
      expect(envelopes(collect.stdout)[0]).toMatchObject({
        type: 'children_collected',
        children: [expect.objectContaining({ status: 'collected', result: 'fail' })],
      });
    });

    it('refuses another agent AGENT_MISMATCH and writes nothing', async () => {
      const { runId, childId } = await claimAs('agent-1');

      const release = await runCliInProcess(
        ['release', childId, '--agent-id', 'agent-2'],
        workspace,
      );

      expect(release.exitCode).toBe(1);
      expect(errorEnvelope(release.stdout)).toMatchObject({
        code: 'AGENT_MISMATCH',
        command: 'release',
      });
      const status = await runCliInProcess(['status', '--run', runId], workspace);
      expect(envelopes(status.stdout)[0]?.children).toEqual([
        { runId: childId, step: '1.1', status: 'running' },
      ]);
    });

    it('refuses a malformed id, an unknown run, a run that is not a delegation, and a second release', async () => {
      const { runId, childId } = await claimAs();

      const malformed = await runCliInProcess(['release', 'not-a-run'], workspace);
      expect(errorEnvelope(malformed.stdout)).toMatchObject({ code: 'INVALID_RUN_ID' });
      const unknown = await runCliInProcess(['release', `rd_${'0'.repeat(32)}`], workspace);
      expect(errorEnvelope(unknown.stdout)).toMatchObject({ code: 'RUN_TARGET_UNAVAILABLE' });
      const root = await runCliInProcess(['release', runId], workspace);
      expect(errorEnvelope(root.stdout)).toMatchObject({ code: 'NOT_A_DELEGATION' });

      expect((await runCliInProcess(['release', childId], workspace)).exitCode).toBe(0);
      const again = await runCliInProcess(['release', childId], workspace);
      expect(again.exitCode).toBe(1);
      expect(errorEnvelope(again.stdout)).toMatchObject({ code: 'RD-304' });
    });

    it('renders the release in --text', async () => {
      const { runId, childId } = await claimAs();
      const release = await runCliInProcess(['release', childId, '--text'], workspace);
      expect(release.exitCode).toBe(0);
      expect(release.stdout).toContain(
        `Run ${childId} abandoned; run ${runId} collects it at 1.1 as a fail`,
      );
    });

    it('says, in JSON and text, that a parent which retried the child never collects it', async () => {
      const { token, runId, childId } = await claimAs();
      const retried = await runCliInProcess(
        ['retry', '--token', token, '--step', '1.1'],
        workspace,
      );
      expect(retried.exitCode).toBe(0);

      const release = await runCliInProcess(['release', childId, '--text'], workspace);
      expect(release.exitCode).toBe(0);
      expect(release.stdout).toContain(
        `Run ${childId} abandoned; run ${runId} no longer counts it at 1.1, so nothing collects it`,
      );
      expect(release.stdout).not.toContain('as a fail');
    });

    it('reports the standing on the JSON event when the parent no longer counts the child', async () => {
      const { token, runId, childId } = await claimAs();
      await runCliInProcess(['retry', '--token', token, '--step', '1.1'], workspace);

      const release = await runCliInProcess(['release', childId], workspace);

      expect(envelopes(release.stdout)).toEqual([
        expect.objectContaining({
          type: 'runbook_abandoned',
          parent: { standing: 'cancelled', runId, step: '1.1' },
        }),
      ]);
    });

    it('reports a committed release even when the child is pruned before it is rendered', async () => {
      const { childId } = await claimAs();
      // Stands in for a concurrent `prune --inactive` deleting the finished
      // child after the release committed: any read of it now finds nothing.
      const load = jest
        .spyOn(RunbookStateManager.prototype, 'load')
        .mockImplementation(async () => null);
      try {
        const release = await runCliInProcess(['release', childId], workspace);

        expect(release.exitCode).toBe(0);
        expect(envelopes(release.stdout)).toEqual([
          expect.objectContaining({ type: 'runbook_abandoned', runbookId: childId }),
        ]);
      } finally {
        load.mockRestore();
      }
    });
  });

  describe('the agent id inside Claude Code, and duplicate --agent-id (#907)', () => {
    const insideClaudeCode = { env: { CLAUDECODE: '1' } };

    async function heldBy(agentId: string): Promise<unknown> {
      const held = await runCliInProcess(['status', '--claimed-by', agentId], workspace);
      return envelopes(held.stdout)[0]?.delegations;
    }

    it('refuses an unstamped claim inside Claude Code AGENT_ID_REQUIRED and writes nothing', async () => {
      const { runId, ticket } = await start();

      const claim = await runCliInProcess(['claim', ticket], workspace, insideClaudeCode);

      expect(claim.exitCode).toBe(1);
      expect(errorEnvelope(claim.stdout)).toMatchObject({
        code: 'AGENT_ID_REQUIRED',
        command: 'claim',
      });
      expect(claim.stdout).not.toContain(ticket);
      const status = await runCliInProcess(['status', '--run', runId], workspace);
      expect(envelopes(status.stdout)[0]?.children).toEqual([
        expect.objectContaining({ status: 'reserved' }),
      ]);
    });

    it('claims inside Claude Code under the --agent-id the plugin stamped', async () => {
      const { ticket } = await start();

      const claim = await runCliInProcess(
        ['claim', ticket, '--agent-id', 'sub-1'],
        workspace,
        insideClaudeCode,
      );

      expect(claim.exitCode).toBe(0);
      expect(await heldBy('sub-1')).toEqual([expect.objectContaining({ step: '1.1' })]);
    });

    it('refuses a second --agent-id INVALID_SYNTAX on claim and release, never last-wins', async () => {
      const { ticket } = await start();

      const claim = await runCliInProcess(
        ['claim', ticket, '--agent-id', 'sub-2', '--agent-id=sub-1'],
        workspace,
      );
      expect(claim.exitCode).toBe(1);
      expect(errorEnvelope(claim.stdout)).toMatchObject({
        code: 'INVALID_SYNTAX',
        command: 'claim',
      });
      expect(await heldBy('sub-1')).toEqual([]);

      const claimed = await runCliInProcess(['claim', ticket, '--agent-id', 'sub-1'], workspace);
      const childId = requireRunId(claimed.stdout);
      const release = await runCliInProcess(
        ['release', childId, '--agent-id', 'sub-2', '--agent-id=sub-1'],
        workspace,
      );
      expect(release.exitCode).toBe(1);
      expect(errorEnvelope(release.stdout)).toMatchObject({
        code: 'INVALID_SYNTAX',
        command: 'release',
      });
      expect(await heldBy('sub-1')).toEqual([expect.objectContaining({ runId: childId })]);
    });

    it('lets an unstamped release inside Claude Code end only a claim that recorded no agent', async () => {
      const { ticket } = await start();
      const claim = await runCliInProcess(['claim', ticket], workspace);
      const childId = requireRunId(claim.stdout);

      const release = await runCliInProcess(['release', childId], workspace, insideClaudeCode);

      expect(release.exitCode).toBe(0);
      expect(envelopes(release.stdout)).toEqual([
        expect.objectContaining({ type: 'runbook_abandoned', runbookId: childId }),
      ]);
    });
  });

  describe('rundown status --claimed-by (#907)', () => {
    async function claimAs(agentId: string) {
      const { token, runId, ticket } = await start();
      const claim = await runCliInProcess(['claim', ticket, '--agent-id', agentId], workspace);
      return { token, runId, childId: requireRunId(claim.stdout) };
    }

    it('lists the running children an agent claimed that the parent still counts', async () => {
      const { runId, childId } = await claimAs('agent-1');

      const held = await runCliInProcess(['status', '--claimed-by', 'agent-1'], workspace);

      expect(held.exitCode).toBe(0);
      expect(envelopes(held.stdout)).toEqual([
        {
          kind: 'claimed_delegations',
          agentId: 'agent-1',
          delegations: [
            { runId: childId, runbook: 'child.runbook.md', parentRunId: runId, step: '1.1' },
          ],
        },
      ]);
      expect(held.stdout).not.toMatch(/rd[ot]_/);
    });

    it('lists nothing for another agent, or once the agent released its child', async () => {
      const { childId } = await claimAs('agent-1');

      const other = await runCliInProcess(['status', '--claimed-by', 'agent-2'], workspace);
      expect(envelopes(other.stdout)[0]).toMatchObject({ delegations: [] });

      await runCliInProcess(['release', childId, '--agent-id', 'agent-1'], workspace);
      const after = await runCliInProcess(['status', '--claimed-by', 'agent-1'], workspace);
      expect(after.exitCode).toBe(0);
      expect(envelopes(after.stdout)[0]).toMatchObject({ delegations: [] });
    });

    it('refuses --claimed-by with --run, or empty, INVALID_SYNTAX', async () => {
      const { runId } = await claimAs('agent-1');

      const both = await runCliInProcess(
        ['status', '--run', runId, '--claimed-by', 'agent-1'],
        workspace,
      );
      expect(both.exitCode).toBe(1);
      expect(errorEnvelope(both.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });

      const empty = await runCliInProcess(['status', '--claimed-by', ''], workspace);
      expect(empty.exitCode).toBe(1);
      expect(errorEnvelope(empty.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });
    });

    it('renders the held children in --text', async () => {
      const { childId } = await claimAs('agent-1');

      const held = await runCliInProcess(
        ['status', '--claimed-by', 'agent-1', '--text'],
        workspace,
      );

      expect(held.exitCode).toBe(0);
      expect(held.stdout).toContain(childId);
      expect(held.stdout).toContain('1.1');
    });
  });
});
