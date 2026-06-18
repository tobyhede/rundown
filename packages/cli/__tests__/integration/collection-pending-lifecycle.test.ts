import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  getActiveState,
  injectDelegationOutcomeForActiveRun,
  injectDelegationOutcomeForFrame,
  parseConcatenatedJson,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { buildFrameKey } from '@rundown-org/core';

describe('collection-pending lifecycle', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('refuses bare pass while pending, then allows it after collect', async () => {
    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate child',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
          ],
        },
        { title: 'Promote', pass: 'COMPLETE' },
      ],
    });
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    // Mark the DELEGATE substep resolved alongside the reported outcome so the
    // later `rd collect` can aggregate it instead of refusing on unresolved
    // substeps.
    const completionKey = await injectDelegationOutcomeForActiveRun(workspace, {
      markDelegateSubstepDone: true,
    });

    // Onset: bare pass is refused while the reported outcome is uncollected.
    const blocked = await runCliInProcess('pass', workspace);
    expect(blocked.exitCode).toBe(1);
    const blockedPayload = JSON.parse(blocked.stdout) as {
      code?: string;
      details?: { outcomeCompletionKeys?: string[] };
    };
    expect(blockedPayload.code).toBe('DELEGATION_COLLECTION_PENDING');
    expect(blockedPayload.details?.outcomeCompletionKeys).toEqual([completionKey]);

    // Collect consumes the reported outcome.
    const collected = await runCliInProcess('collect', workspace);
    expect(collected.exitCode).toBe(0);

    // Release: the same bare pass now proceeds — the run is not wedged.
    const advanced = await runCliInProcess('pass', workspace);
    const advancedPayload = JSON.parse(advanced.stdout) as { code?: string };
    // A successful advance carries no error code at all — assert its absence
    // rather than merely that it is not the pending code, which also catches
    // any other failure code that might wedge the run.
    expect(advancedPayload.code).toBeUndefined();
    expect(advanced.exitCode).toBe(0);
  }, 30_000);

  describe('FOR-scoped frames', () => {
    const rangeFrame = (iteration: number) => ({
      stepId: '1',
      iteration,
      start: 1,
      end: 2,
      implicit: false,
      source: { kind: 'range' as const },
    });

    async function startForDelegateRun(): Promise<void> {
      const parentContent = createRunbook({
        title: 'FOR Parent',
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', start: 1, end: 2 },
            pass: 'CONTINUE',
            substeps: [
              { title: 'Handle item', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            ],
          },
          { title: 'Done', pass: 'COMPLETE' },
        ],
      });
      const childContent = createRunbook({
        title: 'Child',
        steps: [{ title: 'Work', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'for-parent.runbook.md'), parentContent);
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
      const start = await runCliInProcess(
        'run --prompted runbooks/for-parent.runbook.md',
        workspace,
      );
      expect(start.exitCode).toBe(0);
    }

    // A released bare pass on a FOR runbook emits multiple concatenated JSON
    // events; collect codes across all of them rather than parsing one object.
    function emittedCodes(stdout: string): (string | undefined)[] {
      return parseConcatenatedJson(stdout).map((o) => (o as { code?: string }).code);
    }

    it('refuses bare pass while an outcome is pending in the LIVE iteration frame, then allows it after collect', async () => {
      await startForDelegateRun();

      // The run enters the FOR loop at iteration 1, so the active frame is the
      // FOR-scoped frame `1|1` on the live stack — not the unscoped `1|`.
      const active = await getActiveState(workspace);
      expect(active?.activeFrameKey).toBe(buildFrameKey('1', 1));
      expect(active?.forStack?.length).toBeGreaterThan(0);

      const completionKey = await injectDelegationOutcomeForActiveRun(workspace, {
        markDelegateSubstepDone: true,
      });

      const blocked = await runCliInProcess('pass', workspace);
      expect(blocked.exitCode).toBe(1);
      const blockedPayload = JSON.parse(blocked.stdout) as {
        code?: string;
        details?: { outcomeCompletionKeys?: string[] };
      };
      expect(blockedPayload.code).toBe('DELEGATION_COLLECTION_PENDING');
      expect(blockedPayload.details?.outcomeCompletionKeys).toEqual([completionKey]);

      const collected = await runCliInProcess('collect', workspace);
      expect(collected.exitCode).toBe(0);

      // The bare pass now releases — the FOR-scoped outcome no longer wedges it.
      const advanced = await runCliInProcess('pass', workspace);
      expect(emittedCodes(advanced.stdout)).not.toContain('DELEGATION_COLLECTION_PENDING');
    }, 30_000);

    it('blocks for a LIVE frame but NOT once the loop has advanced past it (closed frame)', async () => {
      await startForDelegateRun();

      // A — outcome at frame `1|1`, with the loop still live at iteration 1.
      // forStack holds `1|1`, so the policy guard treats it as open and blocks.
      await injectDelegationOutcomeForFrame(workspace, {
        step: '1',
        iteration: 1,
        forStack: [rangeFrame(1)],
        activeFrameKey: buildFrameKey('1', 1),
      });
      const blockedWhileLive = await runCliInProcess('pass', workspace);
      expect(blockedWhileLive.exitCode).toBe(1);
      expect(emittedCodes(blockedWhileLive.stdout)).toContain('DELEGATION_COLLECTION_PENDING');

      // B — SAME outcome at `1|1`, but the loop has advanced to iteration 2.
      // `1|1` is gone from forStack (only retained in the monotonic counter), so
      // the guard must NOT treat it as pending. Only forStack differs from A.
      await injectDelegationOutcomeForFrame(workspace, {
        step: '1',
        iteration: 1,
        forStack: [rangeFrame(2)],
        activeFrameKey: buildFrameKey('1', 2),
        activeEntry: 2,
      });
      const afterAdvance = await runCliInProcess('pass', workspace);
      expect(emittedCodes(afterAdvance.stdout)).not.toContain('DELEGATION_COLLECTION_PENDING');
    }, 30_000);
  });
});
