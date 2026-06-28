import { describe, it, expect } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  getActiveState,
  findActionOutput,
  parseCliJsonObject,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ErrorResponseSchema } from '@rundown-org/core';

/** Read the raw `handoffPending` marker from the session file. */
async function handoffMarker(ws: TestWorkspace): Promise<unknown> {
  const raw = JSON.parse(await readFile(ws.sessionPath(), 'utf-8')) as Record<string, unknown>;
  return raw.handoffPending;
}

/**
 * Build a two-stage parent (step 1: single delegate substep that advances on
 * pass OR fail; step 2: normal) with a claimed leaf child. The parent is
 * default-active and the leaf is claimed but still open. Returns the claim id so
 * the caller can close it with `pass`/`fail --claim-id` and assert the barrier.
 */
async function setupClaimedChildPipeline(): Promise<{ workspace: TestWorkspace; claimId: string }> {
  const workspace = await createTestWorkspace();

  const parent = createRunbook({
    title: 'Parent',
    steps: [
      {
        title: 'Review',
        pass: 'CONTINUE',
        fail: 'CONTINUE',
        substeps: [
          {
            title: 'Code review',
            delegate: true,
            content: 'Do code review.',
            runbooks: ['child.runbook.md'],
          },
        ],
      },
      { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
    ],
  });
  await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);

  const child = createRunbook({
    title: 'Child',
    steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run the child task.' }],
  });
  await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

  expect(runCli('run --prompted parent.runbook.md --text', workspace).exitCode).toBe(0);

  const state = await getActiveState(workspace);
  const token = state?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
  expect(token).toEqual(expect.stringMatching(/^rdtk_/));

  const claimResult = runCli(`claim ${token}`, workspace);
  expect(claimResult.exitCode).toBe(0);
  const claimAction = findActionOutput(claimResult.stdout);
  expect(claimAction).not.toBeNull();
  const claimId = String(claimAction!.claim_id);
  expect(claimId).toMatch(/^rdclm_/);

  return { workspace, claimId };
}

describe('claim hand-off barrier (#460)', () => {
  it('stamps handoffPending after a claim-targeted PASS closes the child', async () => {
    const { workspace, claimId } = await setupClaimedChildPipeline();
    expect(runCli(['pass', '--claim-id', claimId], workspace).exitCode).toBe(0);
    expect(await handoffMarker(workspace)).toEqual(
      expect.objectContaining({ fromClaimId: claimId }),
    );
    await workspace.cleanup();
  }, 30000);

  it('stamps handoffPending after a claim-targeted FAIL closes the child', async () => {
    const { workspace, claimId } = await setupClaimedChildPipeline();
    runCli(['fail', '--claim-id', claimId], workspace);
    expect(await handoffMarker(workspace)).toEqual(
      expect.objectContaining({ fromClaimId: claimId }),
    );
    await workspace.cleanup();
  }, 30000);
});
