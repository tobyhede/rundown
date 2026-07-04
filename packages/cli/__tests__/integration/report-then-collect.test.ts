import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  findActionOutput,
  getActiveState,
  parseConcatenatedJson,
  runCliInProcess,
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
            { title: 'Child work', delegate: true, runbooks: ['runbooks/child.runbook.md'] },
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
    const token = parent.substepStates?.[0]?.delegation?.token;
    if (!token) throw new Error('Expected delegation token for child claim.');
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

  it.each([
    'pass',
    'fail',
    'delegate',
  ])('refuses run-targeted bare-shaped rd %s while a reported outcome is uncollected', async (intent) => {
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
  });

  it('an explicit rd collect releases the pending state and advancing resumes', async () => {
    await pendingParent();

    const collected = await runCliInProcess(await withRunTarget(['collect'], workspace), workspace);
    expect(collected.exitCode).toBe(0);

    const advanced = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
    expect(advanced.exitCode).toBe(0);
    expect(emittedCodes(advanced.stdout)).not.toContain('DELEGATION_COLLECTION_PENDING');
  }, 30_000);
});
