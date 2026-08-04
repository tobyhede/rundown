/**
 * `rundown delegate --retry` idempotency over an unobserved replacement (#681).
 *
 * These exercise the contract end to end through the CLI's JSON default path:
 * a replayed retry echoes rather than rotating, committed evidence that the
 * replacement's bearer was used refuses instead, and a frame re-entry rotates
 * because the echo would otherwise hand back a bearer the claim path has
 * already closed.
 */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  getActiveState,
  parseCliJsonObject,
  requireEmittedRunClaim,
  requireLatestFrontierToken,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('retry idempotency', () => {
  let workspace: TestWorkspace;
  let claimId: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Stand up a parent parked on a DELEGATE substep `1.1`, with the auto-issued
   * frontier bearer aborted so `--retry` starts from a clean single delegation.
   *
   * @returns The bearer currently recorded at `1.1`.
   */
  async function setup(): Promise<string> {
    const childContent = createRunbook({
      steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Main step',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Substep A', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
            { title: 'Substep B', content: 'Second substep.' },
          ],
        },
        { title: 'Complete', pass: 'COMPLETE', command: 'rd echo --result pass' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const started = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    if (started.exitCode !== 0) {
      throw new Error(`setup run failed:\n${started.stdout}\n${started.stderr}`);
    }
    const state = await getActiveState(workspace);
    if (!state) throw new Error('expected an active run');
    claimId = requireEmittedRunClaim(workspace, state.id);
    return requireLatestFrontierToken(workspace, '1.1');
  }

  /** Run `rundown delegate` and require exit 0, returning the parsed response. */
  async function delegateJson(args: readonly string[]): Promise<Record<string, unknown>> {
    const result = await runCliInProcess(['delegate', ...args, '--claim-id', claimId], workspace);
    if (result.exitCode !== 0) {
      throw new Error(`delegate ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
    }
    return parseCliJsonObject(result.stdout);
  }

  it('a replayed retry echoes the surviving replacement instead of rotating again', async () => {
    const t1 = await setup();
    const rotated = await delegateJson(['--retry', '--step', '1.1']);
    expect(rotated.action).toBe('retried');
    expect(rotated.token).not.toBe(t1);

    const replayed = await delegateJson(['--retry', '--step', '1.1']);
    expect(replayed).toMatchObject({
      action: 'retry-already-applied',
      token: rotated.token,
    });
  });

  it('the echo writes no persisted state', async () => {
    await setup();
    await delegateJson(['--retry', '--step', '1.1']);
    const before = await getActiveState(workspace);

    await delegateJson(['--retry', '--step', '1.1']);

    expect(await getActiveState(workspace)).toEqual(before);
  });

  it('locates a run by a superseded token so the replay can be judged', async () => {
    // `findByToken` misses T1 once it has been rotated away; the supersession
    // index is what lets the replay resolve to its replacement at all.
    const t1 = await setup();
    const rotated = await delegateJson(['--retry', '--step', '1.1']);

    const replayed = await delegateJson(['--retry', t1]);
    expect(replayed).toMatchObject({
      action: 'retry-already-applied',
      token: rotated.token,
    });
  });

  it('retry-of-a-retry chains rotate once per named bearer', async () => {
    const t1 = await setup();
    const t2 = await delegateJson(['--retry', '--step', '1.1']);
    const echo2 = await delegateJson(['--retry', '--step', '1.1']);
    expect(echo2).toMatchObject({ action: 'retry-already-applied', token: t2.token });

    const t3 = await delegateJson(['--retry', String(t2.token)]);
    expect(t3.action).toBe('retried');
    expect(new Set([t1, t2.token, t3.token]).size).toBe(3);

    const echo3 = await delegateJson(['--retry', '--step', '1.1']);
    expect(echo3).toMatchObject({ action: 'retry-already-applied', token: t3.token });
  });

  it('frame re-entry with a surviving replacement rotates rather than echoing', async () => {
    // The fourth conjunct at work. The replacement survives the re-entry, but
    // its parentEntry no longer names the frame's current entry, so echoing it
    // would hand back a bearer `classifyDelegationLiveness` has already closed
    // as cursor-advanced — an unclaimable token, strictly worse than rotating.
    await setup();
    const t2 = await delegateJson(['--retry', '--step', '1.1']);

    const beforeEntry = (await getActiveState(workspace))?.activeEntry;

    // Navigate away and back. A GOTO to the substep the cursor already sits on
    // is a no-op — nothing is re-entered, so nothing should move — which is why
    // this leaves and returns rather than targeting 1.1 twice.
    for (const target of ['1.2', '1.1']) {
      const moved = await runCliInProcess(['goto', target, '--claim-id', claimId], workspace);
      expect(moved.exitCode).toBe(0);
    }
    const reentered = await getActiveState(workspace);
    expect(reentered?.activeEntry).toBeGreaterThan(beforeEntry ?? 0);
    // The replacement survived the re-entry, so `current` is still the row the
    // echo would return — only its stale `parentEntry` rules it out.
    const surviving = (reentered?.substepStates ?? []).find((row) => row.id === '1');
    expect(surviving?.delegation?.credential.supersedesTokenHash).toBeDefined();

    const replayed = await delegateJson(['--retry', '--step', '1.1']);
    expect(replayed.action).toBe('retried');
    expect(replayed.token).not.toBe(t2.token);
  });

  it('refuses RD-826 when the replacement was claimed by a child', async () => {
    const t1 = await setup();
    const t2 = await delegateJson(['--retry', '--step', '1.1']);

    const claimed = await runCliInProcess(['claim', String(t2.token)], workspace);
    expect(claimed.exitCode).toBe(0);

    // Committed evidence the replacement's bearer was presented: retrying the
    // bearer it replaced would mint a third over work already in progress.
    const refused = await runCliInProcess(
      ['delegate', '--retry', t1, '--claim-id', claimId],
      workspace,
    );
    expect(refused.exitCode).toBe(1);
    const combined = refused.stdout + refused.stderr;
    expect(combined).toContain('RD-826');
    expect(combined).not.toContain(t1);
    expect(combined).not.toContain(String(t2.token));
  });
});
