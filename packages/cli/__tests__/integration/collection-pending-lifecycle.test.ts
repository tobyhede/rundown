import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  injectDelegationOutcomeForActiveRun,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
});
