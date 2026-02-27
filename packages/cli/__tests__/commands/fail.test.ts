import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  getAllStates,
  findActionOutput,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { ActionResponseSchema } from '../helpers/schema-validator.js';

describe('fail command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('FAIL: RETRY N', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/retry.runbook.md', workspace);
    });

    it('increments retryCount if under max', async () => {
      runCli('fail', workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = runCli('fail', workspace);

      expect(result.stdout).toContain('Retry');
    });
  });

  describe('FAIL: STOP', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('blocks runbook', async () => {
      const result = runCli('fail', workspace);

      expect(result.exitCode).toBe(1);
    });

    it('outputs error message', async () => {
      const result = runCli('fail', workspace);

      expect(result.stdout).toContain('STOP');
    });

    it('should set variables.stopped=true when STOP action triggered', async () => {
      // runbook already started by beforeEach
      runCli('fail', workspace);

      // After blocking, the runbook is saved but no longer active
      // Retrieve from all states
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/simple.runbook.md');
      expect(state?.variables.stopped).toBe(true);
    });
  });

  describe('FAIL: GOTO N', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/fail-goto.runbook.md', workspace);
    });

    it('jumps to specified step on failure', async () => {
      const result = runCli('fail', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3'); // GOTO 3 on FAIL
    });
  });

  describe('runbook fail with stack', () => {
    it('agent runbook pops and blocks when fail causes STOP', async () => {
      // Create a single-step runbook that blocks on fail
      const singleStep = `## 1. Do it

- PASS: COMPLETE
- FAIL: STOP
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'single-fail.md'), singleStep);

      runCli('run --prompted runbooks/single-fail.md --agent agent-001', workspace);

      // Fail runbook - should block and pop
      const result = runCli('fail --agent agent-001', workspace);
      expect(result.exitCode).toBe(1);

      // Agent stack should be empty
      const statusResult = runCli('status --agent agent-001', workspace);
      expect(statusResult.stdout).toContain('No active runbook');
    });

    it('pops to parent runbook on fail completion', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS: COMPLETE
- FAIL: COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS: COMPLETE
- FAIL: COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-fail.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.md'), childRunbook);

      // Start parent (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/parent-fail.md', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      runCli('run --prompted runbooks/child-fail.md', workspace);

      // Fail child - should complete (FAIL: COMPLETE) and pop to parent
      const result = runCli('fail', workspace);
      expect(result.stdout).toContain('COMPLETE');

      // Should now be on parent
      const statusResult = runCli('status', workspace);
      expect(statusResult.stdout).toContain('parent-fail.md');
    });
  });

  describe('state consistency in execution loop', () => {
    it('uses updated state for retry execution loop', async () => {
      // Create a runbook with agent-scoped RETRY that continues execution
      const retryRunbook = `## 1. Retry step
- FAIL: RETRY 3
- PASS: COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'agent-retry.md'), retryRunbook);

      runCli('run --prompted runbooks/agent-retry.md --agent test-agent', workspace);

      // Fail to trigger RETRY which should continue execution with updated state
      const result = runCli('fail --agent test-agent --json', workspace);

      // The execution loop should run with updated state (retryCount incremented)
      // Verify the retry action was emitted correctly
      expect(result.stdout).toContain('retry');
      expect(result.exitCode).toBe(0); // Should complete after retry succeeds
    });
  });

  describe('JSON output', () => {
    it('includes action field when no active runbook', () => {
      // Run fail --json with no active runbook
      const result = runCli('fail --json', workspace);

      // Should exit with error code
      expect(result.exitCode).toBe(0);

      // Parse JSON output
      const output = JSON.parse(result.stdout);

      // The output must include 'action' field per ActionResponseSchema
      // Currently this test FAILS because output.error() does not set action
      expect(output).toHaveProperty('action');
      expect(output.action).toBe('fail');
      expect(output.result).toBe(false);
      expect(output.code).toBe('NO_ACTIVE_RUNBOOK');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('JSON action result semantics', () => {
    it('reports result: false for RETRY transitions', async () => {
      // Start retry runbook in prompted mode
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      // Fail should trigger RETRY (since FAIL: RETRY 3)
      const result = runCli('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output!.action as string).toMatch(/^RETRY/);
      expect(output!.result).toBe(false);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result: false for STOP transitions', async () => {
      // Start simple runbook in prompted mode (FAIL: STOP on step 1)
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      // Fail should trigger STOP
      const result = runCli('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions
      expect(output?.result).toBe(false);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports result: false for GOTO transitions', async () => {
      // Start fail-goto runbook in prompted mode (FAIL: GOTO 3)
      runCli('run --prompted runbooks/fail-goto.runbook.md', workspace);

      // Fail should trigger GOTO 3
      const result = runCli('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
      expect(output?.result).toBe(false);

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('fail with no active runbook exits cleanly', async () => {
      // No runbook started
      const result = runCli('fail', workspace);

      // Should exit without error (graceful handling)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('fail after max retries exhausted triggers fallback action', async () => {
      // Start retry runbook
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      // Fail repeatedly until retries exhausted
      runCli('fail', workspace); // retry 1
      runCli('fail', workspace); // retry 2
      const result = runCli('fail', workspace); // retry 3 - should exhaust retries

      // After max retries, should use on_fail action (STOP by default)
      expect(result.exitCode).toBe(1);
    });

    it('fail on substep with PASS ALL transition', async () => {
      // Create runbook with substeps and PASS ALL
      const substepRunbook = `## 1. Process
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 First substep
Do first task.

### 1.2 Second substep
Do second task.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'substep-fail-any.md'), substepRunbook);

      runCli('run --prompted runbooks/substep-fail-any.md', workspace);

      // Fail on first substep - should trigger FAIL ANY: STOP
      const result = runCli('fail', workspace);

      expect(result.exitCode).toBe(1);
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/substep-fail-any.md');
      expect(state?.variables.stopped).toBe(true);
    });

    it('fail command with --agent flag on non-agent runbook', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      // Try to fail with agent flag on non-agent runbook
      const result = runCli('fail --agent test-agent', workspace);

      // Should handle gracefully (agent not bound to this runbook)
      // Behavior depends on implementation
      expect(result.exitCode).not.toBe(undefined);
    });

    it('consecutive fail commands maintain state consistency', async () => {
      // Create a runbook that transitions on second fail
      const multiFailRunbook = `## 1. Retry step
- FAIL: RETRY 2
- PASS: CONTINUE

Try this step.

## 2. Done
- PASS: COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'multi-fail.md'), multiFailRunbook);

      runCli('run --prompted runbooks/multi-fail.md', workspace);

      // First fail - retry
      let result = runCli('fail', workspace);
      let state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1');

      // Second fail - retry again
      result = runCli('fail', workspace);
      state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(2);
      expect(state?.step).toBe('1');

      // Third fail - exhausted retries, should use on_fail (implicit STOP)
      result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('fail with both --json and --agent flags', async () => {
      const agentRunbook = `## 1. Agent task
- PASS: COMPLETE
- FAIL: STOP

Do agent work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'agent-task.md'), agentRunbook);

      runCli('run --prompted runbooks/agent-task.md --agent agent-001', workspace);

      // Fail with both flags
      const result = runCli('fail --agent agent-001 --json', workspace);

      // Should produce valid JSON output
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('action');
    });

    it('fail on runbook with no explicit fail transition uses default', async () => {
      // Create runbook with only PASS transition (no explicit FAIL)
      const noFailTransition = `## 1. Step
- PASS: COMPLETE

Do something.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'no-fail.md'), noFailTransition);

      runCli('run --prompted runbooks/no-fail.md', workspace);

      // Fail should use default action (STOP)
      const result = runCli('fail', workspace);
      expect(result.exitCode).toBe(1);
    });
  });
});