/**
 * Prune protection for a Current Child's result (#906, ADR 0005).
 *
 * A Current Child — a Delegation or an Inline Child its running parent still
 * counts — is protected from pruning until the parent durably Collects it,
 * Cancellation makes it unnecessary, the parent reaches a terminal, or the
 * parent is pruned. Bulk prune, `--all` included, reports each protected
 * child retained with its reason; ending protection makes the child eligible
 * for an ordinary prune and deletes nothing by itself.
 *
 * Driven through the in-process CLI with real runbooks, so the reservations,
 * claims and Collects are the ones the machine records.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookStateManager } from '@rundown-org/core';
import { patchPersistedRunState } from '@rundown-org/core/testing/run-fixtures';
import {
  createTestWorkspace,
  parseConcatenatedJson,
  requireOwnerToken,
  requireRunId,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { validateCommandOutput } from '../helpers/schema-validator.js';
import type { HumanConfirmation } from '../../src/services/human-confirmation.js';

/** A human at a terminal who answers every question yes, recording each. */
function humanSayingYes(): HumanConfirmation & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    interactive: true,
    asked,
    confirm: (question: string) => {
      asked.push(question);
      return Promise.resolve(true);
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
  '- FAIL STOP',
  '',
  'Finish.',
  '',
].join('\n');

const INLINE_PARENT = [
  '# Inline parent',
  '',
  '## 1. Review',
  '',
  '- PASS ALL CONTINUE',
  '- FAIL ANY STOP',
  '',
  '### 1.1 Check it',
  '',
  '- child.runbook.md',
  '',
  '## 2. Middle',
  '',
  '- PASS CONTINUE',
  '- FAIL STOP',
  '',
  'Middle.',
  '',
  '## 3. After',
  '',
  '- PASS COMPLETE',
  '- FAIL STOP',
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

/** The Claim Ticket the last `step_entered` of `stdout` lists. */
function ticketOf(stdout: string): string {
  const entered = envelopes(stdout).filter((event) => event.type === 'step_entered');
  const [child] = (entered.at(-1)?.children ?? []) as (Envelope | undefined)[];
  return String(child?.ticket);
}

/** Parse a prune's JSON rows, checking them against the documented schema. */
function pruneRows(stdout: string): Envelope[] {
  const rows = JSON.parse(stdout) as Envelope[];
  expect(validateCommandOutput('prune', rows)).toEqual({ valid: true, errors: [] });
  return rows;
}

describe('prune protects a Current Child until its parent is done with it (#906)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), DELEGATING_PARENT);
    await writeFile(join(workspace.cwd, 'inline-parent.runbook.md'), INLINE_PARENT);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), CHILD);
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function storedIds(): Promise<string[]> {
    return [...(await new RunbookStateManager(workspace.cwd).listRunIds())].sort();
  }

  /** Start the delegating parent, claim its child and finish the child. */
  async function finishedDelegation(): Promise<{
    token: string;
    parentId: string;
    ticket: string;
    childId: string;
    childToken: string;
  }> {
    const run = await runCliInProcess('run parent.runbook.md', workspace);
    expect(run.exitCode).toBe(0);
    const ticket = ticketOf(run.stdout);
    const claim = await runCliInProcess(['claim', ticket], workspace);
    expect(claim.exitCode).toBe(0);
    const childToken = requireOwnerToken(claim.stdout);
    const childId = requireRunId(claim.stdout);
    const passed = await runCliInProcess(
      ['pass', '--token', childToken, '--step', 'Check'],
      workspace,
    );
    expect(passed.exitCode).toBe(0);
    return {
      token: requireOwnerToken(run.stdout),
      parentId: requireRunId(run.stdout),
      ticket,
      childId,
      childToken,
    };
  }

  describe('a Delegation', () => {
    it('retains a terminal, uncollected child under prune --all, so its ticket cannot be claimed again', async () => {
      const { parentId, ticket, childId } = await finishedDelegation();

      const pruned = await runCliInProcess('prune --all', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: childId, status: 'complete', retained: 'uncollected' }),
          expect.objectContaining({ id: parentId, retained: 'token required' }),
        ]),
      );
      expect(await storedIds()).toEqual([parentId, childId].sort());
      // The hazard #904 left open: pruning the child freed its reserved id, so
      // the same ticket claimed a second child.
      const again = await runCliInProcess(['claim', ticket], workspace);
      expect(again.exitCode).toBe(1);
      expect(errorEnvelope(again.stdout)).toMatchObject({ code: 'ALREADY_CLAIMED' });
    });

    it('retains it under the default prune and --completed alike', async () => {
      const { childId } = await finishedDelegation();

      for (const command of ['prune', 'prune --completed']) {
        const pruned = await runCliInProcess(command, workspace);
        expect(pruned.exitCode).toBe(0);
        expect(pruneRows(pruned.stdout)).toEqual([
          expect.objectContaining({ id: childId, retained: 'uncollected' }),
        ]);
      }
      expect(await storedIds()).toContain(childId);
    });

    it('refuses prune --token naming the uncollected child CURRENT_CHILD_PROTECTED, deleting nothing', async () => {
      const { parentId, childId, childToken } = await finishedDelegation();

      const pruned = await runCliInProcess(['prune', '--token', childToken], workspace);

      expect(pruned.exitCode).toBe(1);
      expect(errorEnvelope(pruned.stdout)).toMatchObject({
        code: 'CURRENT_CHILD_PROTECTED',
        details: { runId: childId, parentRunId: parentId },
      });
      expect(await storedIds()).toEqual([parentId, childId].sort());
    });

    it('makes the child eligible once the parent collects it, without deleting it', async () => {
      const { token, parentId, childId } = await finishedDelegation();
      expect((await runCliInProcess(['collect', '--token', token], workspace)).exitCode).toBe(0);
      expect(await storedIds()).toEqual([parentId, childId].sort());

      const pruned = await runCliInProcess('prune', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual([
        expect.objectContaining({ id: childId, status: 'complete' }),
      ]);
      expect(pruneRows(pruned.stdout)[0]).not.toHaveProperty('retained');
      expect(await storedIds()).toEqual([parentId]);
    });

    it('makes the child eligible once retry cancels it', async () => {
      const { token, parentId, childId } = await finishedDelegation();
      const retried = await runCliInProcess(
        ['retry', '--token', token, '--step', '1.1'],
        workspace,
      );
      expect(retried.exitCode).toBe(0);

      const pruned = await runCliInProcess('prune', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual([expect.objectContaining({ id: childId })]);
      expect(await storedIds()).toEqual([parentId]);
    });

    it('makes the child eligible once the parent reaches a terminal', async () => {
      const { token, parentId, childId } = await finishedDelegation();
      expect((await runCliInProcess(['stop', '--token', token], workspace)).exitCode).toBe(1);

      const pruned = await runCliInProcess('prune', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(
        pruneRows(pruned.stdout)
          .map((row) => row.id)
          .sort(),
      ).toEqual([parentId, childId].sort());
      expect(await storedIds()).toEqual([]);
    });

    it('makes the child eligible once the parent is pruned', async () => {
      const { token, parentId, childId } = await finishedDelegation();
      expect((await runCliInProcess(['prune', '--token', token], workspace)).exitCode).toBe(0);
      expect(await storedIds()).toEqual([childId]);

      const pruned = await runCliInProcess('prune', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual([expect.objectContaining({ id: childId })]);
      expect(await storedIds()).toEqual([]);
      expect(parentId).not.toBe(childId);
    });

    it('deletes a finished child the selection picks with the parent its token prunes, never reporting it uncollected', async () => {
      const { token, parentId, childId } = await finishedDelegation();

      const pruned = await runCliInProcess(['prune', '--completed', '--token', token], workspace);

      expect(pruned.exitCode).toBe(0);
      const rows = pruneRows(pruned.stdout);
      expect(rows.map((row) => row.id)).toEqual([parentId, childId]);
      expect(rows.some((row) => 'retained' in row)).toBe(false);
      expect(await storedIds()).toEqual([]);
    });

    it('never deletes a running child with the parent a human confirmed: it is kept as a child run', async () => {
      const run = await runCliInProcess('run parent.runbook.md', workspace);
      const parentId = requireRunId(run.stdout);
      const claim = await runCliInProcess(['claim', ticketOf(run.stdout)], workspace);
      const childId = requireRunId(claim.stdout);
      const human = humanSayingYes();

      const pruned = await runCliInProcess('prune --all', workspace, { human });

      expect(pruned.exitCode).toBe(0);
      expect(human.asked).toEqual([expect.stringContaining(parentId)]);
      const rows = pruneRows(pruned.stdout);
      expect(rows).toEqual([
        expect.objectContaining({ id: parentId, confirmedBy: expect.any(Object) }),
        expect.objectContaining({
          id: childId,
          retained: 'child run',
          detail: expect.stringContaining(`rundown release ${childId}`),
        }),
      ]);
      expect(await storedIds()).toEqual([childId]);
    });

    it('never offers a running child no parent counts for confirmation: it is kept as a child run', async () => {
      const run = await runCliInProcess('run parent.runbook.md', workspace);
      const claim = await runCliInProcess(['claim', ticketOf(run.stdout)], workspace);
      const childId = requireRunId(claim.stdout);
      const stopped = await runCliInProcess(
        ['stop', '--token', requireOwnerToken(run.stdout)],
        workspace,
      );
      expect(stopped.exitCode).toBe(1);
      const human = humanSayingYes();

      const pruned = await runCliInProcess('prune --active', workspace, { human });

      expect(pruned.exitCode).toBe(0);
      expect(human.asked).toEqual([]);
      expect(pruneRows(pruned.stdout)).toEqual([
        expect.objectContaining({ id: childId, retained: 'child run' }),
      ]);
      expect(await storedIds()).toContain(childId);
    });

    it('never deletes a running Current Child, even under its own token', async () => {
      const run = await runCliInProcess('run parent.runbook.md', workspace);
      const claim = await runCliInProcess(['claim', ticketOf(run.stdout)], workspace);
      const childToken = requireOwnerToken(claim.stdout);
      const childId = requireRunId(claim.stdout);

      const pruned = await runCliInProcess(['prune', '--token', childToken], workspace);

      expect(pruned.exitCode).toBe(1);
      expect(errorEnvelope(pruned.stdout)).toMatchObject({
        code: 'CURRENT_CHILD_PROTECTED',
        details: { runId: childId },
      });
      expect(await storedIds()).toContain(childId);
    });
  });

  describe('an Inline Child', () => {
    /**
     * Start the inline parent, whose child waits at `Check`, then end the
     * child as a command that died before the implicit Collect would leave it.
     */
    async function uncollectedInlineChild(): Promise<{
      token: string;
      parentId: string;
      childId: string;
    }> {
      const run = await runCliInProcess('run inline-parent.runbook.md', workspace);
      expect(run.exitCode).toBe(0);
      const parentId = requireRunId(run.stdout);
      const childId = (await storedIds()).find((id) => id !== parentId);
      if (childId === undefined) throw new Error('inline child was not launched');
      await patchPersistedRunState(workspace.cwd, childId, { lifecycle: 'completed' });
      return { token: requireOwnerToken(run.stdout), parentId, childId };
    }

    it('retains a terminal child its running parent has not collected under prune --all', async () => {
      const { parentId, childId } = await uncollectedInlineChild();

      const pruned = await runCliInProcess('prune --all', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: childId, status: 'complete', retained: 'uncollected' }),
          expect.objectContaining({ id: parentId, retained: 'token required' }),
        ]),
      );
      expect(await storedIds()).toEqual([parentId, childId].sort());
    });

    it('makes the child eligible once the parent collects it, while the parent still runs', async () => {
      const { token, parentId, childId } = await uncollectedInlineChild();
      // The parent's next command Collects the child first, then passes step 2.
      const passed = await runCliInProcess(['pass', '--token', token, '--step', '2'], workspace);
      expect(passed.exitCode).toBe(0);

      const pruned = await runCliInProcess('prune', workspace);

      expect(pruned.exitCode).toBe(0);
      expect(pruneRows(pruned.stdout)).toEqual([
        expect.objectContaining({ id: childId, status: 'complete' }),
      ]);
      expect(await storedIds()).toEqual([parentId]);
    });
  });
});
