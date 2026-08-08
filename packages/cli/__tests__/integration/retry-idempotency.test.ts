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
import { assertClaimId, claimKeyFromBearer, ErrorResponseSchema } from '@rundown-org/core';
import { patchPersistedRunState } from '@rundown-org/core/testing/session-fixtures';
import {
  createTestWorkspace,
  createRunbook,
  findActionOutput,
  getActiveState,
  parseCliJsonObject,
  parseConcatenatedJson,
  readRunbookState,
  readSession,
  requireEmittedRunClaim,
  requireFrontierToken,
  requireLatestFrontierToken,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Locate the `{ kind: 'error' }` envelope among a command's (possibly
 * concatenated) JSON objects — a refusal can be preceded by execution events,
 * so a single `JSON.parse` over stdout is not safe.
 *
 * @param stdout - Raw command stdout.
 * @returns The error envelope, or undefined when the command emitted none.
 */
function findErrorEnvelope(stdout: string): Record<string, unknown> | undefined {
  return parseConcatenatedJson(stdout).find(
    (o): o is Record<string, unknown> =>
      typeof o === 'object' && o !== null && (o as { kind?: string }).kind === 'error',
  );
}

describe('retry idempotency', () => {
  let workspace: TestWorkspace;
  let claimId: string;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
    // Reset alongside the workspace: the claim is suite-scoped, so a test that
    // never calls a setup helper would otherwise drive the fresh workspace with
    // the previous test's claim. Empty fails loudly instead.
    claimId = '';
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /**
   * Stand up a parent parked on a DELEGATE substep `1.1`, running prompted so a
   * single auto-issued delegation is the only one `--retry` can find.
   *
   * @returns The latest frontier bearer recorded at `1.1`.
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

  /**
   * Stand up a parent whose step-level `FAIL ANY RETRY 1 CONTINUE` has already
   * fired, so the delegation at `1.1` was re-issued by the MACHINE rather than
   * by a manual `delegate --retry`.
   *
   * The shape is `delegate-workflow.test.ts`'s mixed fan-out: substep 1.1
   * delegates, 1.2 is a plain command substep, and both failing drives step-level
   * aggregation into `runRetryHook`.
   *
   * @returns The parent run id and the bearer the machine's RETRY re-issued.
   */
  async function setupMachineRetry(): Promise<{ parentRunId: string; machineToken: string }> {
    const failChild = createRunbook({
      title: 'Child Fail',
      steps: [
        { title: 'Do work', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.runbook.md'), failChild);
    await writeFile(join(workspace.runbooksDir(), 'child-fail.runbook.md'), failChild);

    const parentContent = [
      '# Parent',
      '',
      '## 1. Mixed fan-out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY RETRY 1 CONTINUE',
      '',
      '### 1.1 Delegate task',
      '',
      '- DELEGATE',
      '- child-fail.runbook.md',
      '',
      '### 1.2 Command task',
      '',
      '```bash',
      'rd echo --result fail',
      '```',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      '```bash',
      'rd echo --result pass',
      '```',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const started = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    if (started.exitCode !== 0) {
      throw new Error(`setup run failed:\n${started.stdout}\n${started.stderr}`);
    }
    const parentState = await getActiveState(workspace);
    if (!parentState) throw new Error('expected an active parent run');
    const parentRunId = parentState.id;
    claimId = requireEmittedRunClaim(workspace, parentRunId);
    const tokenA = requireFrontierToken(started.stdout, '1.1');

    // The delegated child claims and reports fail; the child's own FAIL action
    // is STOP, so `fail` exits 1 on the child's lifecycle.
    const claimed = await runCliInProcess(['claim', tokenA], workspace);
    expect(claimed.exitCode).toBe(0);
    const childClaimId = String(findActionOutput(claimed.stdout)?.claim_id);
    const childFailed = await runCliInProcess(['fail', '--claim-id', childClaimId], workspace);
    expect(childFailed.exitCode).toBe(1);

    // Collect the reported outcome, then fail 1.2 so step-level aggregation
    // fires RETRY and the machine re-issues 1.1's delegation.
    const collected = await runCliInProcess(['collect', '--claim-id', claimId], workspace);
    expect(collected.exitCode).toBe(0);
    const aggregated = await runCliInProcess(['fail', '--claim-id', claimId], workspace);
    expect(aggregated.exitCode).toBe(0);

    return { parentRunId, machineToken: requireFrontierToken(aggregated.stdout, '1.1') };
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
    // Required, not defaulted: `?? 0` below would degrade the re-entry
    // assertion to "greater than zero", which any entry satisfies.
    if (typeof beforeEntry !== 'number') throw new Error('expected a numeric activeEntry');

    // Navigate away and back, so the walk crosses two distinct leaves and the
    // frame is re-entered from outside it. A GOTO onto the substep the cursor
    // already sits on would also do: it is a genuine re-entry, not a no-op —
    // it increments `retryCount`, rewrites `lastAction`, resets the frame's
    // substep rows, re-fires `__issue-delegations`, and declares
    // `frameReentry`, so the machine's leaf entry action scores it as one bump
    // (the self-targeting transitions carry `reenter: true` for exactly that
    // reason). The away-and-back form is kept because it also exercises the
    // cross-leaf path.
    for (const target of ['1.2', '1.1']) {
      const moved = await runCliInProcess(['goto', target, '--claim-id', claimId], workspace);
      expect(moved.exitCode).toBe(0);
    }
    const reentered = await getActiveState(workspace);
    expect(reentered?.activeEntry).toBeGreaterThan(beforeEntry);
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
    // Validated against the published error contract, not string-matched on
    // concatenated stdout+stderr: a substring assertion passes on a `message`
    // that merely mentions the code, so it cannot detect the envelope losing
    // its machine-readable `code` field — the only part an agent dispatches on.
    const envelope = findErrorEnvelope(refused.stdout);
    expect(envelope).toBeDefined();
    expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
    expect(envelope?.code).toBe('RD-826');
    const combined = refused.stdout + refused.stderr;
    expect(combined).not.toContain(t1);
    expect(combined).not.toContain(String(t2.token));
  });

  it('refuses RD-826 over a TERMINAL claimed child without releasing its claim', async () => {
    // A terminal linked child changes the transaction SHAPE: the retry becomes
    // a two-target aggregate that also carries `releases` for the child. The
    // claimed-child fixture above never enters it (the child run is still
    // running), so the interaction between the idempotency refusal and the
    // release is untested. The refusal must return before the effect boundary,
    // leaving the child's claim exactly as it was — a refusal that released it
    // would strand a completed child with no way to re-report.
    const t1 = await setup();
    const parentRunId = (await getActiveState(workspace))?.id;
    if (parentRunId === undefined) throw new Error('expected an active parent run');
    const t2 = await delegateJson(['--retry', '--step', '1.1']);

    const claimed = await runCliInProcess(['claim', String(t2.token)], workspace);
    expect(claimed.exitCode).toBe(0);
    const claimAction = findActionOutput(claimed.stdout);
    const childClaimId = String(claimAction?.claim_id);
    // `claim` does not push the child onto the default stack, so the child run
    // id comes from the claim's own output, not from the active state.
    const childRunId = String(claimAction?.run_id);

    // Drive the child to completion so the parent sees a TERMINAL linked child.
    const finished = await runCliInProcess(['pass', '--claim-id', childClaimId], workspace);
    expect(finished.exitCode).toBe(0);
    // The precondition for the multi-target shape: `hasTerminalChild` is
    // `linkedChildRunId !== null && lifecycle is completed/stopped`, so a child
    // left running (as in the fixture above) never reaches it.
    const childBefore = await readRunbookState(workspace, childRunId);
    expect(childBefore?.lifecycle).toBe('completed');

    const childClaimKey = claimKeyFromBearer(assertClaimId(childClaimId));
    const claimBefore = (await readSession(workspace)).claims[childClaimKey];
    expect(claimBefore).toBeDefined();

    const refused = await runCliInProcess(
      ['delegate', '--retry', t1, '--claim-id', claimId],
      workspace,
    );
    expect(refused.exitCode).toBe(1);
    const envelope = findErrorEnvelope(refused.stdout);
    expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
    expect(envelope?.code).toBe('RD-826');

    // The child's claim and terminal state are untouched: the refusal returned
    // from `beforeEffect`, so the aggregate's `releases` never ran and neither
    // did the parent's re-mint.
    expect((await readSession(workspace)).claims[childClaimKey]).toEqual(claimBefore);
    expect(await readRunbookState(workspace, childRunId)).toEqual(childBefore);
    const parentAfter = await readRunbookState(workspace, parentRunId);
    const retriedRow = (parentAfter?.substepStates ?? []).find((row) => row.id === '1');
    expect(retriedRow?.delegation?.childRunId).toBe(childRunId);

    // Positive control for both halves. A step-located retry over the same
    // terminal child is `rotatable` (rows 12/13: a linked child is not evidence
    // the CURRENT bearer went unused), so it COMMITS — and committing is what
    // runs the aggregate's `releases`. Without this, the retention assertion
    // above could pass on a transaction that never had a release to skip.
    const rotated = await delegateJson(['--retry', '--step', '1.1']);
    expect(rotated.action).toBe('retried');
    expect((await readSession(workspace)).claims[childClaimKey]).not.toEqual(claimBefore);
    const unlinked = await readRunbookState(workspace, parentRunId);
    expect(
      (unlinked?.substepStates ?? []).find((row) => row.id === '1')?.delegation?.childRunId,
    ).toBeNull();
  });

  it('refuses RD-828 without putting any bearer in the envelope', async () => {
    // Unreachable through the CLI's own writes — `retryDelegation` records the
    // replacement at the same coordinate as the bearer it supersedes, so at
    // most one row can name any bearer. Planted directly to prove the refusal
    // is wired end to end AND that its envelope is bearer-free: RD-827/828 are
    // raised from a token the caller supplied on the command line, so a factory
    // that echoed its argument would leak it here.
    const t1 = await setup();
    const t2 = await delegateJson(['--retry', '--step', '1.1']);
    const state = await getActiveState(workspace);
    if (!state) throw new Error('expected an active run');

    await patchPersistedRunState(workspace.cwd, state.id, (current) => {
      const rows = current.substepStates as Array<Record<string, unknown>>;
      const superseding = rows.find((row) => row.id === '1');
      if (!superseding) throw new Error('expected the retried substep row');
      return { ...current, substepStates: [...rows, { ...superseding, id: '2' }] };
    });

    const refused = await runCliInProcess(
      ['delegate', '--retry', t1, '--claim-id', claimId],
      workspace,
    );
    expect(refused.exitCode).toBe(1);
    const envelope = findErrorEnvelope(refused.stdout);
    expect(ErrorResponseSchema.safeParse(envelope).success).toBe(true);
    expect(envelope?.code).toBe('RD-828');
    const combined = refused.stdout + refused.stderr;
    expect(combined).not.toContain(t1);
    expect(combined).not.toContain(String(t2.token));
  });

  it('echoes rather than rotating on the first manual --retry after a machine-driven RETRY', async () => {
    // #681's ratified coupling, deliberately accepted and deliberately
    // surprising. `runRetryHook` stamps `supersedesTokenHash` exactly as a
    // manual retry does, so the machine's re-issued bearer is indistinguishable
    // from a manual replacement — and the very next `delegate --retry` reads as
    // a replay and ECHOES. The remedy is in the response: the echo carries the
    // current token, so the caller rotates by naming it.
    const { parentRunId, machineToken } = await setupMachineRetry();

    const before = await getActiveState(workspace);
    const echoed = await delegateJson(['--retry', '--step', '1.1']);

    expect(echoed.action).toBe('retry-already-applied');
    // The response carries the CURRENT bearer — the machine's re-issued one —
    // which is the only way the caller can name it to force a real rotation.
    expect(echoed.token).toBe(machineToken);
    // `parent_run_id` exactly: a `?? parentRunId` fallback here would keep
    // passing if the emitter or schema renamed the field.
    expect(echoed.parent_run_id).toBe(parentRunId);
    // The echo is a pure read: nothing about the run changed.
    expect(await getActiveState(workspace)).toEqual(before);

    // ...and naming that token does rotate, so the surprise has a remedy.
    const rotated = await delegateJson(['--retry', machineToken]);
    expect(rotated.action).toBe('retried');
    expect(rotated.token).not.toBe(machineToken);
  });
});
