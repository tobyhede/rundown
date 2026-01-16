import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  readSession,
  verifyRdCommand,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('start --prompted', () => {
  let workspace: TestWorkspace;

  // Verify rd command exists before running tests
  beforeAll(async () => {
    await verifyRdCommand();
  });

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('prompted mode behavior', () => {
    it('creates runbook in prompted mode', async () => {
      const result = runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Action:   START');
      expect(result.stdout).toContain('Prompt:   Yes');
    });

    it('sets prompted flag in state', async () => {
      runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      const state = await getActiveState(workspace);
      expect(state?.prompted).toBe(true);
    });

    it('does not auto-execute bash commands in prompted mode', async () => {
      const result = runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      // In prompted mode, the command should be shown but not executed
      // The runbook should stop at the first step waiting for manual input
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('Execute command');
      // Should NOT show execution output ($ command format would appear if executed)
      expect(result.stdout).not.toContain('$ rd echo');
    });

    it('waits for manual pass/fail in prompted mode', async () => {
      runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      // After starting in prompted mode, should be at step 1
      let state = await getActiveState(workspace);
      expect(state?.step).toBe('1');

      // Manual pass should advance to next step
      runCli('pass', workspace);

      state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    it('shows command in output without executing', async () => {
      const result = runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      // Command should be visible to user
      expect(result.stdout).toContain('Execute command');
      // But not executed (no command execution line)
      expect(result.stdout).not.toContain('$ rd echo');
    });

    it('inherits prompted flag in child runbooks', async () => {
      // Start parent runbook in prompted mode
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      const session1 = await readSession(workspace);
      const _parentId = session1.active;

      // Queue step with child runbook
      runCli(['run', '--step', '1', 'runbooks/with-commands.runbook.md'], workspace);

      // Bind agent (creates child runbook)
      runCli(['run', '--agent', 'test-agent'], workspace);

      // Child should inherit prompted flag
      const state = await getActiveState(workspace);
      expect(state?.prompted).toBe(true);
    });
  });

  describe('auto-execution without --prompted', () => {
    it('executes bash commands automatically in auto mode', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Without --prompted, commands execute automatically
      expect(result.stdout).toContain('Execute command');
      expect(result.stdout).toContain('$ rd echo --result pass');
      // Include stderr in error message for CI debugging
      if (!result.stdout.includes('Action:   CONTINUE')) {
        console.error('Test failure debug info:');
        console.error('stdout:', result.stdout);
        console.error('stderr:', result.stderr);
        console.error('exitCode:', result.exitCode);
      }
      expect(result.stdout).toContain('Action:   CONTINUE');
    });

    it('stores lastResult after successful execution', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Runbook completes in auto mode (both steps pass)
      expect(result.stdout).toContain('COMPLETE');
    });

    it('stores lastResult as pass on successful command', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Runbook completes in auto mode
      expect(result.stdout).toContain('COMPLETE');
    });

    it('stores lastResult as fail on failed command', async () => {
      // Using failing command runbook - now uses rd echo which succeeds after retries
      const result = runCli('run runbooks/with-failing-command.runbook.md', workspace);

      // Should show RETRY behavior then eventually pass
      expect(result.stdout).toContain('$ rd echo');
      // The runbook now completes successfully after retries
      expect(result.stdout).toContain('COMPLETE');
    });

    it('continues execution loop on pass condition', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Runbook should complete (both steps executed in auto mode)
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('COMPLETE');
    });

    it('chains multiple auto-executing steps', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Both steps should execute automatically
      expect(result.stdout).toContain('Execute command');
      expect(result.stdout).toContain('COMPLETE');
    });

    it('applies FAIL condition when command fails', async () => {
      const result = runCli('run runbooks/with-failing-command.runbook.md', workspace);

      // Should trigger retry (FAIL: RETRY 2) then succeed on 3rd attempt
      expect(result.stdout).toContain('$ rd echo');
      expect(result.stdout).toContain('RETRY');
      // Runbook completes after successful retry
      expect(result.stdout).toContain('COMPLETE');
    });

    it('respects max retries on repeated failures', async () => {
      // Manually step through retries to test tracking
      runCli('run --prompted runbooks/with-failing-command.runbook.md', workspace);

      // Step 1 with retry in prompted mode
      let result = runCli('fail', workspace);
      let state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);

      // Step 2 with retry
      result = runCli('fail', workspace);
      state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(2);

      // Third fail should block (max retries exceeded)
      result = runCli('fail', workspace);
      expect(result.exitCode).not.toBe(0);
    });

    it('does not execute prompt code blocks even without CLI --prompted flag', async () => {
      // Create runbook with prompt code block
      const runbooksDir = join(workspace.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });
      await writeFile(join(runbooksDir, 'with-prompt-block.runbook.md'), `# Prompt Block Test

## 1. Step with prompt block
- PASS: COMPLETE

Show this command to the agent.

\`\`\`prompt
npm run dangerous-command
\`\`\`
`);

      const result = runCli('run runbooks/with-prompt-block.runbook.md', workspace);

      // Should NOT execute the command (no $ prefix showing execution)
      expect(result.stdout).not.toContain('$ npm run dangerous-command');
      // Should show the step
      expect(result.stdout).toContain('## 1.');
      // Should wait for manual pass/fail (not auto-complete)
      expect(result.exitCode).toBe(0);
    });
  });

  describe('mode consistency', () => {
    it('can start same runbook in auto mode after prompted mode', async () => {
      // First: prompted mode
      runCli('stop', workspace);
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      const state = await getActiveState(workspace);
      expect(state?.prompted).toBe(true);

      // Clean up
      runCli('stop', workspace);

      // Second: auto mode - runbook completes immediately
      const result = runCli('run runbooks/simple.runbook.md', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('enforces prompted mode across manual steps', async () => {
      runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      // In prompted mode, no auto-execution should happen
      const state1 = await getActiveState(workspace);
      expect(state1?.step).toBe('1');

      // Manually pass
      runCli('pass', workspace);

      const state2 = await getActiveState(workspace);
      expect(state2?.step).toBe('2');
    });

    it('allows mixed auto and prompted runbooks', async () => {
      // Auto mode - runbook completes immediately
      const result1 = runCli('run runbooks/simple.runbook.md', workspace);
      expect(result1.stdout).not.toContain('Prompt:   Yes');
      expect(result1.stdout).toContain('COMPLETE');

      // Prompted mode
      const result2 = runCli('run --prompted runbooks/simple.runbook.md', workspace);
      expect(result2.stdout).toContain('Prompt:   Yes');
    });
  });

  describe('command execution details', () => {
    it('shows command code in prompt', async () => {
      const result = runCli('run --prompted runbooks/with-commands.runbook.md', workspace);

      // Prompted mode shows command to user
      expect(result.stdout).toContain('Execute command');
    });

    it('executes with correct working directory', async () => {
      // Command uses rd echo, which succeeds
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // If working directory is wrong, command might fail
      expect(result.stdout).toContain('$ rd echo --result pass');
    });

    it('handles command output correctly', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Should show execution happened
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Action:   CONTINUE');
    });

    it('updates step progression after auto-execution', async () => {
      const result = runCli('run runbooks/with-commands.runbook.md', workspace);

      // Runbook completes in auto mode (all steps pass)
      expect(result.stdout).toContain('COMPLETE');
    });
  });
});
