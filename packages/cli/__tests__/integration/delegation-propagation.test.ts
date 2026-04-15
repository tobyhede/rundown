import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Delegation propagation integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write a parent runbook with substeps. */
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

  /** Helper: write a single-step child runbook (prompted). */
  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Helper: extract delegation token from CLI output. */
  function extractToken(stdout: string): string {
    const parsed = JSON.parse(stdout) as { token?: string };
    if (!parsed.token) throw new Error(`No token found in delegate output:\n${stdout}`);
    return parsed.token;
  }

  /** Helper: read resolvedCompletions from a run state file. */
  async function readResolvedCompletions(runId: string): Promise<Record<string, unknown>> {
    try {
      const statePath = join(workspace.statePath(), `${runId}.json`);
      const content = await readFile(statePath, 'utf-8');
      const state = JSON.parse(content) as Record<string, unknown>;
      const completions = state.resolvedCompletions;
      if (completions && typeof completions === 'object') {
        return completions as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Helper: extract variables from parsed state. */
  function getVariables(state: Record<string, unknown>): Record<string, unknown> {
    return (state.variables ?? {}) as Record<string, unknown>;
  }

  describe('2-level pass propagation', () => {
    it('child pass resolves parent substep and parent advances', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Get parent run ID
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1 to child runbook
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim the token — launches child runbook in prompted mode
      result = await runCliInProcess(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Verify child state has delegation linkage via parentLinkage
      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      expect(childState!.parentLinkage).toBeDefined();
      expect((childState!.parentLinkage as Record<string, unknown>).parentRunId).toBe(parentRunId);

      // Pass the child step — propagates pass to parent substep 1.1
      // DEFER model: parent advances to 1.2
      result = await runCliInProcess('pass --text', workspace);
      if (result.exitCode !== 0) {
        throw new Error(`rd pass failed: ${result.stdout}\n${result.stderr}`);
      }

      // After child completes, it should have variables.completed = true
      const childId = childState!.id as string;
      const finalChildState = await readRunbookState(workspace, childId);
      expect(finalChildState).not.toBeNull();
      expect(getVariables(finalChildState!).completed).toBe(true);

      // Parent is now at substep 1.2 — complete it to trigger aggregation
      // PASS ALL (both passed) → CONTINUE → step 2
      result = await runCliInProcess('pass --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
      expect(updatedParent!.substep).toBeUndefined();
    });
  });

  describe('2-level fail propagation', () => {
    it('child fail triggers parent STOP via FAIL ANY', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim
      result = await runCliInProcess(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Fail the child step — propagates fail to parent substep 1.1
      // DEFER model: parent advances to 1.2
      result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).toBe(1);

      // Parent is now at substep 1.2 — complete it to trigger aggregation
      // FAIL ANY (1.1 failed) → STOP
      result = await runCliInProcess('pass --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).stopped).toBe(true);
    });
  });

  describe('2-level stop propagation', () => {
    it('rd stop on child propagates fail to parent and parent stops', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim
      result = await runCliInProcess(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Stop the child — propagates fail to parent substep 1.1
      // DEFER model: parent advances to 1.2
      result = await runCliInProcess('stop --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent is now at substep 1.2 — complete it to trigger aggregation
      // FAIL ANY (1.1 failed) → STOP
      result = await runCliInProcess('pass --text', workspace);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).stopped).toBe(true);
    });
  });

  describe('3-level chain propagation', () => {
    it('child completion cascades through parent to grandparent', async () => {
      // Grandparent with 2 substeps
      const grandparentContent = createRunbook({
        title: 'Grandparent',
        steps: [
          {
            title: 'Pipeline',
            pass: 'COMPLETE',
            substeps: [
              { title: 'Deploy', content: 'Deploy step.' },
              { title: 'Verify', content: 'Verify step.' },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'grandparent.runbook.md'), grandparentContent);

      // Parent with 2 substeps
      const parentContent = createRunbook({
        title: 'Parent',
        steps: [
          {
            title: 'Review',
            pass: 'COMPLETE',
            substeps: [
              { title: 'Task', content: 'Review the deployment.' },
              { title: 'Approve', content: 'Approve the deployment.' },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      await writeChildRunbook();

      // Start grandparent
      let result = await runCliInProcess('run --prompted grandparent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id as string;

      // Delegate grandparent 1.1 to parent runbook
      result = await runCliInProcess('delegate parent.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.parentLinkage).toBeDefined();
      const parentRunId = parentState!.id as string;

      // Delegate parent substep 1.1 to child runbook
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Pass the child — propagates pass to parent substep 1.1
      // DEFER model: parent advances to 1.2
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent is at substep 1.2 — complete it
      // PASS ALL (both passed) → COMPLETE → propagates pass to grandparent 1.1
      // DEFER model: grandparent advances to 1.2
      result = await runCliInProcess('pass --text', workspace);

      // Verify parent completed
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).completed).toBe(true);

      // Grandparent is at substep 1.2 — complete it
      // PASS ALL (both passed) → COMPLETE
      result = await runCliInProcess('pass --text', workspace);

      // Verify grandparent completed
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      const gpCompleted = getVariables(updatedGrandparent!).completed === true;
      expect(gpCompleted).toBe(true);
    });
  });

  describe('out-of-order completion', () => {
    it('substep 1.2 completes before 1.1 — completion stored but parent waits', async () => {
      // This test needs 2 substeps for out-of-order completion testing
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate BOTH substeps
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = await runCliInProcess('delegate child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      // Claim 1.2 first
      result = await runCliInProcess(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Pass 1.2 first
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent cursor is at substep 1.1 (not yet resolved), so drain couldn't
      // consume the 1.2 completion. It should be stored in resolvedCompletions.
      const completions = await readResolvedCompletions(parentRunId);
      expect(Object.keys(completions).length).toBeGreaterThanOrEqual(1);

      // Parent should still be on step 1, substep 1 (waiting for 1.1)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('1');
      expect(updatedParent!.substep).toBe('1');

      // Now claim and complete 1.1
      result = await runCliInProcess(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // After both substeps resolve, parent should advance past step 1
      // Both completions consumed, resolvedCompletions empty
      const finalParent = await readRunbookState(workspace, parentRunId);
      expect(finalParent).not.toBeNull();
      // Parent should have moved to step 2 or completed
      // (PASS ALL: CONTINUE means it should advance to step 2)
      const step = finalParent!.step as string;
      const completed = getVariables(finalParent!).completed;
      // Either on step 2 or completed
      expect(step === '2' || completed === true).toBe(true);
    });
  });

  describe('3-child concurrent out-of-order completion', () => {
    it('3 delegated substeps completed in reverse order — parent completes after all resolve', async () => {
      // Parent with 3 substeps
      const tripleParentContent = createRunbook({
        title: 'Triple Parent',
        steps: [
          {
            title: 'Pipeline',
            pass: 'COMPLETE',
            substeps: [
              { title: 'Task A', content: 'Task A.' },
              { title: 'Task B', content: 'Task B.' },
              { title: 'Task C', content: 'Task C.' },
            ],
          },
        ],
      });
      await writeFile(join(workspace.cwd, 'triple-parent.runbook.md'), tripleParentContent);
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess(
        'run --prompted triple-parent.runbook.md --text',
        workspace,
      );
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate all 3 substeps
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = await runCliInProcess('delegate child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      result = await runCliInProcess('delegate child.runbook.md --step 1.3', workspace);
      expect(result.exitCode).toBe(0);
      const token3 = extractToken(result.stdout);

      // Complete children in reverse order: 3, 2, 1
      result = await runCliInProcess(`claim ${token3} --text`, workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent should still be waiting (1.1 not yet resolved)
      const parentAfter3 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter3).not.toBeNull();
      expect(parentAfter3!.step).toBe('1');

      result = await runCliInProcess(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Parent should still be waiting (1.1 not yet resolved)
      const parentAfter2 = await readRunbookState(workspace, parentRunId);
      expect(parentAfter2).not.toBeNull();
      expect(parentAfter2!.step).toBe('1');

      result = await runCliInProcess(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // After all 3 resolve, parent should complete (PASS ALL: COMPLETE)
      const finalParent = await readRunbookState(workspace, parentRunId);
      expect(finalParent).not.toBeNull();
      expect(getVariables(finalParent!).completed).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles completion when parent has no substep states', async () => {
      // Create a parent runbook without substeps
      const simpleParentContent = createRunbook({
        title: 'Simple Parent',
        steps: [{ title: 'Task', pass: 'COMPLETE', fail: 'STOP', content: 'Do the task.' }],
      });
      await writeFile(join(workspace.cwd, 'simple-parent.runbook.md'), simpleParentContent);

      // This scenario shouldn't normally happen with delegation, but test defensive handling
      // Start a simple parent that completes immediately
      const result = await runCliInProcess('run simple-parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles propagation when parent is already completed', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();

      // Delegate substep 1.1
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Manually complete the parent before claiming
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Now claim and complete child - parent already done
      result = await runCliInProcess(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess('pass --text', workspace);
      // Should succeed even though parent is already done
      expect(result.exitCode).toBe(0);
    });

    it('handles concurrent delegation completions gracefully', async () => {
      // This test needs 2 substeps for concurrent delegation
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate both substeps
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = await runCliInProcess('delegate child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      // Claim both
      result = await runCliInProcess(`claim ${token1} --text`, workspace);
      expect(result.exitCode).toBe(0);

      result = await runCliInProcess(`claim ${token2} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Complete both in quick succession
      // First completion
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Second completion
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Both should complete successfully
    });

    it('handles pass command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id as string;

      // Pass should work normally without propagation
      result = await runCliInProcess('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      // Runbook completed and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(getVariables(finalState!).completed).toBe(true);
    });

    it('handles fail command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id as string;

      // Fail triggers STOP transition → exit code 1
      result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).toBe(1);

      // Runbook stopped and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(getVariables(finalState!).stopped).toBe(true);
    });

    it('handles stop command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = await runCliInProcess('run --prompted child.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Stop should work normally without propagation
      result = await runCliInProcess(['stop', 'User cancelled', '--text'], workspace);
      expect(result.exitCode).toBe(0);

      // State should be deleted
      const state = await getActiveState(workspace);
      expect(state).toBeNull();
    });
  });
});
