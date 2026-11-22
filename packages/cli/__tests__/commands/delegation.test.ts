/**
 * `rundown claim` and `rundown collect` through the in-process CLI (#904).
 *
 * The scenario fixtures under `runbooks/delegation/` pin the protocol end to
 * end; this file pins what only the command surface shows: refusal envelopes
 * and exit codes, what the JSON events carry (and never carry), and the text
 * rendering. Status must never show a Claim Ticket.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
});
