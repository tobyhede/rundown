import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
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
    const content = `## 1. Review
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Code review
Do code review.

## 2. Done
- PASS: COMPLETE

Final step.
`;
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  /** Helper: write a single-step child runbook (prompted). */
  async function writeChildRunbook(): Promise<void> {
    const content = `## 1. Execute
- PASS: COMPLETE
- FAIL: STOP

Run the child task.
`;
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Helper: extract delegation token from CLI output. */
  function extractToken(stdout: string): string {
    const match = /Token:\s*(rdtk_\S+)/.exec(stdout);
    if (!match) throw new Error(`No token found in output:\n${stdout}`);
    return match[1];
  }

  /** Helper: read resolvedCompletions from a run state file. */
  async function readResolvedCompletions(runId: string): Promise<Record<string, unknown>> {
    try {
      const statePath = join(workspace.cwd, '.claude', 'rundown', 'runs', `${runId}.json`);
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
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Get parent run ID
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1 to child runbook
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim the token — launches child runbook in prompted mode
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Verify child state has delegation linkage
      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      expect(childState!.delegation).toBeDefined();
      expect((childState!.delegation as Record<string, unknown>).parentRunId).toBe(parentRunId);

      // Pass the child step — should trigger propagation to parent
      result = runCli('pass', workspace);
      if (result.exitCode !== 0) {
        throw new Error(`rd pass failed: ${result.stdout}\n${result.stderr}`);
      }

      // After child completes, it should have variables.completed = true
      const childId = childState!.id as string;
      const finalChildState = await readRunbookState(workspace, childId);
      expect(finalChildState).not.toBeNull();
      expect(getVariables(finalChildState!).completed).toBe(true);

      // Verify: parent should have advanced past step 1 (single substep → PASS ALL → CONTINUE)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });
  });

  describe('2-level fail propagation', () => {
    it('child fail triggers parent STOP via FAIL ANY', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Fail the child step — should trigger fail propagation
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);

      // After child fails, parent should be stopped (FAIL ANY: STOP)
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
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Stop the child — should propagate fail to parent
      result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // After child is stopped, parent should be stopped (FAIL ANY: STOP)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).stopped).toBe(true);
    });
  });

  describe('3-level chain propagation', () => {
    it('child completion cascades through parent to grandparent', async () => {
      // Grandparent with substeps
      const grandparentContent = `## 1. Pipeline
- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Deploy
Deploy step.

### 1.2 Verify
Verify step.
`;
      await writeFile(join(workspace.cwd, 'grandparent.runbook.md'), grandparentContent);

      // Parent with a substep (required for completion/drain model)
      const parentContent = `## 1. Review
- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Task
Review the deployment.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      // Child with a single step
      await writeChildRunbook();

      // Start grandparent
      let result = runCli('run --prompted grandparent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id as string;

      // Delegate grandparent 1.1 to parent runbook
      result = runCli('delegate parent.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      // Claim — launches parent runbook (becomes active state)
      result = runCli(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);

      // Get parent run ID (now the active state after claim)
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.delegation).toBeDefined();
      const parentRunId = parentState!.id as string;

      // Delegate parent substep 1.1 to child runbook
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      // Claim — launches child runbook
      result = runCli(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);

      // Pass the child — should cascade:
      // child passes → parent substep 1.1 resolves → parent COMPLETE
      // → grandparent substep 1.1 resolves with pass
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Verify: parent should have completed (cascaded from child)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(getVariables(updatedParent!).completed).toBe(true);

      // Verify: grandparent was affected by the cascade.
      // The delegation completion for substep 1.1 was applied and consumed.
      // The grandparent either completed or advanced past substep 1.1.
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      const gpCompleted = getVariables(updatedGrandparent!).completed === true;
      const gpAdvanced = updatedGrandparent!.substep !== '1';
      expect(gpCompleted || gpAdvanced).toBe(true);
    });
  });

  describe('out-of-order completion', () => {
    it('substep 1.2 completes before 1.1 — completion stored but parent waits', async () => {
      // This test needs 2 substeps for out-of-order completion testing
      const twoSubstepParent = `## 1. Review
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Code review
Do code review.

### 1.2 Security review
Do security review.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), twoSubstepParent);
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate BOTH substeps
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = runCli('delegate child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      // Claim 1.2 first
      result = runCli(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);

      // Pass 1.2 first
      result = runCli('pass', workspace);
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
      result = runCli(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('pass', workspace);
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

  describe('edge cases', () => {
    it('handles completion when parent has no substep states', async () => {
      // Create a parent runbook without substeps
      const simpleParentContent = `## 1. Task
- PASS: COMPLETE
- FAIL: STOP

Do the task.
`;
      await writeFile(join(workspace.cwd, 'simple-parent.runbook.md'), simpleParentContent);

      // This scenario shouldn't normally happen with delegation, but test defensive handling
      // Start a simple parent that completes immediately
      const result = runCli('run simple-parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles propagation when parent is already completed', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();

      // Delegate substep 1.1
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Manually complete the parent before claiming
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Now claim and complete child - parent already done
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('pass', workspace);
      // Should succeed even though parent is already done
      expect(result.exitCode).toBe(0);
    });

    it('handles concurrent delegation completions gracefully', async () => {
      // This test needs 2 substeps for concurrent delegation
      const twoSubstepParent = `## 1. Review
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Code review
Do code review.

### 1.2 Security review
Do security review.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), twoSubstepParent);
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate both substeps
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token1 = extractToken(result.stdout);

      result = runCli('delegate child.runbook.md --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      const token2 = extractToken(result.stdout);

      // Claim both
      result = runCli(`claim ${token1}`, workspace);
      expect(result.exitCode).toBe(0);

      result = runCli(`claim ${token2}`, workspace);
      expect(result.exitCode).toBe(0);

      // Complete both in quick succession
      // First completion
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Second completion
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Both should complete successfully
    });

    it('handles pass command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = runCli('run --prompted child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id as string;

      // Pass should work normally without propagation
      result = runCli('pass', workspace);
      expect(result.exitCode).toBe(0);

      // Runbook completed and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(getVariables(finalState!).completed).toBe(true);
    });

    it('handles fail command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = runCli('run --prompted child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const childState = await getActiveState(workspace);
      expect(childState).not.toBeNull();
      const childRunId = childState!.id as string;

      // Fail triggers STOP transition → exit code 1
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);

      // Runbook stopped and was deactivated — read state by ID
      const finalState = await readRunbookState(workspace, childRunId);
      expect(finalState).not.toBeNull();
      expect(getVariables(finalState!).stopped).toBe(true);
    });

    it('handles stop command without delegation linkage', async () => {
      await writeChildRunbook();

      // Start a standalone child runbook (no parent)
      let result = runCli('run --prompted child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Stop should work normally without propagation
      result = runCli(['stop', 'User cancelled'], workspace);
      expect(result.exitCode).toBe(0);

      // State should be deleted
      const state = await getActiveState(workspace);
      expect(state).toBeNull();
    });
  });
});
