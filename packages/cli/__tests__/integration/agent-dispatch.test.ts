import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Agent dispatch integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeChildRunbook(ws: TestWorkspace, name: string): Promise<void> {
    const content = `## 1. Execute
- PASS: COMPLETE

Do the work.
`;
    await writeFile(join(ws.cwd, name), content);
  }

  // ===========================================================================
  // Group 1: Resolved Completions — Out-of-Order
  // ===========================================================================
  describe('resolved completions — out-of-order', () => {
    async function writeReviewRunbook(ws: TestWorkspace): Promise<void> {
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
      await writeFile(join(ws.cwd, 'review.runbook.md'), content);
    }

    it('out-of-order pass — non-cursor agent recorded, cursor agent drains both', async () => {
      await writeReviewRunbook(workspace);

      // Start runbook at substep 1.1
      let result = runCli('run --prompted review.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Queue substep 1.1 and bind agent-1
      result = runCli('run --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Queue substep 1.2 and bind agent-2
      result = runCli('run --step 1.2', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Non-cursor pass (1.2): recorded but not drained yet
      result = runCli('pass --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('recorded');

      // Cursor match pass (1.1): drains 1.1 + 1.2, advances to step 2
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('out-of-order fail — recorded fail drains to STOP', async () => {
      await writeReviewRunbook(workspace);

      // Start runbook at substep 1.1
      expect(runCli('run --prompted review.runbook.md', workspace).exitCode).toBe(0);

      // Queue substep 1.1 and bind agent-1
      expect(runCli('run --step 1.1', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-1', workspace).exitCode).toBe(0);

      // Queue substep 1.2 and bind agent-2
      expect(runCli('run --step 1.2', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-2', workspace).exitCode).toBe(0);

      // Non-cursor fail (1.2): recorded
      let result = runCli('fail --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('recorded');

      // Cursor pass (1.1): drains, then 1.2 fail → FAIL ANY: STOP
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  // ===========================================================================
  // Group 2: Multi-Substep Sequential Agent Dispatch
  // ===========================================================================
  describe('multi-substep sequential agent dispatch', () => {
    async function writePipelineRunbook(ws: TestWorkspace): Promise<void> {
      const content = `## 1. Build pipeline
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Compile
Compile the code.

### 1.2 Test
Run the tests.

## 2. Deploy
- PASS: COMPLETE

Deploy to production.
`;
      await writeFile(join(ws.cwd, 'pipeline.runbook.md'), content);
    }

    it('sequential agents — all substeps pass', async () => {
      await writePipelineRunbook(workspace);

      // Start at substep 1.1
      let result = runCli('run --prompted pipeline.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Bind agent-1 to 1.1 (current substep via --step 1)
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Pass 1.1, drain advances to 1.2
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Bind agent-2 to 1.2 (now current substep via --step 1)
      result = runCli('run --step 1', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Pass 1.2, all substeps pass → advance to step 2
      result = runCli('pass --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('sequential agents — first substep fails → STOP', async () => {
      await writePipelineRunbook(workspace);

      // Start at substep 1.1
      expect(runCli('run --prompted pipeline.runbook.md', workspace).exitCode).toBe(0);

      // Bind agent-1 to 1.1
      expect(runCli('run --step 1', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-1', workspace).exitCode).toBe(0);

      // Fail 1.1 → FAIL ANY: STOP
      const result = runCli('fail --agent agent-1', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  // ===========================================================================
  // Group 3: Substeps with Child Runbooks
  // ===========================================================================
  describe('substeps with child runbooks', () => {
    async function writeMultiChildRunbook(ws: TestWorkspace): Promise<void> {
      const parentContent = `## 1. Dispatch tasks
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Task A
- task-a.runbook.md

### 1.2 Task B
- task-b.runbook.md

## 2. Summary
- PASS: COMPLETE

All tasks done.
`;
      await writeFile(join(ws.cwd, 'multi-child.runbook.md'), parentContent);
      await writeChildRunbook(ws, 'task-a.runbook.md');
      await writeChildRunbook(ws, 'task-b.runbook.md');
    }

    it('child runbook pass — agent completes child, parent advances', async () => {
      const parentContent = `## 1. Work
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Do task
- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final.
`;
      await writeFile(join(workspace.cwd, 'single-child.runbook.md'), parentContent);
      await writeChildRunbook(workspace, 'child.runbook.md');

      // Start parent
      let result = runCli('run --prompted single-child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Queue step 1 with child runbook
      result = runCli('run --step 1 child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Bind agent
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Agent passes child → auto-advances parent from 1.1 to step 2
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('child runbook fail — agent fails child, triggers STOP', async () => {
      const parentContent = `## 1. Work
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Do task
- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final.
`;
      await writeFile(join(workspace.cwd, 'single-child-fail.runbook.md'), parentContent);
      await writeChildRunbook(workspace, 'child.runbook.md');

      // Start parent
      expect(runCli('run --prompted single-child-fail.runbook.md', workspace).exitCode).toBe(0);

      // Queue with child and bind
      expect(runCli('run --step 1 child.runbook.md', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-1', workspace).exitCode).toBe(0);

      // Agent fails child → FAIL ANY: STOP
      const result = runCli('fail --agent agent-1', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('multi-substep with child runbooks — sequential dispatch', async () => {
      await writeMultiChildRunbook(workspace);

      // Start parent at 1.1
      let result = runCli('run --prompted multi-child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Queue 1.1 with child, bind, pass
      result = runCli('run --step 1 task-a.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');
      // Agent passes child → auto-advances parent cursor to 1.2
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Queue 1.2 with child, bind, pass
      result = runCli('run --step 1 task-b.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      result = runCli('run --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Agent passes child → auto-advances parent to step 2
      result = runCli('pass --agent agent-2', workspace);
      expect(result.exitCode).toBe(0);

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('multi-substep with child — second child fails', async () => {
      await writeMultiChildRunbook(workspace);

      // Start parent
      expect(runCli('run --prompted multi-child.runbook.md', workspace).exitCode).toBe(0);

      // 1.1 passes → auto-advances parent cursor to 1.2
      expect(runCli('run --step 1 task-a.runbook.md', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-1', workspace).exitCode).toBe(0);
      let result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // 1.2 fails → auto-propagates FAIL to parent → FAIL ANY: STOP
      expect(runCli('run --step 1 task-b.runbook.md', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-2', workspace).exitCode).toBe(0);
      result = runCli('fail --agent agent-2', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  // ===========================================================================
  // Group 4: Step-Level Child Runbooks (No Substeps)
  // ===========================================================================
  describe('step-level child runbooks (no substeps)', () => {
    it('step-level child pass — auto-advances parent to next step', async () => {
      const parentContent = `## 1. Work
- PASS: CONTINUE

- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final.
`;
      await writeFile(join(workspace.cwd, 'step-child.runbook.md'), parentContent);
      await writeChildRunbook(workspace, 'child.runbook.md');

      // Start parent
      let result = runCli('run --prompted step-child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Queue step 1 with child runbook (no substep)
      result = runCli('run --step 1 child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Bind agent
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Agent passes child → auto-advances parent from step 1 to step 2
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);

      // Complete step 2
      result = runCli('pass', workspace);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('step-level child pass — single-step parent completes', async () => {
      const parentContent = `## 1. Work
- PASS: COMPLETE

- child.runbook.md
`;
      await writeFile(join(workspace.cwd, 'step-child-complete.runbook.md'), parentContent);
      await writeChildRunbook(workspace, 'child.runbook.md');

      // Start parent
      let result = runCli('run --prompted step-child-complete.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Queue step 1 with child runbook (no substep)
      result = runCli('run --step 1 child.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Bind agent
      result = runCli('run --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('bound');

      // Agent passes child → auto-completes parent (PASS: COMPLETE)
      result = runCli('pass --agent agent-1', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('step-level child fail — auto-stops parent', async () => {
      const parentContent = `## 1. Work
- PASS: CONTINUE
- FAIL: STOP

- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final.
`;
      await writeFile(join(workspace.cwd, 'step-child-fail.runbook.md'), parentContent);
      await writeChildRunbook(workspace, 'child.runbook.md');

      // Start parent
      expect(runCli('run --prompted step-child-fail.runbook.md', workspace).exitCode).toBe(0);

      // Queue and bind
      expect(runCli('run --step 1 child.runbook.md', workspace).exitCode).toBe(0);
      expect(runCli('run --agent agent-1', workspace).exitCode).toBe(0);

      // Agent fails child → auto-propagates FAIL to parent → STOP
      const result = runCli('fail --agent agent-1', workspace);
      expect(result.exitCode).toBe(1);
    });
  });
});
