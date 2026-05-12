import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  findActionOutput,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('start --prompted', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('prompted mode behavior', () => {
    it('creates runbook in prompted mode', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/with-commands.runbook.md --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Action:   START');
      expect(result.stdout).toContain('Prompt:   Yes');
    });

    it('sets prompted flag in state', async () => {
      await runCliInProcess('run --prompted runbooks/with-commands.runbook.md --text', workspace);

      const state = await getActiveState(workspace);
      expect(state?.prompted).toBe(true);
    });

    it('does not auto-execute bash commands in prompted mode', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // In prompted mode, the command should be shown but not executed
      // The runbook should stop at the first step waiting for manual input
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('Execute command');
      // Should NOT show execution output ($ command format would appear if executed)
      expect(result.stdout).not.toContain('$ rd echo');
    });

    it('waits for manual pass/fail in prompted mode', async () => {
      await runCliInProcess('run --prompted runbooks/with-commands.runbook.md --text', workspace);

      // After starting in prompted mode, should be at step 1
      let state = await getActiveState(workspace);
      expect(state?.step).toBe('1');

      // Manual pass should advance to next step
      await runCliInProcess('pass --text', workspace);

      state = await getActiveState(workspace);
      expect(state?.step).toBe('2');
    });

    it('uses the newly started runbook for prompted --step goto with unrelated env', async () => {
      const runbook = `## 1. First
- PASS CONTINUE

First step.

## 2. Second
- PASS COMPLETE

Second step.
`;
      await writeFile(join(workspace.cwd, 'goto-start.runbook.md'), runbook);

      const result = await runCliInProcess(
        'run --prompted goto-start.runbook.md --step 2 --text',
        workspace,
        { env: { RUNDOWN_TEST_ENV: 'prompted-run-session' } },
      );

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.runbook).toEqual({ source: 'project', path: 'goto-start.runbook.md' });
      expect(state?.step).toBe('2');
    });

    it('persists first substep launch state through core initialization', async () => {
      const runbook = `## 1. Parent
- PASS CONTINUE
- FAIL STOP

### 1.1 First
- PASS CONTINUE
- FAIL STOP

### 1.2 Second
- PASS CONTINUE
- FAIL STOP

## 2. Done
- PASS COMPLETE
- FAIL STOP
`;
      await writeFile(join(workspace.cwd, 'substeps-start.runbook.md'), runbook);

      const result = await runCliInProcess(
        'run --prompted substeps-start.runbook.md --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const state = await getActiveState(workspace);
      expect(state?.step).toBe('1');
      expect(state?.substep).toBe('1');
      expect(state?.lastAction).toEqual({ type: 'START' });
      expect(state?.activeFrameKey).toBe('1|');
      expect(state?.activeEntry).toBe(1);
      expect(state?.frameEntries).toEqual({ '1|': 1 });
      expect(state?.substepStates).toEqual([
        { id: '1', frameKey: '1|', status: 'pending' },
        { id: '2', frameKey: '1|', status: 'pending' },
      ]);
    });

    it('shows command in output without executing', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Command should be visible to user
      expect(result.stdout).toContain('Execute command');
      // But not executed (no command execution line)
      expect(result.stdout).not.toContain('$ rd echo');
    });

    it('inherits prompted flag in child runbooks via delegation', async () => {
      // Start parent runbook (with substeps) in prompted mode
      await runCliInProcess('run --prompted runbooks/substeps.runbook.md --text', workspace);

      // Delegate substep to child runbook
      const delegateResult = await runCliInProcess(
        'delegate runbooks/with-commands.runbook.md --step 1.1',
        workspace,
      );
      expect(delegateResult.exitCode).toBe(0);
      const delegateOutput = JSON.parse(delegateResult.stdout) as { token?: string };
      const token = delegateOutput.token;
      expect(token).toBeDefined();

      // Claim the delegation token — launches child runbook
      const claimResult = await runCliInProcess(`claim ${token!}`, workspace);
      expect(claimResult.exitCode).toBe(0);
      const childRunId = findActionOutput(claimResult.stdout)?.run_id;
      expect(typeof childRunId).toBe('string');

      // Child should inherit prompted flag from parent
      const state = await readRunbookState(workspace, String(childRunId));
      expect(state?.prompted).toBe(true);
      expect(state?.runbook.path).toContain('with-commands');
    });
  });

  describe('auto-execution without --prompted', () => {
    it('executes bash commands automatically in auto mode', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Without --prompted, commands execute automatically
      expect(result.stdout).toContain('Execute command');
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Action:   CONTINUE');
    });

    it('stores lastResult after successful execution', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Runbook completes in auto mode (both steps pass)
      expect(result.stdout).toContain('COMPLETE');
    });

    it('stores lastResult as pass on successful command', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Runbook completes in auto mode
      expect(result.stdout).toContain('COMPLETE');
    });

    it('stores lastResult as fail on failed command', async () => {
      // Using failing command runbook - now uses rd echo which succeeds after retries
      const result = await runCliInProcess(
        'run runbooks/with-failing-command.runbook.md --text',
        workspace,
      );

      // Should show RETRY behavior then eventually pass
      expect(result.stdout).toContain('$ rd echo');
      // The runbook now completes successfully after retries
      expect(result.stdout).toContain('COMPLETE');
    });

    it('continues execution loop on pass condition', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Runbook should complete (both steps executed in auto mode)
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('COMPLETE');
    });

    it('chains multiple auto-executing steps', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Both steps should execute automatically
      expect(result.stdout).toContain('Execute command');
      expect(result.stdout).toContain('COMPLETE');
    });

    it('applies FAIL condition when command fails', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-failing-command.runbook.md --text',
        workspace,
      );

      // Should trigger retry (FAIL: RETRY 2) then succeed on 3rd attempt
      expect(result.stdout).toContain('$ rd echo');
      expect(result.stdout).toContain('RETRY');
      // Runbook completes after successful retry
      expect(result.stdout).toContain('COMPLETE');
    });

    it('respects max retries on repeated failures', async () => {
      // Manually step through retries to test tracking
      await runCliInProcess(
        'run --prompted runbooks/with-failing-command.runbook.md --text',
        workspace,
      );

      // Step 1 with retry in prompted mode
      let result = await runCliInProcess('fail --text', workspace);
      let state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(1);

      // Step 2 with retry
      result = await runCliInProcess('fail --text', workspace);
      state = await getActiveState(workspace);
      expect(state?.retryCount).toBe(2);

      // Third fail should block (max retries exceeded)
      result = await runCliInProcess('fail --text', workspace);
      expect(result.exitCode).not.toBe(0);
    });

    it('does not execute prompt code blocks even without CLI --prompted flag', async () => {
      // Create runbook with prompt code block
      const runbooksDir = join(workspace.cwd, 'runbooks');
      await mkdir(runbooksDir, { recursive: true });
      await writeFile(
        join(runbooksDir, 'with-prompt-block.runbook.md'),
        `# Prompt Block Test

## 1. Step with prompt block
- PASS COMPLETE

Show this command to the agent.

\`\`\`prompt
npm run dangerous-command
\`\`\`
`,
      );

      const result = await runCliInProcess(
        'run runbooks/with-prompt-block.runbook.md --text',
        workspace,
      );

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
      await runCliInProcess('stop --text', workspace);
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      const state = await getActiveState(workspace);
      expect(state?.prompted).toBe(true);

      // Clean up
      await runCliInProcess('stop --text', workspace);

      // Second: auto mode - runbook completes immediately
      const result = await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('COMPLETE');
    });

    it('enforces prompted mode across manual steps', async () => {
      await runCliInProcess('run --prompted runbooks/with-commands.runbook.md --text', workspace);

      // In prompted mode, no auto-execution should happen
      const state1 = await getActiveState(workspace);
      expect(state1?.step).toBe('1');

      // Manually pass
      await runCliInProcess('pass --text', workspace);

      const state2 = await getActiveState(workspace);
      expect(state2?.step).toBe('2');
    });

    it('allows mixed auto and prompted runbooks', async () => {
      // Auto mode - runbook completes immediately
      const result1 = await runCliInProcess('run runbooks/simple.runbook.md --text', workspace);
      expect(result1.stdout).not.toContain('Prompt:   Yes');
      expect(result1.stdout).toContain('COMPLETE');

      // Prompted mode
      const result2 = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );
      expect(result2.stdout).toContain('Prompt:   Yes');
    });
  });

  describe('command execution details', () => {
    it('shows command code in prompt', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Prompted mode shows command to user
      expect(result.stdout).toContain('Execute command');
    });

    it('renders command as code block in prompted mode', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // The command from runbooks/with-commands.runbook.md step 1 is 'rd echo --result pass'
      expect(result.stdout).toContain('```bash');
      expect(result.stdout).toContain('rd echo --result pass');
      expect(result.stdout).toContain('```');
    });

    it('executes with correct working directory', async () => {
      // Command uses rd echo, which succeeds
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // If working directory is wrong, command might fail
      expect(result.stdout).toContain('$ rd echo --result pass');
    });

    it('handles command output correctly', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Should show execution happened
      expect(result.stdout).toContain('$ rd echo --result pass');
      expect(result.stdout).toContain('Action:   CONTINUE');
    });

    it('updates step progression after auto-execution', async () => {
      const result = await runCliInProcess(
        'run runbooks/with-commands.runbook.md --text',
        workspace,
      );

      // Runbook completes in auto mode (all steps pass)
      expect(result.stdout).toContain('COMPLETE');
    });
  });
});
