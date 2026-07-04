import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';
import { writeFile, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

describe('Inline linkage integration (rd run --step)', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write a parent runbook with two substeps and optional vars. */
  async function writeParentRunbook(
    vars?: Record<string, string | number | boolean>,
  ): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      ...(vars && { vars }),
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

  /** Helper: find child state in runs directory by scanning for parentLinkage. */
  async function findChildState(parentRunId: string): Promise<Record<string, unknown> | null> {
    const runsDir = workspace.statePath();
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

  describe('afterInit fresh state reload (race condition fix)', () => {
    it('passes parent artifact variables to inline child runtime variables and renders them', async () => {
      const schemaPath = join(workspace.cwd, 'schema.json');
      await writeFile(schemaPath, '{}');
      const canonicalSchemaPath = await realpath(schemaPath);
      await writeFile(
        join(workspace.cwd, 'parent.runbook.md'),
        `# Parent

## 1. Parent
- ARTIFACTS
  - ReviewSchemaPath "${schemaPath}"
- PASS COMPLETE

### 1.1 Child slot
`,
      );
      await writeFile(
        join(workspace.cwd, 'child.runbook.md'),
        `# Child

## 1. Render inherited artifact
- PASS COMPLETE

URI={{ artifact ReviewSchemaPath }}
PATH={{ path ReviewSchemaPath }}
`,
      );

      let result = await runCliInProcess(
        ['run', 'parent.runbook.md', '--prompted', '--allow-read', schemaPath],
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();

      result = await runCliInProcess(['run', 'child.runbook.md', '--step', '1.1'], workspace);
      if (result.exitCode !== 0) {
        throw new Error(`child run failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('URI=file://');
      expect(result.stdout).toContain(`PATH=${canonicalSchemaPath}`);

      const childState = await findChildState(parentState!.id);
      expect(childState).not.toBeNull();
      expect(childState!.templateVars).not.toHaveProperty('ReviewSchemaPath');
      expect((childState!.variables as Record<string, unknown>).ReviewSchemaPath).toMatchObject({
        kind: 'file-artifact-record',
        key: schemaPath,
      });
    });

    it('propagates inline child frontmatter outputs into parent variables and downstream rendering', async () => {
      const parentContent = [
        '---',
        'name: inline-outputs-parent',
        'inputs:',
        '  - resultKey',
        '---',
        '# Parent',
        '',
        '## 1. Review',
        '- PASS CONTINUE',
        '',
        '### 1.1 Inline child',
        'Child publishes resultKey.',
        '',
        '### 1.2 Verify',
        'After child: result is {{resultKey}}.',
        '',
        '## 2. Done',
        '- PASS COMPLETE',
        '',
        'Observed child result: {{resultKey}}.',
        '',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      const childContent = [
        '---',
        'name: inline-outputs-child',
        'inputs:',
        '  - resultKey',
        'outputs:',
        '  - resultKey',
        '---',
        '# Child',
        '',
        '## 1. Publish',
        '- PASS COMPLETE',
        '- FAIL STOP',
        '',
        'Publishing resultKey={{resultKey}}.',
        '',
        '```bash',
        'rd echo --result pass',
        '```',
        '',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'child.runbook.md'), childContent);

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      result = await runCliInProcess(
        [
          'run',
          'child.runbook.md',
          '--step',
          '1.1',
          '--input',
          'resultKey=published-value',
          '--text',
        ],
        workspace,
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `inline child run failed:\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
        );
      }
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      expect(childState!.lifecycle).toBe('completed');
      expect(childState!.finalVars).toEqual({ resultKey: 'published-value' });

      const parentAfter11 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter11).not.toBeNull();
      expect(parentAfter11!.step).toBe('1');
      expect(parentAfter11!.substep).toBe('2');
      expect(parentAfter11!.variables).toEqual(
        expect.objectContaining({ resultKey: 'published-value' }),
      );

      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('published-value');

      const parentAfter12 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter12).not.toBeNull();
      expect(parentAfter12!.step).toBe('2');
      expect(parentAfter12!.variables).toEqual(
        expect.objectContaining({ resultKey: 'published-value' }),
      );
    });

    it('auto-completing child marks substep as done in parent substepStates', async () => {
      // Behavioral test for the afterInit + completion propagation lifecycle.
      //
      // afterInit marks the substep as 'running', then the child completes
      // and propagateChildTerminal (inline path) marks it as 'done'. Since the
      // child auto-completes synchronously, the final observable state is 'done'.
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode -- sits at step 1
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      // Verify initial substepStates are all 'pending'
      const initialSubsteps = parentState!.substepStates ?? [];
      expect(initialSubsteps.length).toBe(2);
      expect(initialSubsteps.every((ss) => ss.status === 'pending')).toBe(true);

      // Run child targeting substep 1.1 -- afterInit marks it 'running',
      // then child completes and propagation marks it 'done'
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Load parent state and verify substep 1 reached 'done'
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();

      const substepStates = updatedParent!.substepStates ?? [];

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
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      // Run first child targeting substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Run second child targeting substep 1.2
      result = await runCliInProcess('run child.runbook.md --step 1.2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Load parent state and verify both substeps were marked
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();

      const substepStates = updatedParent!.substepStates ?? [];

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
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      // Run child with inline linkage to substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent should now be at substep 1.2 (child pass resolved 1.1)
      // Complete 1.2 to trigger aggregation
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });

    it('child stop propagates fail to parent substep', async () => {
      await writeParentRunbook();
      await writeFailingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Run child with inline linkage — child will fail and stop
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      // Child stopped → exit 1
      expect(result.exitCode).toBe(1);

      // Parent substep 1.1 should have a fail recorded.
      // Complete 1.2 to trigger aggregation — FAIL ANY STOP
      result = await runCliInProcess('pass --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });

    it('inline child fail exits zero when parent handles it with retry', async () => {
      await writeFile(
        join(workspace.cwd, 'parent.runbook.md'),
        `# Parent

## 1. Review

- PASS ALL CONTINUE
- FAIL ANY RETRY 1 CONTINUE

### 1.1 Inline gate

Run the inline gate.

## 2. Done

- PASS COMPLETE

Final step.
`,
      );
      await writeFile(
        join(workspace.cwd, 'child.runbook.md'),
        `# Child

## 1. Check

- PASS COMPLETE
- FAIL STOP

Check manually.
`,
      );

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      const parentRunId = (await getActiveState(workspace))!.id;

      result = await runCliInProcess('run child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      // Post-R1 an inline child is delegation-exposed (clause e): the runner
      // names the run it drives.
      result = await runCliInProcess(await withRunTarget(['fail'], workspace), workspace);
      expect(result.exitCode).toBe(0);

      const parentAfter = await readRunbookState(workspace, parentRunId);
      expect(parentAfter!.lifecycle).toBe('running');
      expect(parentAfter!.step).toBe('1');
      expect(parentAfter!.retryCount).toBe(1);
    });
  });

  describe('child state linkage', () => {
    it('child state has inlineLinkage pointing to parent', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Run auto-executing child with inline linkage to substep 1.2
      // Using 1.2 (not 1.1) so parentStepId='2' is unambiguously the substep ID
      result = await runCliInProcess('run child.runbook.md --step 1.2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Child completed and was popped — parent is active again.
      const childState = await findChildState(parentRunId);
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
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      // Run child with inline linkage targeting iteration 2 of substep 1.1
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Scan runs directory for the child state
      const childState = await findChildState(parentRunId);
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
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Run child targeting iteration 2, substep 1.1 (non-active frame)
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent state should have a SubstepState for frameKey "1|2" marked done
      const updated = await readRunbookState(workspace, parentRunId);
      expect(updated).not.toBeNull();
      if (!updated) throw new Error('Expected parent run state to exist');
      const substepStates = updated.substepStates ?? [];
      const targetEntry = substepStates.find((ss) => ss.id === '1' && ss.frameKey === '1|2');
      expect(targetEntry).toBeDefined();
      expect(targetEntry!.status).toBe('done');
      expect(targetEntry!.result).toBe('pass');
    });

    it('inline child allowed when active cursor advanced but targeting different iteration', async () => {
      await writeForParent();
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1, iteration 1, substep 1
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Advance the cursor in the active iteration past substep 1
      // by passing substep 1.1 and 1.2 in the active frame
      result = await runCliInProcess('pass --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --step 1.2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Now cursor is at substep 3 in iteration 1.
      // Targeting substep 1.1 in iteration 2 should succeed (different frame).
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2 --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('rejects re-execution of completed non-active FOR substep', async () => {
      await writeForParent();
      await writePassingChild();

      // Start parent in prompted mode — sits at step 1, iteration 1
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // First child targeting iteration 2, substep 1.1 — should succeed
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Second child targeting the same iteration 2, substep 1.1 — should be rejected
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 2 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });

    it('child inherits correct context.parent.index for non-active iteration', async () => {
      await writePassingChild();
      await writeForParent();

      // Start parent — sits at step 1, iteration 1
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Run child targeting iteration 3 (parent is at iteration 1)
      result = await runCliInProcess('run child.runbook.md --step 1.1 --index 3 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Find the child state and verify its templateVars
      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      // context.parent.index should be "3" (the target iteration), not "1" (the active)
      expect(templateVars['context.parent.index']).toBe('3');
    });
  });

  describe('error cases', () => {
    it('rejects --step without active parent runbook', async () => {
      await writePassingChild();

      const result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--step requires an active parent runbook');
    });

    it('rejects --step when step is not at frontier', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent — auto-executes past step 1
      const result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Try to link to step 2.1 (step 2 has no substeps, and step 2 is not current)
      const linkResult = await runCliInProcess('run child.runbook.md --step 2.1 --text', workspace);
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
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Advance parent to step 1 pass, then it should be at step 1
      // Try to link to step 1 (no substep qualifier, step has no substeps)
      result = await runCliInProcess('run child.runbook.md --step 1 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('RD-815');
      expect(result.stderr).toContain('no substeps');
    });

    it('preserves RundownError codes for delegation errors', async () => {
      await writePassingChild();
      await writeParentRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Target nonexistent step 9 — should get RD-801 (DELEGATION_STEP_NOT_FOUND)
      result = await runCliInProcess('run child.runbook.md --step 9 --text', workspace);
      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('RD-801');
    });

    it('rejects --step when substep cursor has advanced (drain path)', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Manually resolve substep 1.1 — drain advances cursor past it
      result = await runCliInProcess('pass --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      // Try to run with inline linkage to already-drained substep
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });

    it('rejects --step when substep status is done (defensive path)', async () => {
      await writeParentRunbook();
      await writePassingChild();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id;

      // Directly mark substep 1 as 'done' in persisted state — simulates a future
      // code path where completeSubstep() is wired into the CLI (e.g., delegation
      // completion marking substeps done). The cursor has NOT advanced, so only
      // the status === 'done' guard catches this.

      const statePath = join(workspace.statePath(), `${parentRunId}.json`);
      const stateData = JSON.parse(await readFile(statePath, 'utf-8'));
      const substeps = stateData.substepStates as Array<Record<string, unknown>>;
      const target = substeps.find((ss) => ss.id === '1');
      expect(target).toBeDefined();
      target!.status = 'done';
      target!.result = 'pass';
      await writeFile(statePath, JSON.stringify(stateData, null, 2));

      // Try to run with inline linkage to done substep
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('already resolved');
    });
  });

  describe('variable and context inheritance', () => {
    it('inline child inherits parent template vars', async () => {
      await writeParentRunbook({ Region: 'frontmatter-region' });
      await writePassingChild();

      let result = await runCliInProcess(
        'run --prompted parent.runbook.md --input Region=cli-region --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars.Region).toBe('cli-region');
    });

    it('inline child auto-executes when parent is prompted', async () => {
      // Regression: inline children must NOT inherit parent's prompted mode.
      // The child should auto-execute its commands, not wait for user input.
      await writeParentRunbook();
      await writePassingChild();

      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Child has auto-executing command — should complete, not wait
      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      expect(childState!.lifecycle).toBe('completed');
    });

    it('inline child state has context.parent vars', async () => {
      await writeParentRunbook({ AppName: 'rundown' });
      await writePassingChild();

      let result = await runCliInProcess(
        'run --prompted parent.runbook.md --input AppName=rundown --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      result = await runCliInProcess('run child.runbook.md --step 1.1 --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars['context.parent.vars.AppName']).toBe('rundown');
      expect(templateVars['context.parent.step']).toBeDefined();
    });

    it('CLI --input on inline child overrides inherited parent vars', async () => {
      await writeParentRunbook({ Region: 'us-west' });
      await writePassingChild();

      let result = await runCliInProcess(
        'run --prompted parent.runbook.md --input Region=us-west --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      // Pass --input to override the inherited Region
      result = await runCliInProcess(
        ['run', 'child.runbook.md', '--step', '1.1', '--input', 'Region=eu-central', '--text'],
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const childState = await findChildState(parentRunId);
      expect(childState).not.toBeNull();
      const templateVars = childState!.templateVars as Record<string, unknown>;
      expect(templateVars.Region).toBe('eu-central');
    });
  });

  it('bare pass still closes only the active inline unit and advances the parent normally', async () => {
    await writeFile(
      join(workspace.cwd, 'parent-pass-unit-local.runbook.md'),
      `# Parent Pass Unit Local

## 1. Compose
- PASS CONTINUE
- FAIL STOP

### 1.1 Inline child
Child slot.

### 1.2 Parent prompt
Parent continues here.

## 2. Done
- PASS COMPLETE
`,
    );
    await writeFile(
      join(workspace.cwd, 'child-pass-unit-local.runbook.md'),
      `# Child Pass Unit Local

## 1. Waiting
- PASS COMPLETE
- FAIL STOP

Waiting.
`,
    );

    await runCliInProcess('run --prompted parent-pass-unit-local.runbook.md', workspace);
    const parent = await getActiveState(workspace);
    await runCliInProcess('run child-pass-unit-local.runbook.md --step 1.1', workspace);
    const child = await getActiveState(workspace);

    // Post-R1 an inline child is delegation-exposed (clause e): the runner
    // names the run it drives; the close still targets only the active inline
    // unit and the parent advances normally.
    const result = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);

    expect(result.exitCode).toBe(0);
    const activeAfter = await getActiveState(workspace);
    const parentAfter = await readRunbookState(workspace, parent!.id);
    const childAfter = await readRunbookState(workspace, child!.id);
    // Session focus must return to the parent — a child left `completed` on disk
    // but still active in the session is exactly the activation regression this
    // scenario guards against.
    expect(activeAfter?.id).toBe(parent!.id);
    expect(parentAfter!.lifecycle).toBe('running');
    expect(parentAfter!.step).toBe('1');
    expect(parentAfter!.substep).toBe('2');
    expect(childAfter!.lifecycle).toBe('completed');
  });
});
