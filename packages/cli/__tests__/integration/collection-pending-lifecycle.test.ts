import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  activeFrame,
  buildCompletionKey,
  buildFrameKey,
  buildResolvedCompletion,
} from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
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

  async function injectDelegationOutcomeForActiveRun(): Promise<string> {
    const state = await getActiveState(workspace);
    if (!state) throw new Error('Expected active state');
    const frameKey = state.activeFrameKey ?? buildFrameKey(state.step);
    const entry = state.activeEntry ?? 1;
    const completionKey = buildCompletionKey(activeFrame(frameKey, entry), '1');
    // Mark the DELEGATE substep `done` (preserving its auto-issued delegation)
    // so `rd collect` can aggregate the reported outcome — without this the
    // collect would refuse with SUBSTEPS_NOT_RESOLVED. The reported outcome row
    // itself uses agentId `delegation`, which is what the collection-pending
    // policy read model keys on.
    const priorSubsteps = state.substepStates ?? [];
    const priorSubstep = priorSubsteps.find((ss) => ss.id === '1' && ss.frameKey === frameKey);
    const substepStates = [
      ...priorSubsteps.filter((ss) => !(ss.id === '1' && ss.frameKey === frameKey)),
      {
        id: '1',
        frameKey,
        status: 'done' as const,
        result: 'pass' as const,
        ...(priorSubstep?.delegation !== undefined ? { delegation: priorSubstep.delegation } : {}),
      },
    ];
    await writeFile(
      join(workspace.statePath(), `${state.id}.json`),
      JSON.stringify(
        {
          ...state,
          substep: state.substep ?? '1',
          activeFrameKey: frameKey,
          activeEntry: entry,
          frameEntries: { ...(state.frameEntries ?? {}), [frameKey]: entry },
          substepStates,
          resolvedCompletions: {
            ...(state.resolvedCompletions ?? {}),
            [completionKey]: buildResolvedCompletion({
              agentId: 'delegation',
              result: 'pass',
              targetStep: state.step,
              targetSubstep: '1',
              targetFrame: activeFrame(frameKey, entry),
              completedAt: '2026-01-01T00:00:00.000Z',
            }),
          },
        },
        null,
        2,
      ),
    );
    return completionKey;
  }

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

    const completionKey = await injectDelegationOutcomeForActiveRun();

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
    expect(advancedPayload.code).not.toBe('DELEGATION_COLLECTION_PENDING');
    expect(advanced.exitCode).toBe(0);
  }, 30_000);
});
