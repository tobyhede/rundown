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
 * Terminal claim disposition at the resolution seam (#781, fixed by #793).
 *
 * These assert the answer an orchestrator gets back at the *resolution* seam —
 * the status a presented run-control bearer resolves to — rather than the shape
 * stored in the session projection, because the projection is an implementation
 * detail and the resolution is what a caller actually observes.
 *
 * Both cases now agree, which is the whole point of the fix:
 *
 * - The already-terminal loop entry resolves `terminal`. It used to resolve
 *   `superseded` / `claim-rotated`, because the loop derived its release from a
 *   session-shaped mode whose default arm encoded "this run is unclaimed" — a
 *   premise `rundown run` falsifies for every default-stack root by minting a
 *   run-control claim for it. The loop now addresses the run it drove, so the
 *   claim survives as terminal evidence.
 * - The fenced completion resolves `terminal`, and did so throughout the
 *   cluster. It is the control: the fence already retained, and #793 made the
 *   loop-entry path agree with it rather than the other way round.
 *
 * The trigger for the previously defective path has to be an already-terminal
 * *loop entry*. A plain completion does not reach that release at all: the
 * fenced command mutation releases with retention and the loop returns before
 * the entry-time terminal check, so a test built on a plain completion would
 * have passed under both the old and the new code — for the wrong reason. A
 * delegation whose child runbook is not discoverable is the cheapest trigger:
 * it stops the run during initialization and re-enters the loop already
 * terminal.
 *
 * Both tests discharge #790's multi-process requirement inline rather than in a
 * third case: the run is one subprocess, `resolveClaim` reads the database from
 * this one, and the `rundown status --claim-id` assertion is a further
 * subprocess sharing nothing with the run but the database. A unit suite that
 * mocks the session boundary observes neither the retained claim nor the
 * tombstone surviving persistence; these do.
 */
describe('Terminal claim disposition at the resolution seam (#781)', () => {
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

  /**
   * The run the session would resolve for a later bare command, if any.
   *
   * The targeting half of a Run Release, which the claim resolution above
   * cannot see: a preserved claim and a run still resolving as the session
   * default are independent facts, and only asserting both distinguishes
   * "addressed" from "released nothing at all".
   */
  async function activeRunId(): Promise<string | undefined> {
    const session = new SessionService(new RunbookStateManager(workspace.cwd));
    return (await session.getActive())?.id;
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

  it('leaves an already-terminal loop entry resolving terminal', async () => {
    // THE FIX. `rundown run` mints a run-control claim for every default-stack
    // root, and the terminal loop entry addresses the run it drove — so the
    // claim stays as terminal evidence and its holder reads the run's stopped
    // outcome, rather than being told to re-claim a delegation that was never
    // issued.
    await writeUnresolvableDelegation();

    const run = runCli('run parent.runbook.md', workspace);
    const started = requireStartedRun(run.stdout);
    expect(parseJsonEvents(run.stdout).map((event) => event.type)).toContain('runbook_stopped');
    expect(
      parseJsonEvents(run.stdout).find((event) => event.type === 'runbook_stopped'),
    ).toMatchObject({ reason: 'delegation_resolution_failed' });

    // The precise disposition, which the CLI envelope does not carry.
    await expect(resolveClaim(started.claimId)).resolves.toMatchObject({
      status: 'terminal',
      lifecycle: 'stopped',
    });

    // And the targeting half: preserving the claim must not also leave the
    // finished run resolving as the session default for every later bare
    // command. Both facts move together only if the release actually ran.
    await expect(activeRunId()).resolves.toBeUndefined();

    // And what the orchestrator is actually told: the run's own outcome, at the
    // terminal exit code, naming the run the bearer controlled.
    const status = runCli(`status --claim-id ${started.claimId}`, workspace);
    expect(status.exitCode).toBe(0);
    expect(parseCliJsonObject(status.stdout)).toMatchObject({
      status: 'stopped',
      active: false,
      runId: started.runId,
    });
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
    await expect(activeRunId()).resolves.toBeUndefined();

    const status = runCli(`status --claim-id ${started.claimId}`, workspace);
    expect(status.exitCode).toBe(0);
    expect(parseCliJsonObject(status.stdout)).toMatchObject({
      status: 'completed',
      active: false,
      runId: started.runId,
    });
  });
});
