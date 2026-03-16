import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
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
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('aborts active runbook', async () => {
      const result = await runCliInProcess('stop', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
    });

    it('persists stopped state with STOP action metadata', async () => {
      const stateBefore = await getActiveState(workspace);
      const runId = stateBefore!.id;

      await runCliInProcess('stop', workspace);

      // State should be preserved (not deleted)
      const stateAfter = await readRunbookState(workspace, runId);
      expect(stateAfter).not.toBeNull();
      expect(stateAfter!.lastAction).toEqual({ type: 'STOP' });
      expect(stateAfter!.lastResult).toBe('fail');
      expect(stateAfter!.variables.stopped).toBe(true);
    });
  });

  describe('orphaned state recovery', () => {
    it('pops orphaned stack entry when state file is missing', async () => {
      // Start a runbook
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
      const state = await getActiveState(workspace);

      // Simulate corruption: delete state file but leave session stack intact
      const stateDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const stateId = state!.id as string;
      await unlink(join(stateDir, `${stateId}.json`));

      // Stop should clean up the orphaned stack entry
      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Session should be clean — stack entry popped
      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('pops orphaned stack entry when state file is corrupted', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
      const state = await getActiveState(workspace);

      // Write invalid JSON to state file
      const stateDir = join(workspace.cwd, '.claude', 'rundown', 'runs');
      const stateId = state!.id as string;
      await writeFile(join(stateDir, `${stateId}.json`), '{invalid');

      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      const session = await readSession(workspace);
      expect(session.active).toBeNull();
      expect(session.defaultStack).toHaveLength(0);
    });

    it('propagates unexpected getActive errors instead of swallowing', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
      const state = await getActiveState(workspace);
      const stateId = state!.id as string;
      const stateDir = join(workspace.cwd, '.claude', 'rundown', 'runs');

      // Write a legacy snapshot state that triggers a deliberate throw in load()
      const legacyState = { ...state, lastAction: { type: 'GOTO_NEXT' } };
      await writeFile(join(stateDir, `${stateId}.json`), JSON.stringify(legacyState));

      // After fix: stop should propagate the error, not silently clean up
      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/dynamic-step snapshots/i);
    });
  });

  describe('stop with message', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('includes custom message in output', async () => {
      const result = await runCliInProcess(['stop', 'User cancelled'], workspace);

      expect(result.exitCode).toBe(0);
      // Text renderer discards the message; just check for STOP
      expect(result.stdout).toContain('STOP');
    });
  });

  describe('stop with no active runbook', () => {
    it('reports no active runbook', async () => {
      const result = await runCliInProcess('stop', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });
  });

  describe('stop with runbook stack', () => {
    it('pops to parent runbook', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-stop.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-stop.md'), childRunbook);

      // Start parent (prompted)
      await runCliInProcess('run --prompted runbooks/parent-stop.md', workspace);
      const parentState = await getActiveState(workspace);

      // Start child in same stack
      await runCliInProcess('run --prompted runbooks/child-stop.md', workspace);

      // Stop child
      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Should now be on parent
      const activeState = await getActiveState(workspace);
      expect(activeState?.id).toBe(parentState!.id);
    });
  });

  describe('JSON output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('outputs JSON when --json flag provided', async () => {
      const result = await runCliInProcess('stop --json', workspace);

      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('stop');
    });

    it('includes metadata in JSON output', async () => {
      const result = await runCliInProcess('stop --json', workspace);

      const output = JSON.parse(result.stdout);
      expect(output.file).toBeDefined();
      expect(output.file).toBe('runbooks/simple.runbook.md');
    });
  });

  describe('delegation propagation', () => {
    async function writeParentRunbook(): Promise<void> {
      const content = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Code review
Do code review.

### 1.2 Security review
Do security review.

## 2. Done
- PASS COMPLETE

Final step.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
    }

    async function writeChildRunbook(): Promise<void> {
      const content = `## 1. Execute
- PASS COMPLETE
- FAIL STOP

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

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Stop the child — propagates fail to parent substep 1.1
      // Parent DEFER model: 1.1 fails, advance to 1.2
      result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Parent is now active at substep 1.2 — complete it to trigger aggregation
      result = await runCliInProcess('pass', workspace);

      // Aggregation: FAIL ANY (1.1 failed) triggers STOP
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop with custom message propagates to parent', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);
      result = await runCliInProcess(`claim ${token}`, workspace);

      // Stop with message — child stops, propagation to parent 1.1
      result = await runCliInProcess(['stop', 'Task cancelled by user'], workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');

      // Complete parent substep 1.2 to trigger aggregation
      result = await runCliInProcess('pass', workspace);

      // Parent should be stopped (FAIL ANY: STOP)
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop with --json outputs structured data and propagates', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = await runCliInProcess('delegate child.runbook.md --step 1.1 --json', workspace);
      const delegateOutput = JSON.parse(result.stdout);
      const token = delegateOutput.token as string;

      result = await runCliInProcess(`claim ${token}`, workspace);

      // Stop with JSON — child stops, propagation to parent 1.1
      result = await runCliInProcess('stop --json', workspace);
      expect(result.exitCode).toBe(0);

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

      // Complete parent substep 1.2 to trigger aggregation
      result = await runCliInProcess('pass', workspace);

      // Verify parent is stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);
    });

    it('stop without delegation linkage does not propagate', async () => {
      // Start a runbook without delegation
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      // Stop it
      const result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      // No propagation should occur — just a normal stop
      expect(result.stdout).toContain('STOP');
    });

    it('3-level cascade — stop child propagates through parent to grandparent', async () => {
      // Grandparent with 2 substeps
      const grandparentContent = `## 1. Pipeline
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Deploy
Deploy step.

### 1.2 Monitor
Monitor step.
`;
      await writeFile(join(workspace.cwd, 'grandparent.runbook.md'), grandparentContent);

      // Parent with 2 substeps
      const parentContent = `## 1. Review
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Task
Review the deployment.

### 1.2 Approve
Approve the deployment.
`;
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentContent);

      // Child (single step, no substeps)
      await writeChildRunbook();

      // Start grandparent
      let result = await runCliInProcess('run --prompted grandparent.runbook.md', workspace);
      const grandparentState = await getActiveState(workspace);
      const grandparentRunId = grandparentState!.id as string;

      // Delegate grandparent 1.1 to parent
      result = await runCliInProcess('delegate parent.runbook.md --step 1.1', workspace);
      const token1 = extractToken(result.stdout);
      result = await runCliInProcess(`claim ${token1}`, workspace);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate parent 1.1 to child
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      const token2 = extractToken(result.stdout);
      result = await runCliInProcess(`claim ${token2}`, workspace);

      // Stop the child — propagates fail to parent substep 1.1
      // Parent DEFER: 1.1 fail, advance to 1.2
      result = await runCliInProcess('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Parent is now active at substep 1.2 — complete it
      // Aggregation: FAIL ANY triggers STOP, propagates fail to grandparent 1.1
      // Grandparent DEFER: 1.1 fail, advance to 1.2
      result = await runCliInProcess('pass', workspace);

      // Verify parent is stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect((updatedParent!.variables as Record<string, unknown>).stopped).toBe(true);

      // Grandparent is now active at substep 1.2 — complete it
      // Aggregation: FAIL ANY triggers STOP
      result = await runCliInProcess('pass', workspace);

      // Verify grandparent is stopped
      const updatedGrandparent = await readRunbookState(workspace, grandparentRunId);
      expect(updatedGrandparent).not.toBeNull();
      expect((updatedGrandparent!.variables as Record<string, unknown>).stopped).toBe(true);
    });
  });
});
