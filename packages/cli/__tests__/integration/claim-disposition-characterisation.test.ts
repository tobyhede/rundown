import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunbookStateManager, SessionService, assertClaimId } from '@rundown-org/core';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  parseJsonEvents,
  parseCliJsonObject,
  type TestWorkspace,
} from '../helpers/test-utils.js';

/**
 * Characterisation of today's terminal claim disposition (#781).
 *
 * These tests pin CURRENT behaviour, including the defect. They assert the
 * answer an orchestrator gets back at the *resolution* seam — the status a
 * presented run-control bearer resolves to — rather than the shape stored in
 * the session projection, because the projection is what #792 rewrites and the
 * resolution is what a caller actually observes.
 *
 * Two of the three assertions are deliberately asymmetric:
 *
 * - The already-terminal loop entry currently resolves `superseded` /
 *   `claim-rotated`. That is the #781 defect. The assertion flips to `terminal`
 *   in #793, and it must be green *before* that change so the flip is visible
 *   as a one-line diff rather than as a new test.
 * - The fenced completion currently resolves `terminal`, and must keep doing so
 *   at every point in the cluster. It is the control.
 *
 * The trigger for the defective path has to be an already-terminal *loop
 * entry*. A plain completion does not reach the revoking release at all: the
 * fenced command mutation releases with retention and the loop returns before
 * the entry-time terminal check, so a characterisation test built on a plain
 * completion passes under both the old and the new code — for the wrong reason.
 * A delegation whose child runbook is not discoverable is the cheapest trigger:
 * it stops the run during initialization and re-enters the loop already
 * terminal.
 *
 * Both tests discharge #790's multi-process requirement inline rather than in a
 * third case: the run is one subprocess, `resolveClaim` reads the database from
 * this one, and the `rundown status --claim-id` assertion is a further
 * subprocess sharing nothing with the run but the database. A unit suite that
 * mocks the session boundary observes neither the retained claim nor the
 * tombstone surviving persistence; these do. A separate combined test was
 * removed as a strictly weaker restatement of the two below — it duplicated the
 * assertion #793 has to flip, in a place a reader would not think to look.
 */
describe('Terminal claim disposition at the resolution seam (#781 characterisation)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** The run-control bearer and run id a `rundown run` invocation emitted. */
  interface StartedRun {
    readonly claimId: string;
    readonly runId: string;
  }

  /**
   * Read the run-control bearer off `runbook_started`.
   *
   * That event is the sole delivery surface for the bearer — it is never
   * recoverable from persisted state — so every test here starts by capturing
   * it from the subprocess that minted it.
   */
  function requireStartedRun(stdout: string): StartedRun {
    const started = parseJsonEvents(stdout).find((event) => event.type === 'runbook_started');
    if (started === undefined) throw new Error(`no runbook_started event in: ${stdout}`);
    const { claim_id: claimId, runbookId } = started;
    if (typeof claimId !== 'string') throw new Error('runbook_started carried no claim_id');
    if (typeof runbookId !== 'string') throw new Error('runbook_started carried no runbookId');
    return { claimId, runId: runbookId };
  }

  /** Resolve a bearer through core, in this process, against the workspace db. */
  async function resolveClaim(claimId: string) {
    const session = new SessionService(new RunbookStateManager(workspace.cwd));
    return session.getActiveForClaimId(assertClaimId(claimId));
  }

  /** A parent whose only substep delegates to a runbook that does not exist. */
  async function writeUnresolvableDelegation(): Promise<void> {
    const content = [
      '# Parent',
      '',
      '## 1. Fan-out',
      '',
      '- DELEGATE',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Task A',
      '',
      '- missing-child.runbook.md',
      '',
    ].join('\n');
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** A single-step runbook that completes through a fenced command. */
  async function writeFencedCompletion(): Promise<void> {
    const content = createRunbook({
      title: 'Control',
      steps: [{ title: 'Do a thing', pass: 'COMPLETE', fail: 'STOP', command: 'true' }],
    });
    await writeFile(join(workspace.cwd, 'control.runbook.md'), content);
  }

  it('leaves an already-terminal loop entry resolving superseded / claim-rotated', async () => {
    // THE DEFECT. `rundown run` mints a run-control claim for every default-stack
    // root, and the terminal loop entry releases that root through the
    // stack-pop derivation, which encodes "this run is unclaimed" — a premise
    // the minting falsified. The claim is revoked, and its holder is told to
    // claim a delegation that does not exist.
    await writeUnresolvableDelegation();

    const run = runCli('run parent.runbook.md', workspace);
    const started = requireStartedRun(run.stdout);
    expect(parseJsonEvents(run.stdout).map((event) => event.type)).toContain('runbook_stopped');
    expect(
      parseJsonEvents(run.stdout).find((event) => event.type === 'runbook_stopped'),
    ).toMatchObject({ reason: 'delegation_resolution_failed' });

    // The precise reason, which the CLI envelope does not carry.
    await expect(resolveClaim(started.claimId)).resolves.toMatchObject({
      status: 'superseded',
      reason: 'claim-rotated',
    });

    // And what the orchestrator is actually told. `claim-rotated` and
    // `parent-unreadable` share this code, so the message is what separates
    // them — it names a delegation to re-claim that was never issued.
    const status = runCli(`status --claim-id ${started.claimId}`, workspace);
    expect(status.exitCode).toBe(1);
    const envelope = parseCliJsonObject(status.stdout || status.stderr);
    expect(envelope).toMatchObject({ kind: 'error', code: 'CLAIMED_RUNBOOK_UNAVAILABLE' });
    expect(String(envelope.error)).toContain('was released or replaced and is no longer authority');
  });

  it('leaves a run that completed through a fenced command resolving terminal', async () => {
    // THE CONTROL. This assertion must not move at any point in the #781
    // cluster: the fence already releases with retention, and #793 makes the
    // loop-entry path agree with it rather than the other way round.
    await writeFencedCompletion();

    const run = runCli('run control.runbook.md --allow-all', workspace);
    const started = requireStartedRun(run.stdout);
    expect(parseJsonEvents(run.stdout).map((event) => event.type)).toContain('runbook_completed');

    await expect(resolveClaim(started.claimId)).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'completed',
    });

    const status = runCli(`status --claim-id ${started.claimId}`, workspace);
    expect(status.exitCode).toBe(0);
    expect(parseCliJsonObject(status.stdout)).toMatchObject({
      status: 'completed',
      active: false,
      runId: started.runId,
    });
  });
});
