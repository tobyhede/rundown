import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  extractToken,
  findActionOutput,
  getActiveState,
  issueRunControlClaim,
  parseConcatenatedJson,
  readRunbookState,
  readSession,
  runCliInProcess,
  type TestWorkspace,
} from '../helpers/test-utils.js';

// R1 acceptance suite for explicit bearer targeting (#460): ambient direct-CLI
// trust over delegation-exposed runs is removed; orchestrators name their
// authority with --claim-id, delegated children keep --claim-id, and bare commands
// remain acceptable only for standalone runs.

interface ErrorEnvelope {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

function findErrorEnvelope(stdout: string): ErrorEnvelope | undefined {
  return parseConcatenatedJson(stdout).find(
    (entry): entry is ErrorEnvelope =>
      typeof entry === 'object' && entry !== null && (entry as { kind?: string }).kind === 'error',
  );
}

function findDelegateToken(stdout: string): string | undefined {
  for (const event of parseConcatenatedJson(stdout)) {
    if (!event || typeof event !== 'object') continue;
    const frontier = (event as { delegateFrontier?: Array<{ token?: string }> }).delegateFrontier;
    const token = frontier?.[0]?.token;
    if (typeof token === 'string') return token;
  }
  return undefined;
}

describe('explicit --run targeting (R1, #460)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Parent authoring one DELEGATE substep at step 1; child is a single prompt. */
  async function setupDelegatingParent(): Promise<void> {
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', content: 'Child prompt.' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate work',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Child work',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
          ],
        },
        { title: 'After', pass: 'COMPLETE', content: 'Wrap up.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
  }

  it('refuses a lingering child agent bare pass and bare delegate against the parent, while --claim-id succeeds (#460)', async () => {
    await setupDelegatingParent();
    const parent = await getActiveState(workspace);
    if (!parent) throw new Error('Expected active parent run');

    const parentClaimId = await issueRunControlClaim(workspace, parent.id);

    // The orchestrator names its authority to issue the delegation.
    const issued = await runCliInProcess(['delegate', '--claim-id', parentClaimId], workspace);
    expect(issued.exitCode).toBe(0);
    const token = extractToken(issued.stdout);
    if (!token) throw new Error('Expected delegation token');

    const claimed = await runCliInProcess(['claim', token], workspace);
    expect(claimed.exitCode).toBe(0);
    const claimId = String(findActionOutput(claimed.stdout)?.claim_id);
    expect(claimId).toMatch(/^rdclm_/);

    // The child closes its claim (reports pass to the parent).
    const closed = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    // The lingering child oversteps with bare commands — the #460 defect.
    const barePass = await runCliInProcess(['pass'], workspace);
    expect(barePass.exitCode).not.toBe(0);
    const passEnvelope = findErrorEnvelope(barePass.stdout);
    expect(passEnvelope?.code).toBe('ACTOR_CONTEXT_REQUIRED');
    // Decision 4 pinned: the refusal must not hand the id back (accident
    // barrier, not secrecy).
    expect(JSON.stringify(passEnvelope)).not.toContain(parent.id);

    const bareDelegate = await runCliInProcess(['delegate'], workspace);
    expect(bareDelegate.exitCode).not.toBe(0);
    expect(findErrorEnvelope(bareDelegate.stdout)?.code).toBe('ACTOR_CONTEXT_REQUIRED');

    // No state mutation occurred under either refusal.
    const after = await getActiveState(workspace);
    expect(after?.step).toBe(parent.step);
    expect(after?.lifecycle).toBe('running');

    // The orchestrator names its authority and proceeds: collect the reported
    // outcome, advancing the parent to step 2.
    const collected = await runCliInProcess(['collect', '--claim-id', parentClaimId], workspace);
    expect(collected.exitCode).toBe(0);
    const advanced = await getActiveState(workspace);
    expect(advanced?.step).toBe('2');

    // A run-targeted pass drives the parent even though it is delegating.
    const targeted = await runCliInProcess(['pass', '--claim-id', parentClaimId], workspace);
    expect(targeted.exitCode).toBe(0);
  });

  it('keeps bare pass working end-to-end on a standalone run', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess(['pass'], workspace);

    expect(result.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('2');
  });

  it('refuses bare pass on a not-yet-issued run whose DOCUMENT authors DELEGATE (static clause a)', async () => {
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', content: 'Child prompt.' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
    const parentContent = createRunbook({
      title: 'Late delegator',
      steps: [
        { title: 'Prepare', pass: 'CONTINUE', content: 'Prepare.' },
        {
          title: 'Delegate later',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
          ],
        },
        { title: 'After', pass: 'COMPLETE', content: 'Wrap up.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'late.runbook.md'), parentContent);
    const start = await runCliInProcess('run --prompted runbooks/late.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('1');

    // No delegation has been issued yet — the static document clause protects
    // the run from step 1, so exposure cannot be raced by execution order.
    const bare = await runCliInProcess(['pass'], workspace);
    expect(bare.exitCode).not.toBe(0);
    expect(findErrorEnvelope(bare.stdout)?.code).toBe('ACTOR_CONTEXT_REQUIRED');

    // The orchestrator bearer works.
    const parentClaimId = await issueRunControlClaim(workspace, state!.id);
    const targeted = await runCliInProcess(['pass', '--claim-id', parentClaimId], workspace);
    expect(targeted.exitCode).toBe(0);
  });

  it('refuses bare pass on an inline-linked child stage and accepts --claim-id <childClaimId> (clause e)', async () => {
    const stageContent = createRunbook({
      name: 'stage',
      title: 'Stage',
      steps: [
        { title: 'First', pass: 'CONTINUE', content: 'Stage prompt one.' },
        { title: 'Second', pass: 'COMPLETE', content: 'Stage prompt two.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'stage.runbook.md'), stageContent);
    await writeFile(join(workspace.runbooksDir(), 'stage.runbook.md'), stageContent);
    const rootContent = createRunbook({
      title: 'Root',
      steps: [
        {
          title: 'Compose',
          pass: 'CONTINUE',
          substeps: [{ title: 'Stage', runbooks: ['runbooks/stage.runbook.md'] }],
        },
        { title: 'After', pass: 'COMPLETE', content: 'Wrap up.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'root.runbook.md'), rootContent);

    // Starting the root auto-launches the inline stage; the stage becomes the
    // active run and carries inline parent linkage.
    const start = await runCliInProcess('run runbooks/root.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const stage = await getActiveState(workspace);
    if (!stage) throw new Error('Expected active inline stage');
    expect(stage.parentLinkage?.kind).toBe('inline');

    const bare = await runCliInProcess(['pass'], workspace);
    expect(bare.exitCode).not.toBe(0);
    expect(findErrorEnvelope(bare.stdout)?.code).toBe('ACTOR_CONTEXT_REQUIRED');

    const stageClaimId = await issueRunControlClaim(workspace, stage.id);
    const targeted = await runCliInProcess(['pass', '--claim-id', stageClaimId], workspace);
    expect(targeted.exitCode).toBe(0);
    const after = await getActiveState(workspace);
    expect(after?.step).toBe('2');
  });

  it('refuses a well-formed foreign --run id with RUN_TARGET_UNAVAILABLE', async () => {
    await setupDelegatingParent();
    const foreign = `rd_${'f'.repeat(32)}`;

    const result = await runCliInProcess(['pass', '--run', foreign], workspace);

    expect(result.exitCode).not.toBe(0);
    expect(findErrorEnvelope(result.stdout)?.code).toBe('RUN_TARGET_UNAVAILABLE');
  });

  it('refuses a lingering grandchild bare pass against an inline-composing ROOT after its stage completes (clause f)', async () => {
    // The #460 pattern one level up: the root composes ONLY inline runbook-list
    // stages (no DELEGATE in its own document). A stage delegates, its claimed
    // grandchild lingers after the stage completes and pops — the root must
    // refuse the grandchild's bare drive.
    const leafContent = createRunbook({
      name: 'leaf',
      title: 'Leaf',
      steps: [{ title: 'Work', pass: 'COMPLETE', content: 'Leaf prompt.' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'leaf.runbook.md'), leafContent);
    await writeFile(join(workspace.runbooksDir(), 'leaf.runbook.md'), leafContent);
    const stageContent = createRunbook({
      name: 'stage',
      title: 'Stage',
      steps: [
        {
          title: 'Delegate leaf',
          pass: 'COMPLETE',
          substeps: [
            { title: 'Leaf work', delegate: true, runbooks: ['runbooks/leaf.runbook.md'] },
          ],
        },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'stage.runbook.md'), stageContent);
    await writeFile(join(workspace.runbooksDir(), 'stage.runbook.md'), stageContent);
    const rootContent = createRunbook({
      title: 'Root',
      steps: [
        {
          title: 'Compose',
          pass: 'CONTINUE',
          substeps: [{ title: 'Stage', runbooks: ['runbooks/stage.runbook.md'] }],
        },
        { title: 'After', pass: 'COMPLETE', content: 'Wrap up.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'root.runbook.md'), rootContent);

    // Start the root: the stage auto-launches inline and auto-issues the
    // delegation token on entering its DELEGATE step.
    const start = await runCliInProcess('run runbooks/root.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const root = parseConcatenatedJson(start.stdout).find(
      (event): event is { runbookId: string } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: string }).type === 'runbook_started',
    );
    if (!root) throw new Error('Expected runbook_started event for the root');
    const stage = await getActiveState(workspace);
    if (!stage) throw new Error('Expected active inline stage');
    const token = findDelegateToken(start.stdout);
    if (!token) throw new Error('Expected auto-issued delegation token');

    // Claim and close the grandchild leaf.
    const claimed = await runCliInProcess(['claim', token], workspace);
    expect(claimed.exitCode).toBe(0);
    const claimId = String(findActionOutput(claimed.stdout)?.claim_id);
    const closed = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
    expect(closed.exitCode).toBe(0);

    // The orchestrator collects the stage; the stage completes and propagates
    // inline to the root, which advances to step 2.
    const stageClaimId = await issueRunControlClaim(workspace, stage.id);
    const collected = await runCliInProcess(['collect', '--claim-id', stageClaimId], workspace);
    expect(collected.exitCode).toBe(0);
    const rootAfter = await readRunbookState(workspace, root.runbookId);
    expect(rootAfter?.step).toBe('2');
    expect(rootAfter?.lifecycle).toBe('running');

    // Session-management cleanup of the completed stage (prune is the
    // documented residual ambient lane) leaves the root as the active run.
    const pruned = await runCliInProcess(['prune'], workspace);
    expect(pruned.exitCode).toBe(0);
    const back = await getActiveState(workspace);
    if (!back) throw new Error('Expected the root to be active after pruning the stage');
    expect(back.id).toBe(root.runbookId);
    expect(back.step).toBe('2');

    // The lingering grandchild bare-drives the root — refused (clause f: the
    // root's inline substep record is sticky; its own document has no DELEGATE).
    const bare = await runCliInProcess(['pass'], workspace);
    expect(bare.exitCode).not.toBe(0);
    expect(findErrorEnvelope(bare.stdout)?.code).toBe('ACTOR_CONTEXT_REQUIRED');

    // The orchestrator bearer still works.
    const rootClaimId = await issueRunControlClaim(workspace, back.id);
    const targeted = await runCliInProcess(['pass', '--claim-id', rootClaimId], workspace);
    expect(targeted.exitCode).toBe(0);
  });

  it('refuses a bare goto on a delegating run with ACTOR_CONTEXT_REQUIRED, while goto --claim-id succeeds', async () => {
    // Navigation is role-gated like an advance: a lingering child (or any
    // caller without named authority) must not steer a delegating parent's
    // cursor with a bare `goto`.
    await setupDelegatingParent();
    const parent = await getActiveState(workspace);
    if (!parent) throw new Error('Expected active parent run');

    const bare = await runCliInProcess(['goto', '2'], workspace);
    expect(bare.exitCode).not.toBe(0);
    const envelope = findErrorEnvelope(bare.stdout);
    expect(envelope?.code).toBe('ACTOR_CONTEXT_REQUIRED');
    // Decision 4 pinned: the refusal never echoes the target run id.
    expect(JSON.stringify(envelope)).not.toContain(parent.id);

    // No navigation occurred under the refusal.
    const after = await getActiveState(workspace);
    expect(after?.step).toBe(parent.step);

    // The orchestrator names its authority and navigates the same run.
    const parentClaimId = await issueRunControlClaim(workspace, parent.id);
    const targeted = await runCliInProcess(['goto', '2', '--claim-id', parentClaimId], workspace);
    expect(targeted.exitCode).toBe(0);
    const navigated = await getActiveState(workspace);
    expect(navigated?.step).toBe('2');
  });

  it('surfaces a named-run failure for complete --run on unusable state instead of cleaning the default stack', async () => {
    // Two independent runs on the default stack: the NAMED run underneath, an
    // unrelated run on top. The named run's persisted state is corrupted and
    // the top is orphaned (state file gone, session entry intact). A
    // `complete --run <named>` must surface the named run's failure — it must
    // NOT fall into bare-path orphan cleanup, pop the OTHER run's session
    // entry, and exit 0 without terminating the named run.
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    const named = await getActiveState(workspace);
    if (!named) throw new Error('Expected named run');
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    const top = await getActiveState(workspace);
    if (!top) throw new Error('Expected top run');
    expect(top.id).not.toBe(named.id);

    await writeFile(join(workspace.statePath(), `${named.id}.json`), '{ not valid json');
    await rm(join(workspace.statePath(), `${top.id}.json`));

    const result = await runCliInProcess(['complete', '--run', named.id], workspace);

    // The failure surfaces against the NAMED run and exits non-zero...
    expect(result.exitCode).not.toBe(0);
    expect(findErrorEnvelope(result.stdout)?.code).toBe('RUN_TARGET_UNAVAILABLE');
    // ...and the orphaned top's session entry survives — no default-stack
    // cleanup ran on behalf of a named-run target.
    const session = await readSession(workspace);
    expect(session.defaultStack).toContain(top.id);
  });

  it('run --prompted --step jumps a freshly created delegating-document run; a later bare goto is still gated (LOW-3 boundary)', async () => {
    // Boundary pin for the run --prompted --step gate bypass (run.ts): the
    // in-process jump targets only the run this invocation just minted, with
    // the same authority `goto --run <own-id>` grants, so it is NOT routed
    // through the run-navigation policy gate. The gate still owns every
    // post-creation navigation of the same run.
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Do work', pass: 'COMPLETE', content: 'Child prompt.' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
    const parentContent = createRunbook({
      title: 'Jump target delegator',
      steps: [
        { title: 'Prepare', pass: 'CONTINUE', content: 'Prepare.' },
        {
          title: 'Delegate later',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
          ],
        },
        { title: 'After', pass: 'COMPLETE', content: 'Wrap up.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'jump.runbook.md'), parentContent);

    // The document authors a DELEGATE substep, so the run is delegating from
    // birth (static clause a) — yet the creating invocation's --step jump
    // succeeds without naming authority: the freshly minted id IS its
    // authority, exactly as if it had passed `goto --run <own-id>`.
    const start = await runCliInProcess(
      ['run', '--prompted', 'runbooks/jump.runbook.md', '--step', '3'],
      workspace,
    );
    expect(start.exitCode).toBe(0);
    const state = await getActiveState(workspace);
    if (!state) throw new Error('Expected active run after prompted start');
    expect(state.step).toBe('3');

    // Post-creation, the boundary holds: a bare goto on the same (delegating)
    // run is refused by the run-navigation gate without echoing the run id...
    const bare = await runCliInProcess(['goto', '1'], workspace);
    expect(bare.exitCode).not.toBe(0);
    const envelope = findErrorEnvelope(bare.stdout);
    expect(envelope?.code).toBe('ACTOR_CONTEXT_REQUIRED');
    expect(JSON.stringify(envelope)).not.toContain(state.id);
    const unmoved = await getActiveState(workspace);
    expect(unmoved?.step).toBe('3');

    // ...while the equivalent named authority the creating process held
    // implicitly succeeds explicitly.
    const claimId = await issueRunControlClaim(workspace, state.id);
    const targeted = await runCliInProcess(['goto', '1', '--claim-id', claimId], workspace);
    expect(targeted.exitCode).toBe(0);
    const after = await getActiveState(workspace);
    expect(after?.step).toBe('1');
  });

  it('never grants claim-lane authority to --run: a claimed child run id resolves RUN_TARGET_UNAVAILABLE', async () => {
    await setupDelegatingParent();
    const parent = await getActiveState(workspace);
    if (!parent) throw new Error('Expected active parent run');

    const parentClaimId = await issueRunControlClaim(workspace, parent.id);
    const issued = await runCliInProcess(['delegate', '--claim-id', parentClaimId], workspace);
    const token = extractToken(issued.stdout);
    if (!token) throw new Error('Expected delegation token');
    const claimed = await runCliInProcess(['claim', token], workspace);
    const claimPayload = findActionOutput(claimed.stdout);
    const claimId = String(claimPayload?.claim_id);
    const childRunId = String(claimPayload?.run_id);
    expect(childRunId).toMatch(/^rd_/);

    // Claimed children are never defaultStack members, so --run can never
    // substitute for --claim-id (pinning the invariant a future stack refactor
    // could silently break).
    const viaRun = await runCliInProcess(['pass', '--run', childRunId], workspace);
    expect(viaRun.exitCode).not.toBe(0);
    expect(findErrorEnvelope(viaRun.stdout)?.code).toBe('RUN_TARGET_UNAVAILABLE');

    // The claim lane succeeds.
    const viaClaim = await runCliInProcess(['pass', '--claim-id', claimId], workspace);
    expect(viaClaim.exitCode).toBe(0);
  });
});
