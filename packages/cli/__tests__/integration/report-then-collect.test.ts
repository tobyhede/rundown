import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  findActionOutput,
  findFrontierInEvents,
  getActiveState,
  parseConcatenatedJson,
  runCliInProcess,
  requireFrontierToken,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';

/**
 * Report-then-collect (Plan 5), single delegation level.
 *
 * After a *real* delegated close leaves the (single) delegating run collection
 * pending, every bare advancing intent — `pass`, `fail`, and `delegate` — is
 * refused with `DELEGATION_COLLECTION_PENDING` until an explicit `rd collect`.
 * RD-819 caps delegation at one level, so there is no N-level / middle-node case.
 */
describe('report-then-collect (single delegation level)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeRunbooks(): Promise<void> {
    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate child',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Child work',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
          ],
        },
        { title: 'Promote', pass: 'COMPLETE' },
      ],
    });
    // Child WITHOUT a command so claiming launches a waiting run; the explicit
    // `rd complete --claim-id` drives the close → report.
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Work', pass: 'COMPLETE' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
  }

  /**
   * Start a parent that DELEGATEs one substep, claim + close the child so the
   * parent is left collection pending. Leaves the workspace in that state.
   */
  async function pendingParent(): Promise<void> {
    await writeRunbooks();
    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const parent = await getActiveState(workspace);
    if (!parent) throw new Error('Expected active parent state.');
    const token = requireFrontierToken(start.stdout, '1.1');
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const close = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(close.exitCode).toBe(0);
  }

  // A refused advance emits a single error envelope; a successful (or
  // differently-failing) one may emit concatenated events. Scan every emitted
  // object's `code` so the assertion is robust to either shape.
  function emittedCodes(stdout: string): (string | undefined)[] {
    return parseConcatenatedJson(stdout).map((o) => (o as { code?: string }).code);
  }

  it.each(['pass', 'fail', 'delegate'])(
    'refuses run-targeted bare-shaped rd %s while a reported outcome is uncollected',
    async (intent) => {
      await pendingParent();
      // Post-R1 a fully bare mutation is refused earlier by the role gate
      // (ACTOR_CONTEXT_REQUIRED); the collection-pending guard is pinned on the
      // named-authority form (bare-shaped: no --step/--claim-id).
      const bare = await runCliInProcess(intent, workspace);
      expect(bare.exitCode).toBe(1);
      expect(emittedCodes(bare.stdout)).toContain('ACTOR_CONTEXT_REQUIRED');

      const blocked = await runCliInProcess(await withRunTarget([intent], workspace), workspace);
      expect(blocked.exitCode).toBe(1);
      expect(emittedCodes(blocked.stdout)).toContain('DELEGATION_COLLECTION_PENDING');
    },
  );

  /**
   * Parent whose collected DELEGATE step is followed by ordinary loop work and
   * then a SECOND DELEGATE step.
   *
   * The command step in the middle is what forces the continuation through
   * `runExecutionLoop`: without it the collect drain lands directly on the
   * frontier and core's own re-entry projection covers it. With it, the loop
   * owns both gates — machine-owned issuance when the command transition enters
   * step 3, and frontier projection on the following turn.
   */
  async function writeContinuingRunbooks(): Promise<void> {
    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate first',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'First child',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
          ],
        },
        {
          title: 'Local work',
          pass: 'CONTINUE',
          command: 'rd echo --result pass',
        },
        {
          title: 'Delegate second',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Second child',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
          ],
        },
        { title: 'Promote', pass: 'COMPLETE' },
      ],
    });
    const childContent = createRunbook({
      title: 'Child',
      steps: [{ title: 'Work', pass: 'COMPLETE' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
  }

  it('collect hands the collecting run to progression for its NEXT delegation frontier', async () => {
    await writeContinuingRunbooks();
    const start = await runCliInProcess('run runbooks/parent.runbook.md --allow-all', workspace);
    expect(start.exitCode).toBe(0);

    const token = requireFrontierToken(start.stdout, '1.1');
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);
    const close = await runCliInProcess(['complete', '--claim-id', claimId], workspace);
    expect(close.exitCode).toBe(0);

    // The collector presents the run-control bearer that owns the collecting
    // run — the same authority `delegate-from-run` is granted to — so the
    // continuation it drives has the authority to issue step 3's frontier.
    const collected = await runCliInProcess(
      [...(await withRunTarget(['collect'], workspace)), '--allow-all'],
      workspace,
    );
    expect(collected.exitCode).toBe(0);
    expect(emittedCodes(collected.stdout)).not.toContain('ACTOR_CONTEXT_REQUIRED');

    // The continuation reached the second DELEGATE step and issued its frontier.
    expect(requireFrontierToken(collected.stdout, '3.1')).toMatch(/^rdtk_/);

    const parent = await getActiveState(workspace);
    expect(parent).toMatchObject({
      lifecycle: 'running',
      step: '3',
      substep: '1',
    });
  }, 30_000);

  it('still refuses RD-819 when a delegated CHILD reaches a DELEGATE step under its own bearer', async () => {
    // RD-819 is a property of the run's linkage, not of who holds a credential:
    // widening the collector's continuation must not let a claimed child fan out.
    const parentContent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Delegate child',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Child work',
              delegate: true,
              runbooks: ['runbooks/child.runbook.md'],
            },
          ],
        },
        { title: 'Promote', pass: 'COMPLETE' },
      ],
    });
    // The child itself authors a DELEGATE step — forbidden for a claimed child.
    const childContent = createRunbook({
      title: 'Child',
      steps: [
        { title: 'Work', pass: 'CONTINUE' },
        {
          title: 'Fan out again',
          pass: 'COMPLETE',
          substeps: [
            {
              title: 'Grandchild',
              delegate: true,
              runbooks: ['runbooks/leaf.runbook.md'],
            },
          ],
        },
      ],
    });
    const leafContent = createRunbook({
      title: 'Leaf',
      steps: [{ title: 'Work', pass: 'COMPLETE' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent.runbook.md'), parentContent);
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);
    await writeFile(join(workspace.cwd, 'runbooks', 'leaf.runbook.md'), leafContent);
    await writeFile(join(workspace.runbooksDir(), 'leaf.runbook.md'), leafContent);

    const start = await runCliInProcess('run --prompted runbooks/parent.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    const token = requireFrontierToken(start.stdout, '1.1');
    const claim = await runCliInProcess(`claim ${token}`, workspace);
    expect(claim.exitCode).toBe(0);
    const claimId = String(findActionOutput(claim.stdout)!.claim_id);

    // The child advances under its OWN verified bearer into its DELEGATE step.
    const advanced = await runCliInProcess(['pass', '--claim-id', claimId], workspace);

    expect(advanced.exitCode).toBe(1);
    expect(findActionOutput(advanced.stdout)).toMatchObject({
      command: 'pass',
      action: 'stop',
      stopped: true,
      error: 'Nested delegation forbidden',
    });
    // No credential was minted for the forbidden fan-out — neither as a frontier
    // on an emitted event nor as a bare bearer anywhere in the output.
    expect(findFrontierInEvents(parseConcatenatedJson(advanced.stdout))).toBeUndefined();
    expect(advanced.stdout).not.toMatch(/rdtk_/);
  }, 30_000);

  it('an explicit rd collect releases the pending state and advancing resumes', async () => {
    await pendingParent();

    const collected = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
    expect(collected.exitCode).toBe(0);

    const advanced = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(advanced.exitCode).toBe(0);
    expect(emittedCodes(advanced.stdout)).not.toContain('DELEGATION_COLLECTION_PENDING');
  }, 30_000);
});
