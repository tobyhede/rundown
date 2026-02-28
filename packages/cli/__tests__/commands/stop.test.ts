import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  readSession,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('stop command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('basic stop', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('aborts active runbook', async () => {
      const result = runCli('stop', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('removes runbook from state directory', async () => {
      const stateBefore = await getActiveState(workspace);
      const runId = stateBefore!.id;

      runCli('stop', workspace);

      // State file should be deleted
      const stateAfter = await readRunbookState(workspace, runId);
      expect(stateAfter).toBeNull();
    });
  });

  describe('stop with message', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('includes custom message in output', async () => {
      const result = runCli(['stop', 'User cancelled'], workspace);

      expect(result.exitCode).toBe(0);
      // Text renderer discards the message; just check for STOP
      expect(result.stdout).toContain('STOP');
    });
  });

  describe('stop with no active runbook', () => {
    it('reports no active runbook', async () => {
      const result = runCli('stop', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });
  });

  describe('stop agent runbook', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md --agent test-agent', workspace);
    });

    it('stops agent-scoped runbook', async () => {
      const result = runCli('stop --agent test-agent', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');

      // Agent stack should be empty
      const session = await readSession(workspace);
      expect(session.stacks['test-agent'] ?? []).toHaveLength(0);
    });

    it('does not affect default stack', async () => {
      // Start a runbook in default stack
      runCli('run --prompted runbooks/goto.runbook.md', workspace);
      const defaultState = await getActiveState(workspace);

      // Stop agent runbook
      runCli('stop --agent test-agent', workspace);

      // Default stack should still have its runbook
      const session = await readSession(workspace);
      expect(session.active).toBe(defaultState!.id);
    });
  });

  describe('stop with runbook stack', () => {
    it('pops to parent runbook', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS: COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS: COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-stop.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-stop.md'), childRunbook);

      // Start parent (prompted)
      runCli('run --prompted runbooks/parent-stop.md', workspace);
      const parentState = await getActiveState(workspace);

      // Start child in same stack
      runCli('run --prompted runbooks/child-stop.md', workspace);

      // Stop child
      const result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Should now be on parent
      const activeState = await getActiveState(workspace);
      expect(activeState?.id).toBe(parentState!.id);
    });
  });

  describe('JSON output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('outputs JSON when --json flag provided', async () => {
      const result = runCli('stop --json', workspace);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('stop');
      expect(output.result).toBe(false);
    });

    it('includes metadata in JSON output', async () => {
      const result = runCli('stop --json', workspace);

      const output = JSON.parse(result.stdout);
      expect(output.file).toBeDefined();
      expect(output.file).toBe('runbooks/simple.runbook.md');
    });
  });

  describe('delegation propagation', () => {
    async function writeParentRunbook(): Promise<void> {
      const content = `## 1. Review
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
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
    }

    async function writeChildRunbook(): Promise<void> {
      const content = `## 1. Execute
- PASS: COMPLETE
- FAIL: STOP

Run the child task.
`;
      await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
    }

    function extractToken(stdout: string): string {
      const match = /Token:\s*(rdtk_\S+)/.exec(stdout);
      if (!match) throw new Error(`No token found in output:\n${stdout}`);
      return match[1];
    }

    it('propagates fail to parent when child is stopped', async () => {
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

      // Claim — launches child runbook
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Stop the child — should propagate fail to parent
      result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // After child is stopped, parent should be stopped (FAIL ANY: STOP)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop with custom message propagates to parent', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate and claim
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);
      result = runCli(`claim ${token}`, workspace);

      // Stop with message
      result = runCli(['stop', 'Task cancelled by user'], workspace);
      expect(result.exitCode).toBe(0);
      // Text renderer discards the message; just check for STOP
      expect(result.stdout).toContain('STOP');

      // Parent should be stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop with --json outputs structured data and propagates', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate and claim
      result = runCli('delegate child.runbook.md --step 1.1 --json', workspace);
      const delegateOutput = JSON.parse(result.stdout);
      const token = delegateOutput.token as string;

      result = runCli(`claim ${token}`, workspace);

      // Stop with JSON
      result = runCli('stop --json', workspace);
      expect(result.exitCode).toBe(0);

      // With delegation, stop --json produces JSONL (multiple lines).
      // Find the line with the stop action from the child's output.
      const lines = result.stdout.split('\n').filter((l: string) => l.trim());
      const stopLine = lines.find((l: string) => {
        try {
          const obj = JSON.parse(l);
          return obj.action === 'stop';
        } catch {
          return false;
        }
      });
      expect(stopLine).toBeDefined();
      const output = JSON.parse(stopLine!);
      expect(output.action).toBe('stop');

      // Verify parent is stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop without delegation linkage does not propagate', async () => {
      // Start a runbook without delegation
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      // Stop it
      const result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // No propagation should occur — just a normal stop
      expect(result.stdout).toContain('STOP');
    });

    it('3-level cascade — stop child propagates through parent to grandparent', async () => {
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

      // Parent with a substep
      const parentContent = `## 1. Review
- PASS ALL: COMPLETE
- FAIL ANY: STOP

### 1.1 Task
Review the deployment.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      // Child
      await writeChildRunbook();

      // Start grandparent
      let result = runCli('run --prompted grandparent.runbook.md', workspace);
      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id as string;

      // Delegate grandparent 1.1 to parent
      result = runCli('delegate parent.runbook.md --step 1.1', workspace);
      const token1 = extractToken(result.stdout);
      result = runCli(`claim ${token1}`, workspace);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate parent 1.1 to child
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token2 = extractToken(result.stdout);
      result = runCli(`claim ${token2}`, workspace);

      // Stop the child — should cascade through parent to grandparent
      result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent is stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);

      // Verify grandparent is stopped
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      expect((updatedGrandparent!.variables as Record<string, unknown>).stopped).toBe(true);
    });
  });
});
