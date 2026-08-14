import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { RunbookStateManager } from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  getActiveState,
  issueRunControlClaim,
  parseCliJsonObject,
  parseConcatenatedJson,
  readRunbookState,
  runCli,
  runCliInProcess,
  requireFrontierToken,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deletePersistedRunState } from '@rundown-org/core/testing/session-fixtures';

describe('Delegation abort integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
              runbooks: ['child.runbook.md'],
            },
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: ['child.runbook.md'],
            },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), content);
  }

  /** Helper: start parent, delegate, return token and parent bearer. */
  async function setupDelegation(): Promise<{ token: string; parentClaimId: string }> {
    await writeParentRunbook();
    await writeChildRunbook();

    const result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    const token = requireFrontierToken(result.stdout, '1.1');
    const parentClaimId = await issueRunControlClaim(workspace, state!.id);
    return { token, parentClaimId };
  }

  it('rejects invalid token format', () => {
    const result = runCli('abort bad-token', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-807' }));
  });

  it('rejects unknown token', () => {
    // cspell:disable-next-line
    const result = runCli('abort rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-808' }));
  });

  it('renders text output for pending abort', async () => {
    const { token, parentClaimId } = await setupDelegation();

    const result = runCli(`abort ${token} --claim-id ${parentClaimId} --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CANCELLED/i);
  });

  it('claim after abort fails with RD-809', async () => {
    const { token, parentClaimId } = await setupDelegation();

    // Abort the delegation
    let result = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to claim — should fail
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(
      expect.objectContaining({ kind: 'error', code: 'DELEGATION_CANCELLED' }),
    );
  });

  // The same refusal, from the other side of the claim's own pre-commit read
  // (#752). `rd claim` re-reads the parent and refuses a delegation it finds
  // cancelled — that is the test above. This one lands the abort AFTER that
  // read, so the only reader that can see it is core's in-transaction
  // classifier, and the code the claimer gets must not change with the timing.
  // Before the fix the classifier folded cancellation into `resolved`, and this
  // path reported RD-825 DELEGATION_SUPERSEDED — "the parent has moved past
  // this delegation" — about a parent still sitting on it.
  it('claim racing an abort fails with RD-809, not the superseded code', async () => {
    const { token, parentClaimId } = await setupDelegation();
    const parentBefore = await getActiveState(workspace);

    // Inject the abort inside the claim's own window. `manager.create` builds
    // the child run — after `claimAndLaunch`'s 3b cancellation check has passed
    // on an uncancelled delegation, and before the atomic claim commits — so
    // the interleaving is real rather than stubbed. The abort needs no
    // `--force`: the delegation records no child until the commit this claim
    // never reaches.
    /* eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-apply with the spy's `this` */
    const originalCreate = RunbookStateManager.prototype.create;
    let aborted: Awaited<ReturnType<typeof runCliInProcess>> | undefined;
    const createSpy = jest
      .spyOn(RunbookStateManager.prototype, 'create')
      .mockImplementation(async function (
        this: RunbookStateManager,
        ...args: Parameters<RunbookStateManager['create']>
      ) {
        const state = await originalCreate.apply(this, args);
        aborted ??= await runCliInProcess(['abort', token, '--claim-id', parentClaimId], workspace);
        return state;
      });

    let result: Awaited<ReturnType<typeof runCliInProcess>>;
    try {
      result = await runCliInProcess(`claim ${token}`, workspace);
    } finally {
      createSpy.mockRestore();
    }

    // Preconditions. The delegation was uncancelled when the claim started, so
    // the 3b pre-check passed on it, and the abort committed from inside the
    // window (`create` runs only during the claim). Without these the test
    // would still pass by taking the pre-check path it exists to sit past.
    const substepBefore = (parentBefore?.substepStates ?? []).find((ss) => ss.id === '1');
    expect(substepBefore?.delegation?.cancelledAt).toBeNull();
    expect(aborted?.exitCode).toBe(0);

    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    // The timestamp is the committed one, read by the transaction that refused
    // — the CLI's own pre-check had none to report.
    const parentAfter = await getActiveState(workspace);
    const cancelledAt = (parentAfter?.substepStates ?? []).find((ss) => ss.id === '1')?.delegation
      ?.cancelledAt;
    expect(cancelledAt).toEqual(expect.any(String));
    expect(envelope).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'DELEGATION_CANCELLED',
        details: expect.objectContaining({ cancelledAt }),
      }),
    );
  }, 30_000);

  it('ordinary abort (no --force) closes the delegation without a fail outcome or pending collection', async () => {
    const { token, parentClaimId } = await setupDelegation();

    // Ordinary cancel of a pending (issued, not yet claimed) delegation.
    const abort = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(abort.exitCode).toBe(0);

    const parent = await getActiveState(workspace);
    // No delegation outcome row recorded — ordinary cancel synthesizes no fail.
    // This preserves the cancellation split (ordinary cancel != force-abort).
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(0);

    // The delegating run is NOT collection pending: a bare advance is not
    // refused with DELEGATION_COLLECTION_PENDING (it may be refused for an
    // unrelated reason, but never for a pending reported outcome that does not
    // exist).
    const advance = runCli('pass', workspace);
    expect(`${advance.stdout}${advance.stderr}`).not.toContain('DELEGATION_COLLECTION_PENDING');
  });

  it('claimed abort without --force fails with RD-811', async () => {
    const { token, parentClaimId } = await setupDelegation();

    // Claim the token
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to abort without force — should fail
    result = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(result.exitCode).toBe(1);
    const envelope = parseCliJsonObject(result.stdout || result.stderr);
    expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-811' }));
  });

  it('claimed abort with --force records a fail outcome and leaves collection pending', async () => {
    const { token, parentClaimId } = await setupDelegation();
    const parentId = (await getActiveState(workspace))!.id;

    // Claim the token
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Force abort
    result = runCli(`abort ${token} --claim-id ${parentClaimId} --force`, workspace);
    expect(result.exitCode).toBe(0);
    const output = parseConcatenatedJson(result.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { action?: unknown }).action === 'abort',
    );
    expect(output).toBeDefined();
    expect(output).toEqual(expect.objectContaining({ action: 'abort', status: 'cancelled' }));

    // Plan 5 (report-only): force-abort records a FAIL outcome on the delegating
    // run and stops — it does NOT drain/apply/cascade. The recorded row leaves
    // the delegating run collection pending and does NOT advance it.
    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    expect(parent!.step).toBe('1');

    // Collection pending: a run-targeted bare-shaped advance is refused until
    // `rd collect` (named authority does not skip collection discipline).
    const blocked = runCli(`pass --claim-id ${parentClaimId}`, workspace);
    expect(blocked.exitCode).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('DELEGATION_COLLECTION_PENDING');
  });

  it('replaying the original token after force-abort reports DELEGATION_CANCELLED', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    const created = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(created.exitCode).toBe(0);
    const started = parseConcatenatedJson(created.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'runbook_started',
    );
    expect(typeof started?.claim_id).toBe('string');
    const entered = parseConcatenatedJson(created.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'step_entered',
    );
    const token = (
      entered?.delegateFrontier as ReadonlyArray<{ readonly token?: unknown }> | undefined
    )?.[0]?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') {
      throw new Error('Expected delegation token');
    }
    const parentClaimId = String(started!.claim_id);

    const claimed = await runCliInProcess(`claim ${token}`, workspace);
    expect(claimed.exitCode).toBe(0);

    const aborted = await runCliInProcess(
      `abort ${token} --claim-id ${parentClaimId} --force`,
      workspace,
    );
    expect(aborted.exitCode).toBe(0);

    const replayed = await runCliInProcess(`claim ${token}`, workspace);
    expect(replayed.exitCode).toBe(1);
    expect(parseCliJsonObject(replayed.stdout || replayed.stderr)).toEqual(
      expect.objectContaining({ kind: 'error', code: 'DELEGATION_CANCELLED' }),
    );
  });

  it('force-aborts a resolved failed linked child without RD-812', async () => {
    const { token, parentClaimId } = await setupDelegation();
    const parentId = (await getActiveState(workspace))!.id;

    const claim = runCli(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimPayload = parseConcatenatedJson(claim.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && 'claim_id' in value,
    );
    if (claimPayload === undefined) {
      throw new Error('expected claim payload');
    }
    const claimId = String(claimPayload.claim_id);

    const failed = runCli(`fail --claim-id ${claimId}`, workspace);
    expect(failed.exitCode).toBe(1);

    const result = runCli(`abort ${token} --claim-id ${parentClaimId} --force`, workspace);
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('RD-812');

    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (row) => row.agentId === 'delegation',
    );
    expect(rows).toEqual([expect.objectContaining({ result: 'fail' })]);
    const entry = parent!.substepStates?.find((state) => state.id === '1');
    expect(entry?.delegation?.cancelledAt).not.toBeNull();
  });

  it('reports the stale-reference cleanup when force-aborting a pruned linked child', async () => {
    // End-to-end shape of the `missing_child_cleaned` cleanup: the parent still
    // names a childRunId whose run has been pruned, so `--force` clears the
    // stale link. The operator must be told the link was cleaned, not that the
    // delegation was merely pending — the latter reads as "no child was ever
    // claimed", which is the opposite of what happened.
    // Driven in-process: the spawned `runCli` path executes the last built
    // `dist/cli.js`, which predates the core cleanup branch this asserts on.
    const { token, parentClaimId } = await setupDelegation();
    const parentId = (await getActiveState(workspace))!.id;

    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimPayload = parseConcatenatedJson(claim.stdout).find(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && 'run_id' in value,
    );
    if (claimPayload === undefined) throw new Error('expected claim payload');
    const childRunId = String(claimPayload.run_id);

    // Prune the child exactly as `rundown prune` does: the parent keeps its
    // reference, the run itself is gone.
    await deletePersistedRunState(workspace.cwd, childRunId);

    const result = await runCliInProcess(
      `abort ${token} --claim-id ${parentClaimId} --force --text`,
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(linked child run missing, stale reference cleaned up)');
    expect(result.stdout).not.toContain('pending delegation');

    // The stale link is actually gone, so the rendered claim is true.
    const parent = await readRunbookState(workspace, parentId);
    const entry = parent!.substepStates?.find((state) => state.id === '1');
    expect(entry?.delegation?.cancelledAt).toEqual(expect.any(String));
  });

  it('force abort inside a FOR iteration leaves that iteration frame collection pending', async () => {
    await writeChildRunbook();
    // A FOR step that fans out a single delegated substep per iteration. The
    // delegation linkage carries the iteration-scoped frame key, so the recorded
    // fail outcome (and the collection-pending guard) must key on that frame.
    const parentContent = [
      '# For Abort',
      '',
      '## 1. Process items',
      '',
      '- FOR i IN 1 TO 1',
      '- DELEGATE',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Work {{i}}',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '',
      '- PASS COMPLETE',
      '',
      'All done.',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'for-abort.runbook.md'), parentContent);

    const start = runCli('run --prompted for-abort.runbook.md', workspace);
    expect(start.exitCode).toBe(0);

    // The FOR step has entered iteration 1; substep 1.1 auto-issued a token in
    // the iteration frame.
    const entered = await getActiveState(workspace);
    const parentId = entered!.id;
    const parentClaimId = await issueRunControlClaim(workspace, parentId);
    const token = requireFrontierToken(start.stdout, '1.1');

    // Claim (in-flight), then force abort.
    let result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    result = runCli(`abort ${token} --claim-id ${parentClaimId} --force`, workspace);
    expect(result.exitCode).toBe(0);

    const parent = await readRunbookState(workspace, parentId);
    const rows = Object.values(parent!.resolvedCompletions ?? {}).filter(
      (c) => c.agentId === 'delegation',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    // The recorded row is keyed on the ITERATION frame, not a bare step frame.
    const recordedFrameSubstep = parent?.substepStates?.find((ss) => ss.id === '1');
    expect(rows[0]?.targetFrameKey).toBe(recordedFrameSubstep?.frameKey);

    // Run-targeted bare-shaped advance refused — the iteration frame is
    // collection pending.
    const blocked = runCli(`pass --claim-id ${parentClaimId}`, workspace);
    expect(blocked.exitCode).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('DELEGATION_COLLECTION_PENDING');
  });

  it('idempotent on already-cancelled', async () => {
    const { token, parentClaimId } = await setupDelegation();

    // Abort twice
    let result = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(result.exitCode).toBe(0);
    const output = parseCliJsonObject(result.stdout);
    expect(output).toEqual(
      expect.objectContaining({ action: 'abort', status: 'already_cancelled' }),
    );
  });

  it('JSON output structure', async () => {
    const { token, parentClaimId } = await setupDelegation();

    const result = runCli(`abort ${token} --claim-id ${parentClaimId}`, workspace);
    expect(result.exitCode).toBe(0);

    const output = parseCliJsonObject(result.stdout);
    expect(output.action).toBe('abort');
    expect(output.status).toBe('cancelled');
    expect(output.token).toBeDefined();
    expect(output.substep).toBeDefined();
    expect(output.runbook).toContain('child.runbook.md');
    expect(output.parentRunId).toBeDefined();
  });
});
