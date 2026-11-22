/**
 * `rundown stop --run <id>`: the human escape hatch for a lost top-level
 * Owner Token (#906, ADR 0005).
 *
 * The one mutation a run id may drive. Refused without a human at an
 * interactive terminal; with one, it asks, and on an explicit yes stops the
 * named run and records who, when and why on it. The terminal is injected
 * (`HumanConfirmation`), so both paths run without a real TTY.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RunbookStateManager } from '@rundown-org/core';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { validateCommandOutput } from '../helpers/schema-validator.js';
import type { HumanConfirmation } from '../../src/services/human-confirmation.js';

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

/** A human at a terminal who answers every question `answer`, recording each. */
function humanAnswering(answer: boolean): HumanConfirmation & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    interactive: true,
    asked,
    confirm: (question: string) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  };
}

const DELEGATING_PARENT = [
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
  '',
  'Finish.',
  '',
].join('\n');

const CHILD = ['# Child', '', '## Check', '', '- PASS COMPLETE', '', 'Check.', ''].join('\n');

/** A runbook whose step 1.1 composes `runbook` inline. */
function composing(title: string, runbook: string): string {
  return [
    `# ${title}`,
    '',
    '## 1. Compose',
    '',
    '- PASS ALL CONTINUE',
    '- FAIL ANY STOP',
    '',
    '### 1.1 Run it',
    '',
    `- ${runbook}`,
    '',
    '## 2. After',
    '',
    '- PASS COMPLETE',
    '',
    'Finish.',
    '',
  ].join('\n');
}

describe('rundown stop --run: the human escape hatch (#906)', () => {
  let workspace: TestWorkspace;
  let runId: string;
  let token: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    const start = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    runId = requireRunId(start.stdout);
    token = requireOwnerToken(start.stdout);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function lifecycle(id: string = runId): Promise<string | undefined> {
    return (await readRunbookState(workspace, id))?.lifecycle;
  }

  it('is refused INTERACTIVE_REQUIRED without a human at a terminal, and stops nothing', async () => {
    const result = await runCliInProcess(['stop', '--run', runId], workspace);

    expect(result.exitCode).toBe(1);
    const envelope = errorEnvelope(result.stdout);
    expect(envelope).toMatchObject({
      code: 'INTERACTIVE_REQUIRED',
      command: 'stop',
      details: { runId },
    });
    // The refusal tells an agent what to do instead.
    expect(String(envelope?.error)).toContain('An agent must not use it');
    expect(String(envelope?.error)).toContain('--token');
    expect(await lifecycle()).toBe('running');
    expect((await readRunbookState(workspace, runId))?.humanStop).toBeUndefined();
  });

  it('is refused under --non-interactive even with a human, who is never asked', async () => {
    const human = humanAnswering(true);

    const result = await runCliInProcess(['--non-interactive', 'stop', '--run', runId], workspace, {
      human,
    });

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({ code: 'INTERACTIVE_REQUIRED' });
    expect(human.asked).toEqual([]);
    expect(await lifecycle()).toBe('running');
  });

  it('is not unlocked by --yes', async () => {
    const result = await runCliInProcess(['--yes', 'stop', '--run', runId], workspace);

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({ code: 'INTERACTIVE_REQUIRED' });
    expect(await lifecycle()).toBe('running');
  });

  it('stops the run on an explicit yes and records who, when and why on it', async () => {
    const human = humanAnswering(true);
    const before = new Date().toISOString();

    const result = await runCliInProcess(
      ['stop', 'Lost the owner token', '--run', runId],
      workspace,
      { human },
    );

    // A stop exits non-zero, as `stop --token` does.
    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toBeUndefined();
    expect(envelopes(result.stdout).at(-1)).toMatchObject({ action: 'stop' });
    expect(human.asked).toEqual([expect.stringContaining(runId)]);
    const state = await readRunbookState(workspace, runId);
    expect(state?.lifecycle).toBe('stopped');
    expect(state?.humanStop).toEqual({
      at: expect.any(String),
      user: expect.any(String),
      host: hostname(),
      message: 'Lost the owner token',
    });
    expect(String(state?.humanStop?.at) >= before).toBe(true);
    // The token still resolves, and is told the run finished.
    const late = await runCliInProcess(['pass', '--token', token, '--step', '1'], workspace);
    expect(errorEnvelope(late.stdout)).toMatchObject({ code: 'RD-304' });
  });

  it('shows the audit on status --run', async () => {
    await runCliInProcess(['stop', 'gone', '--run', runId], workspace, {
      human: humanAnswering(true),
    });

    const json = await runCliInProcess(['status', '--run', runId], workspace);
    const [detail] = envelopes(json.stdout);
    expect(validateCommandOutput('status', detail)).toEqual({ valid: true, errors: [] });
    expect(detail).toMatchObject({
      status: 'stopped',
      humanStop: { host: hostname(), message: 'gone' },
    });

    const text = await runCliInProcess(['status', '--run', runId, '--text'], workspace);
    expect(text.stdout).toContain('without the owner token: gone');
  });

  it('records no message when the human gives none', async () => {
    await runCliInProcess(['stop', '--run', runId], workspace, { human: humanAnswering(true) });

    const audit = (await readRunbookState(workspace, runId))?.humanStop;
    expect(audit).toBeDefined();
    expect(audit).not.toHaveProperty('message');
  });

  it('is refused NOT_CONFIRMED when the human declines, writing nothing', async () => {
    const result = await runCliInProcess(['stop', '--run', runId], workspace, {
      human: humanAnswering(false),
    });

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({
      code: 'NOT_CONFIRMED',
      details: { runId },
    });
    expect(await lifecycle()).toBe('running');
    expect((await readRunbookState(workspace, runId))?.humanStop).toBeUndefined();
  });

  it('keeps --run with --token INVALID_SYNTAX, asking nobody', async () => {
    const human = humanAnswering(true);

    const result = await runCliInProcess(['stop', '--run', runId, '--token', token], workspace, {
      human,
    });

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({ code: 'INVALID_SYNTAX' });
    expect(human.asked).toEqual([]);
    expect(await lifecycle()).toBe('running');
  });

  it('refuses a malformed id INVALID_RUN_ID and an unknown one RUN_TARGET_UNAVAILABLE, asking nobody', async () => {
    const human = humanAnswering(true);

    const malformed = await runCliInProcess(['stop', '--run', 'nope'], workspace, { human });
    expect(malformed.exitCode).toBe(1);
    expect(errorEnvelope(malformed.stdout)).toMatchObject({ code: 'INVALID_RUN_ID' });

    const unknown = await runCliInProcess(['stop', '--run', `rd_${'0'.repeat(32)}`], workspace, {
      human,
    });
    expect(unknown.exitCode).toBe(1);
    expect(errorEnvelope(unknown.stdout)).toMatchObject({ code: 'RUN_TARGET_UNAVAILABLE' });
    expect(human.asked).toEqual([]);
  });

  it('refuses a finished run RD-304, asking nobody', async () => {
    expect((await runCliInProcess(['stop', '--token', token], workspace)).exitCode).toBe(1);
    const human = humanAnswering(true);

    const result = await runCliInProcess(['stop', '--run', runId], workspace, { human });

    expect(result.exitCode).toBe(1);
    expect(errorEnvelope(result.stdout)).toMatchObject({ code: 'RD-304' });
    expect(human.asked).toEqual([]);
  });

  it('refuses a Delegation NOT_A_TOP_LEVEL_RUN, naming its own recovery', async () => {
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), DELEGATING_PARENT);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
    const parent = await runCliInProcess('run parent.runbook.md', workspace);
    const entered = envelopes(parent.stdout).filter((event) => event.type === 'step_entered');
    const [reserved] = (entered.at(-1)?.children ?? []) as (Envelope | undefined)[];
    const claim = await runCliInProcess(['claim', String(reserved?.ticket)], workspace);
    const childId = requireRunId(claim.stdout);
    const human = humanAnswering(true);

    const result = await runCliInProcess(['stop', '--run', childId], workspace, { human });

    expect(result.exitCode).toBe(1);
    const envelope = errorEnvelope(result.stdout);
    expect(envelope).toMatchObject({ code: 'NOT_A_TOP_LEVEL_RUN', details: { runId: childId } });
    expect(String(envelope?.error)).toContain('rundown release');
    expect(human.asked).toEqual([]);
    expect(await lifecycle(childId)).toBe('running');
  });

  describe('a root composing inline children', () => {
    let rootId: string;
    let middleId: string;
    let leafId: string;

    /** Run root -> middle -> leaf, each an Inline Child of the one above. */
    beforeEach(async () => {
      await writeFile(
        join(workspace.cwd, 'root.runbook.md'),
        composing('Root', 'middle.runbook.md'),
      );
      await writeFile(
        join(workspace.cwd, 'middle.runbook.md'),
        composing('Middle', 'child.runbook.md'),
      );
      await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
      const root = await runCliInProcess('run root.runbook.md', workspace);
      expect(root.exitCode).toBe(0);
      rootId = requireRunId(root.stdout);
      const manager = new RunbookStateManager(workspace.cwd);
      const listed = await manager.listWithVersion();
      const childOf = (parentId: string | undefined) =>
        listed.find(
          (run) => run.linkage?.kind === 'inline' && run.linkage.parentRunId === parentId,
        );
      const middle = childOf(rootId);
      const leaf = childOf(middle?.state.id);
      if (middle === undefined || leaf === undefined) throw new Error('inline chain not launched');
      middleId = middle.state.id;
      leafId = leaf.state.id;
    });

    /** Lease a run as a live command step would: In Progress. */
    async function leaseLive(id: string): Promise<void> {
      const manager = new RunbookStateManager(workspace.cwd);
      const read = await manager.loadWithVersion(id);
      if (!read) throw new Error('run missing');
      const acquired = await manager.acquireExecutionLease(read.state.id, read.stateVersion, {
        pid: process.ppid,
        startId: null,
      });
      if (acquired.kind !== 'acquired') throw new Error(`lease not set: ${acquired.kind}`);
    }

    it('stops the root and its running inline children together, listing them', async () => {
      const human = humanAnswering(true);

      const result = await runCliInProcess(['stop', 'gone', '--run', rootId], workspace, { human });

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)).toBeUndefined();
      const action = envelopes(result.stdout).at(-1);
      expect(validateCommandOutput('stop', action)).toEqual({ valid: true, errors: [] });
      expect(action).toMatchObject({
        action: 'stop',
        runId: rootId,
        stoppedInline: [middleId, leafId],
      });
      expect(await lifecycle(rootId)).toBe('stopped');
      expect(await lifecycle(middleId)).toBe('stopped');
      expect(await lifecycle(leafId)).toBe('stopped');
      // The audit is the root's; the children were stopped by the same write.
      expect((await readRunbookState(workspace, rootId))?.humanStop).toMatchObject({
        message: 'gone',
      });
      expect((await readRunbookState(workspace, leafId))?.humanStop).toBeUndefined();
    });

    it('names the stopped inline children in text output', async () => {
      const result = await runCliInProcess(['stop', '--run', rootId, '--text'], workspace, {
        human: humanAnswering(true),
      });

      expect(result.stdout).toContain(`Inline:   ${middleId}`);
      expect(result.stdout).toContain(`Inline:   ${leafId}`);
    });

    it('is refused EXECUTION_IN_PROGRESS before anyone is asked when an inline child is mid-command, stopping nothing', async () => {
      await leaseLive(leafId);
      const human = humanAnswering(true);

      const result = await runCliInProcess(['stop', '--run', rootId], workspace, { human });

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)).toMatchObject({
        code: 'EXECUTION_IN_PROGRESS',
        details: { runId: leafId },
      });
      expect(human.asked).toEqual([]);
      expect(await lifecycle(rootId)).toBe('running');
      expect(await lifecycle(leafId)).toBe('running');
    });

    it('is refused EXECUTION_IN_PROGRESS before anyone is asked when the root is mid-command', async () => {
      await leaseLive(rootId);
      const human = humanAnswering(true);

      const result = await runCliInProcess(['stop', '--run', rootId], workspace, { human });

      expect(result.exitCode).toBe(1);
      expect(errorEnvelope(result.stdout)).toMatchObject({
        code: 'EXECUTION_IN_PROGRESS',
        details: { runId: rootId },
      });
      expect(human.asked).toEqual([]);
      expect(await lifecycle(rootId)).toBe('running');
    });

    it('refuses a nested inline child NOT_A_TOP_LEVEL_RUN, naming the root to stop, not its parent', async () => {
      const human = humanAnswering(true);

      const result = await runCliInProcess(['stop', '--run', leafId], workspace, { human });

      expect(result.exitCode).toBe(1);
      const envelope = errorEnvelope(result.stdout);
      expect(envelope).toMatchObject({ code: 'NOT_A_TOP_LEVEL_RUN' });
      expect(String(envelope?.error)).toContain(`rundown stop --run ${rootId}`);
      expect(String(envelope?.error)).not.toContain(middleId);
      expect(human.asked).toEqual([]);
    });
  });

  it('refuses an orphaned Delegation NOT_A_TOP_LEVEL_RUN, naming only recoveries that can reach it', async () => {
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), DELEGATING_PARENT);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
    const parent = await runCliInProcess('run parent.runbook.md', workspace);
    const entered = envelopes(parent.stdout).filter((event) => event.type === 'step_entered');
    const [reserved] = (entered.at(-1)?.children ?? []) as (Envelope | undefined)[];
    const claim = await runCliInProcess(['claim', String(reserved?.ticket)], workspace);
    const childId = requireRunId(claim.stdout);
    const pruned = await runCliInProcess(
      ['prune', '--token', requireOwnerToken(parent.stdout)],
      workspace,
    );
    expect(pruned.exitCode).toBe(0);
    const human = humanAnswering(true);

    const result = await runCliInProcess(['stop', '--run', childId], workspace, { human });

    expect(result.exitCode).toBe(1);
    const envelope = errorEnvelope(result.stdout);
    expect(envelope).toMatchObject({ code: 'NOT_A_TOP_LEVEL_RUN', details: { runId: childId } });
    // Its parent was pruned: nobody can `retry` it.
    expect(String(envelope?.error)).not.toContain('retry');
    expect(String(envelope?.error)).toContain(`rundown release ${childId}`);
    expect(String(envelope?.error)).toContain('rundown stop --token');
    expect(human.asked).toEqual([]);
  });
});
