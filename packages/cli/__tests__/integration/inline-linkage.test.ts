import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, readdir, readFile } from 'node:fs/promises';
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

  describe('afterInit fresh state reload (race condition fix)', () => {
    it('auto-completing child marks substep as done in parent substepStates', async () => {
      // Behavioral test for the afterInit + completion propagation lifecycle.
      //
      // afterInit marks the substep as 'running', then the child completes
      // and handleParentCompletion marks it as 'done'. Since the child
      // auto-completes synchronously, the final observable state is 'done'.
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode -- sits at step 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Verify initial substepStates are all 'pending'
      const initialSubsteps = (parentState!.substepStates ?? []) as Array<{
        id: string;
        status: string;
      }>;
      expect(initialSubsteps.length).toBe(2);
      expect(initialSubsteps.every((ss) => ss.status === 'pending')).toBe(true);

      // Run child targeting substep 1.1 -- afterInit marks it 'running',
      // then child completes and propagation marks it 'done'
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Load parent state and verify substep 1 reached 'done'
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();

      const substepStates = (updatedParent!.substepStates ?? []) as Array<{
        id: string;
        status: string;
        result?: string;
      }>;

      const ss1 = substepStates.find((ss) => ss.id === '1');
      expect(ss1).toBeDefined();
      expect(ss1!.status).toBe('done');
      expect(ss1!.result).toBe('pass');
    });

    it('sequential children both mark their respective substeps as done', async () => {
      // Verify that two sequential inline children targeting different
      // substeps both get their substep marked as 'done' after completion.
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [
              { title: 'Alpha review', content: 'Do alpha review.' },
              { title: 'Beta review', content: 'Do beta review.' },
              { title: 'Gamma review', content: 'Do gamma review.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Run first child targeting substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Run second child targeting substep 1.2
      result = await runCliInProcess('run child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);

      // Load parent state and verify both substeps were marked
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();

      const substepStates = (updatedParent!.substepStates ?? []) as Array<{
        id: string;
        status: string;
      }>;

      const ss1 = substepStates.find((ss) => ss.id === '1');
      const ss2 = substepStates.find((ss) => ss.id === '2');
      const ss3 = substepStates.find((ss) => ss.id === '3');
      expect(ss1).toBeDefined();
      expect(ss2).toBeDefined();
      expect(ss3).toBeDefined();
      expect(ss1!.status).toBe('done');
      expect(ss2!.status).toBe('done');
      expect(ss3!.status).toBe('pending');
    });
  });

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

      // Run auto-executing child with inline linkage to substep 1.2
      // Using 1.2 (not 1.1) so parentStepId='2' is unambiguously the substep ID
      result = await runCliInProcess('run child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);

      // Child completed and was popped — parent is active again.
      // Load the child state by scanning runs directory for the non-parent state.

      const runsDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const files = await readdir(runsDir);
      const stateFiles = files.filter((f) => f.endsWith('.json') && f !== 'session.json');

      let childState: Record<string, unknown> | null = null;
      for (const f of stateFiles) {
        const content = JSON.parse(await readFile(join(runsDir, f), 'utf-8')) as Record<
          string,
          unknown
        >;
        if (content.id !== parentRunId && content.parentLinkage) {
          childState = content;
          break;
        }
      }

      expect(childState).not.toBeNull();
      const linkage = childState!.parentLinkage as Record<string, unknown>;
      expect(linkage.kind).toBe('inline');
      expect(linkage.parentRunId).toBe(parentRunId);
      expect(linkage.parentStepId).toBe('2');
      expect(linkage.parentFrameKey).toBeDefined();
      expect(linkage.parentEntry).toBeDefined();
    });
  });

  describe('FOR-loop inline linkage', () => {
    it('child state carries iteration info in parentFrameKey', async () => {
      // Parent runbook with a FOR loop step containing substeps
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Process',
            for: { variable: 'i', start: 1, end: 3 },
            pass: 'CONTINUE',
            substeps: [
              { title: 'Handle item', content: 'Handle item {{i}}.' },
              { title: 'Verify item', content: 'Verify item {{i}}.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Run child with inline linkage targeting iteration 2 of substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(0);

      // Scan runs directory for the child state

      const runsDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const files = await readdir(runsDir);
      const stateFiles = files.filter((f) => f.endsWith('.json') && f !== 'session.json');

      let childState: Record<string, unknown> | null = null;
      for (const f of stateFiles) {
        const content = JSON.parse(await readFile(join(runsDir, f), 'utf-8')) as Record<
          string,
          unknown
        >;
        if (content.id !== parentRunId && content.parentLinkage) {
          childState = content;
          break;
        }
      }

      expect(childState).not.toBeNull();
      const linkage = childState!.parentLinkage as Record<string, unknown>;
      expect(linkage.kind).toBe('inline');
      expect(linkage.parentRunId).toBe(parentRunId);
      expect(linkage.parentFrameKey).toBe('1|2');
    });
  });

  describe('FOR-loop frame-scoped fixes', () => {
    /** Helper: write a FOR parent with substeps for frame-scoped tests. */
    async function writeForParent(): Promise<void> {
      const content = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Process',
            for: { variable: 'i', start: 1, end: 3 },
            pass: 'CONTINUE',
            substeps: [
              { title: 'Handle item', content: 'Handle item {{i}}.' },
              { title: 'Verify item', content: 'Verify item {{i}}.' },
              { title: 'Finish item', content: 'Finish item {{i}}.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
    }

    it('inline child targeting non-active FOR iteration creates SubstepState entry', async () => {
      await writeForParent();
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1, iteration 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Run child targeting iteration 2, substep 1.1 (non-active frame)
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(0);

      // Parent state should have a SubstepState for frameKey "1|2" marked done
      const updated = await readRunbookState(workspace, parentRunId);
      const substepStates = (updated!.substepStates ?? []) as Array<{
        id: string;
        frameKey: string;
        status: string;
        result?: string;
      }>;
      const targetEntry = substepStates.find((ss) => ss.id === '1' && ss.frameKey === '1|2');
      expect(targetEntry).toBeDefined();
      expect(targetEntry!.status).toBe('done');
      expect(targetEntry!.result).toBe('pass');
    });

    it('inline child allowed when active cursor advanced but targeting different iteration', async () => {
      await writeForParent();
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1, iteration 1, substep 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Advance the cursor in the active iteration past substep 1
      // by passing substep 1.1 and 1.2 in the active frame
      result = await runCliInProcess('pass --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --step 1.2', workspace);
      expect(result.exitCode).toBe(0);

      // Now cursor is at substep 3 in iteration 1.
      // Targeting substep 1.1 in iteration 2 should succeed (different frame).
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('rejects re-execution of completed non-active FOR substep', async () => {
      await writeForParent();
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1, iteration 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // First child targeting iteration 2, substep 1.1 — should succeed
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(0);

      // Second child targeting the same iteration 2, substep 1.1 — should be rejected
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });

    it('child inherits correct context.parent.index for non-active iteration', async () => {
      await writePassingChild();
      await writeForParent();

      // Start parent — sits at step 1, iteration 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Run child targeting iteration 3 (parent is at iteration 1)
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 3', workspace);
      expect(result.exitCode).toBe(0);

      // Find the child state and verify its templateVars
      const runsDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const files = await readdir(runsDir);
      const stateFiles = files.filter((f) => f.endsWith('.json') && f !== 'session.json');

      let childState: Record<string, unknown> | null = null;
      for (const f of stateFiles) {
        const content = JSON.parse(await readFile(join(runsDir, f), 'utf-8')) as Record<
          string,
          unknown
        >;
        if (content.id !== parentRunId && content.parentLinkage) {
          childState = content;
          break;
        }
      }

      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      // context.parent.index should be "3" (the target iteration), not "1" (the active)
      expect(templateVars['context.parent.index']).toBe('3');
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

    it('rejects --step targeting a step with no substeps', async () => {
      // Parent step 2 ("Done") has no substeps — inline linkage should be rejected
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          { title: 'Setup', pass: 'CONTINUE', command: 'rd echo --result pass' },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Advance parent to step 1 pass, then it should be at step 1
      // Try to link to step 1 (no substep qualifier, step has no substeps)
      result = await runCliInProcess('run child.runbook.md --step 1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RD-815');
      expect(result.stderr).toContain('no substeps');
    });

    it('preserves RundownError codes for delegation errors', async () => {
      await writePassingChild();
      await writeParentRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Target nonexistent step 9 — should get RD-801 (DELEGATION_STEP_NOT_FOUND)
      result = await runCliInProcess('run child.runbook.md --step 9', workspace);
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('RD-801');
    });

    it('rejects --step when substep cursor has advanced (drain path)', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Manually resolve substep 1.1 — drain advances cursor past it
      result = await runCliInProcess('pass --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Try to run with inline linkage to already-drained substep
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });

    it('rejects --step when substep status is done (defensive path)', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Directly mark substep 1 as 'done' in persisted state — simulates a future
      // code path where completeSubstep() is wired into the CLI (e.g., delegation
      // completion marking substeps done). The cursor has NOT advanced, so only
      // the status === 'done' guard catches this.

      const statePath = join(workspace.cwd, '.claude', 'rundown', 'runs', `${parentRunId}.json`);
      const stateData = JSON.parse(await readFile(statePath, 'utf-8'));
      const substeps = stateData.substepStates as Array<Record<string, unknown>>;
      const target = substeps.find((ss) => ss.id === '1');
      expect(target).toBeDefined();
      target!.status = 'done';
      target!.result = 'pass';
      await writeFile(statePath, JSON.stringify(stateData, null, 2));

      // Try to run with inline linkage to done substep
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });
  });

  describe('variable and context inheritance', () => {
    /** Helper: find child state in runs directory. */
    async function findChildState(parentRunId: string): Promise<Record<string, unknown> | null> {
      const runsDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const files = await readdir(runsDir);
      const stateFiles = files.filter((f) => f.endsWith('.json') && f !== 'session.json');

      for (const f of stateFiles) {
        const content = JSON.parse(await readFile(join(runsDir, f), 'utf-8')) as Record<
          string,
          unknown
        >;
        if (content.id !== parentRunId && content.parentLinkage) {
          return content;
        }
      }
      return null;
    }

    it('inline child inherits parent template vars', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        vars: { Region: 'us-west' },
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [
              { title: 'First', content: 'First task.' },
              { title: 'Second', content: 'Second task.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars.Region).toBe('us-west');
    });

    it('inline child auto-executes when parent is prompted', async () => {
      // Regression: inline children must NOT inherit parent's prompted mode.
      // The child should auto-execute its commands, not wait for user input.
      await writeParentRunbook();
      await writePassingChild();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Child has auto-executing command — should complete, not wait
      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const variables = (childState!.variables ?? {}) as Record<string, unknown>;
      expect(variables.completed).toBe(true);
    });

    it('inline child state has context.parent vars', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        vars: { AppName: 'rundown' },
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [
              { title: 'First', content: 'First task.' },
              { title: 'Second', content: 'Second task.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars['context.parent.vars.AppName']).toBe('rundown');
      expect(templateVars['context.parent.step']).toBeDefined();
    });

    it('CLI --var on inline child overrides inherited parent vars', async () => {
      const parentContent = createRunbook({
        title: 'Parent',
        vars: { Region: 'us-west' },
        steps: [
          {
            title: 'Review',
            pass: 'CONTINUE',
            substeps: [
              { title: 'First', content: 'First task.' },
              { title: 'Second', content: 'Second task.' },
            ],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);
      await writePassingChild();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Pass --var to override the inherited Region
      result = await runCliInProcess(
        ['run', 'child.runbook.md', '--step', '1.1', '--var', 'Region=eu-central'],
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars.Region).toBe('eu-central');
    });
  });
});
