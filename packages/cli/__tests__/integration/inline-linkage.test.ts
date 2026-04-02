import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Inline linkage integration (rd run --step)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write a parent runbook with two substeps. */
  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Code review', content: 'Do code review.' },
            { title: 'Security review', content: 'Do security review.' },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Helper: write a single-step auto-executing child that passes. */
  async function writePassingChild(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Helper: write a single-step auto-executing child that fails and stops. */
  async function writeFailingChild(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [
        { title: 'Execute', pass: 'COMPLETE', fail: 'STOP', command: 'rd echo --result fail' },
      ],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Helper: extract variables from parsed state. */
  function getVariables(state: Record<string, unknown>): Record<string, unknown> {
    return (state.variables ?? {}) as Record<string, unknown>;
  }

  describe('auto-executing child propagation', () => {
    it('child pass propagates to parent substep and parent advances', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Run child with inline linkage to substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Parent should now be at substep 1.2 (child pass resolved 1.1)
      // Complete 1.2 to trigger aggregation
      result = await runCliInProcess('pass', workspace);
      expect(result.exitCode).toBe(0);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });

    it('child stop propagates fail to parent substep', async () => {
      await writeParentRunbook();
      await writeFailingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Run child with inline linkage — child will fail and stop
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      // Child stopped → exit 1
      expect(result.exitCode).toBe(1);

      // Parent substep 1.1 should have a fail recorded.
      // Complete 1.2 to trigger aggregation — FAIL ANY STOP
      result = await runCliInProcess('pass', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).stopped).toBe(true);
    });
  });

  describe('child state linkage', () => {
    it('child state has inlineLinkage pointing to parent', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Run auto-executing child with inline linkage
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Child completed and was popped — parent is active again.
      // Load the child state by scanning runs directory for the non-parent state.
      const { readdir, readFile: rf } = await import('node:fs/promises');
      const runsDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const files = await readdir(runsDir);
      const stateFiles = files.filter((f) => f.endsWith('.json') && f !== 'session.json');

      let childState: Record<string, unknown> | null = null;
      for (const f of stateFiles) {
        const content = JSON.parse(await rf(join(runsDir, f), 'utf-8')) as Record<string, unknown>;
        if (content.id !== parentRunId && content.inlineLinkage) {
          childState = content;
          break;
        }
      }

      expect(childState).not.toBeNull();
      const linkage = childState!.inlineLinkage as Record<string, unknown>;
      expect(linkage.kind).toBe('inline');
      expect(linkage.parentRunId).toBe(parentRunId);
      expect(linkage.parentStepId).toBe('1');
    });
  });

  describe('error cases', () => {
    it('rejects --step without active parent runbook', async () => {
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--step requires an active parent runbook');
    });

    it('rejects --step when step is not at frontier', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent — auto-executes past step 1
      const result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Try to link to step 2.1 (step 2 has no substeps, and step 2 is not current)
      const linkResult = await runCliInProcess('run child.runbook.md --step 2.1', workspace);
      expect(linkResult.exitCode).toBe(1);
    });

    it('rejects --step when substep is already resolved', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Manually resolve substep 1.1
      result = await runCliInProcess('pass --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Try to run with inline linkage to already-resolved substep
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });
  });
});
