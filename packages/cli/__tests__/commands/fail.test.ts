import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  getAllStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
      const state = states.find(s => s.runbook === 'runbooks/simple.runbook.md');
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
});
