import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
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
      await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);
    });

    it('increments retryCount if under max', async () => {
      await runCliInProcess('fail', workspace);

      const state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1'); // Same step
    });

    it('outputs retry info', async () => {
      const result = await runCliInProcess('fail', workspace);

      expect(result.stdout).toContain('Retry');
    });
  });

  describe('FAIL: STOP', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('blocks runbook', async () => {
      const result = await runCliInProcess('fail', workspace);

      expect(result.exitCode).toBe(1);
    });

    it('outputs error message', async () => {
      const result = await runCliInProcess('fail', workspace);

      expect(result.stdout).toContain('STOP');
    });

    it('should set variables.stopped=true when STOP action triggered', async () => {
      // runbook already started by beforeEach
      await runCliInProcess('fail', workspace);

      // After blocking, the runbook is saved but no longer active
      // Retrieve from all states
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/simple.runbook.md');
      expect(state?.variables.stopped).toBe(true);
    });
  });

  describe('FAIL: GOTO N', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md', workspace);
    });

    it('jumps to specified step on failure', async () => {
      const result = await runCliInProcess('fail', workspace);

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('3'); // GOTO 3 on FAIL
    });
  });

  describe('runbook fail with stack', () => {
    it('pops to parent runbook on fail completion', async () => {
      // Create parent/child runbooks
      const parentRunbook = `## 1. Step one
- PASS COMPLETE
- FAIL COMPLETE

Do something.
`;
      const childRunbook = `## 1. Step one
- PASS COMPLETE
- FAIL COMPLETE

Do work.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'parent-fail.md'), parentRunbook);
      await writeFile(join(workspace.cwd, 'runbooks', 'child-fail.md'), childRunbook);

      // Start parent (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/parent-fail.md', workspace);

      // Start child in same stack (prompted to prevent auto-completion)
      await runCliInProcess('run --prompted runbooks/child-fail.md', workspace);

      // Fail child - should complete (FAIL: COMPLETE) and pop to parent
      const result = await runCliInProcess('fail', workspace);
      expect(result.stdout).toContain('COMPLETE');

      // Should now be on parent
      const statusResult = await runCliInProcess('status', workspace);
      expect(statusResult.stdout).toContain('parent-fail.md');
    });
  });

  describe('JSON output', () => {
    it('includes action field when no active runbook', async () => {
      // Run fail --json with no active runbook
      const result = await runCliInProcess('fail --json', workspace);

      // Should exit with error code
      expect(result.exitCode).toBe(0);

      // Parse JSON output
      const output = JSON.parse(result.stdout);

      // The output must include 'action' field per ActionResponseSchema
      // Currently this test FAILS because output.error() does not set action
      expect(output).toHaveProperty('action');
      expect(output.action).toBe('fail');
      expect(output.code).toBe('NO_ACTIVE_RUNBOOK');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('JSON action result semantics', () => {
    it('reports stepResult FAIL for RETRY transitions', async () => {
      // Start retry runbook in prompted mode
      await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);

      // Fail should trigger RETRY (since FAIL: RETRY 3)
      const result = await runCliInProcess('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output!.action as string).toMatch(/^RETRY/);
      expect(output!.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports action stop for STOP transitions', async () => {
      // Start simple runbook in prompted mode (FAIL: STOP on step 1)
      await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

      // Fail should trigger STOP
      const result = await runCliInProcess('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action).toBe('stop'); // lowercase per CLI conventions

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });

    it('reports stepResult FAIL for GOTO transitions', async () => {
      // Start fail-goto runbook in prompted mode (FAIL: GOTO 3)
      await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md', workspace);

      // Fail should trigger GOTO 3
      const result = await runCliInProcess('fail --json', workspace);
      const output = findActionOutput(result.stdout);

      expect(output).not.toBeNull();
      expect(output?.action as string).toMatch(/^GOTO/);
      expect(output?.stepResult).toBe('FAIL');

      // Validate against schema
      const parseResult = ActionResponseSchema.safeParse(output);
      expect(parseResult.success).toBe(true);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('fail with no active runbook exits cleanly', async () => {
      // No runbook started
      const result = await runCliInProcess('fail', workspace);

      // Should exit without error (graceful handling)
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No active runbook');
    });

    it('fail after max retries exhausted triggers fallback action', async () => {
      // Start retry runbook
      await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);

      // Fail repeatedly until retries exhausted (RETRY 3 = 3 retries allowed, 4 total attempts)
      await runCliInProcess('fail', workspace); // retry 1 (retryCount: 0→1)
      await runCliInProcess('fail', workspace); // retry 2 (retryCount: 1→2)
      await runCliInProcess('fail', workspace); // retry 3 (retryCount: 2→3)
      const result = await runCliInProcess('fail', workspace); // retries exhausted, fallback STOP

      // After max retries, should use on_fail action (STOP by default)
      expect(result.exitCode).toBe(1);
    });

    it('fail on substep with PASS ALL transition defers until all substeps complete', async () => {
      // Two substeps exercise DEFER "wait for all" semantics:
      // failing substep 1.1 must NOT stop immediately; aggregation
      // fires only after substep 1.2 also completes.
      const substepRunbook = `## 1. Process
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 First substep
Do first task.

### 1.2 Second substep
Do second task.

## 2. Done
- PASS COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'substep-fail-any.md'), substepRunbook);

      await runCliInProcess('run --prompted runbooks/substep-fail-any.md', workspace);

      // Fail substep 1.1 -- result is deferred, machine advances to 1.2
      await runCliInProcess('fail', workspace);

      // Pass substep 1.2 -- all substeps now complete, aggregation fires
      // FAIL ANY: STOP triggers because substep 1.1 was failed
      const result = await runCliInProcess('pass', workspace);

      expect(result.exitCode).toBe(1);
      const states = await getAllStates(workspace);
      const state = states.find((s) => s.runbook === 'runbooks/substep-fail-any.md');
      expect(state?.variables.stopped).toBe(true);
    });

    it('consecutive fail commands maintain state consistency', async () => {
      // Create a runbook that transitions on second fail
      const multiFailRunbook = `## 1. Retry step
- FAIL RETRY 2
- PASS CONTINUE

Try this step.

## 2. Done
- PASS COMPLETE

Final step.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'multi-fail.md'), multiFailRunbook);

      await runCliInProcess('run --prompted runbooks/multi-fail.md', workspace);

      // First fail - retry
      let result = await runCliInProcess('fail', workspace);
      let state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);
      expect(state?.step).toBe('1');

      // Second fail - retry again
      result = await runCliInProcess('fail', workspace);
      state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(2);
      expect(state?.step).toBe('1');

      // Third fail - exhausted retries, should use on_fail (implicit STOP)
      result = await runCliInProcess('fail', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('fail on runbook with no explicit fail transition uses default', async () => {
      // Create runbook with only PASS transition (no explicit FAIL)
      const noFailTransition = `## 1. Step
- PASS COMPLETE

Do something.
`;
      await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
      await writeFile(join(workspace.cwd, 'runbooks', 'no-fail.md'), noFailTransition);

      await runCliInProcess('run --prompted runbooks/no-fail.md', workspace);

      // Fail should use default action (STOP)
      const result = await runCliInProcess('fail', workspace);
      expect(result.exitCode).toBe(1);
    });
  });
});
