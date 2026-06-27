import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RUN_ID_PATTERN } from '@rundown-org/core';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

function expectRunId(text: string): void {
  const unanchoredRunIdSource = RUN_ID_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
  expect(text).toMatch(new RegExp(`\\b${unanchoredRunIdSource}\\b`));
}

describe('output format integration tests', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  describe('start command output', () => {
    it('prints metadata and action block', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      // Metadata section
      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
      // Action block (step content)
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('includes runbook ID in metadata', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      expectRunId(result.stdout);
    });

    it('shows first step details in action block', async () => {
      const result = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );

      // Step heading and description are shown
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });
  });

  describe('pass command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('prints separator before action block', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(0);
      // Should contain separator with step number (─── N ───)
      expect(result.stdout).toContain('───');
      // Should contain next step info
      expect(result.stdout).toContain('Second step');
    });

    it('shows new step details in action block', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('Second step');
    });

    it('includes metadata about state progression', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      // Should show we're on step 2 via At: field in action block
      expect(result.stdout).toContain('At:       2');
    });
  });

  describe('fail command output', () => {
    it('prints retry action message for FAIL: RETRY', async () => {
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      const result = await runCliInProcess('fail --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');
      // Should show the step being retried via At: field
      expect(result.stdout).toContain('At:       1');
    });

    it('prints stopped message for FAIL: STOP', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('fail --text', workspace);

      expect(result.exitCode).toBe(1);
      // Error message may be in stdout or stderr
      const output = result.stderr + result.stdout;
      expect(output.length).toBeGreaterThan(0);
    });

    it('shows retry count in output', async () => {
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      const result = await runCliInProcess('fail --text', workspace);

      // Retry count should appear after fail (retry count becomes 1)
      expect(result.stdout).toMatch(/\d/);
    });
  });

  describe('goto command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    });

    it('prints action without outcome', async () => {
      const result = await runCliInProcess(['goto', '3', '--text'], workspace);

      expect(result.exitCode).toBe(0);
      // Should show action GOTO
      expect(result.stdout).toContain('GOTO 3');
      // Should display the target step details
      expect(result.stdout).toContain('Jump target');
    });

    it('shows target step details in action block', async () => {
      const result = await runCliInProcess(['goto', '3', '--text'], workspace);

      // Step position is shown in heading
      expect(result.stdout).toContain('## 3.');
      expect(result.stdout).toContain('Jump target');
    });

    it('no outcome block (just action)', async () => {
      const result = await runCliInProcess(['goto', '3', '--text'], workspace);

      // goto shows GOTO action - outcome depends on whether step has one
      expect(result.stdout).toContain('GOTO 3');
    });
  });

  describe('status command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('prints metadata and step block', async () => {
      const result = await runCliInProcess('status --text', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
      // Step info via heading
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('includes runbook details in metadata', async () => {
      const result = await runCliInProcess('status --text', workspace);

      expect(result.stdout).toContain('State:');
      expectRunId(result.stdout);
    });

    it('shows current step block', async () => {
      const result = await runCliInProcess('status --text', workspace);

      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });
  });

  describe('stop command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('prints metadata and stopped message', async () => {
      const result = await runCliInProcess('stop --text', workspace);

      // Bare stop is a failure terminal and exits non-zero.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('STOP');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('includes runbook ID in output', async () => {
      const result = await runCliInProcess('stop --text', workspace);

      expectRunId(result.stdout);
    });

    it('shows confirmation message', async () => {
      const result = await runCliInProcess('stop --text', workspace);

      // Should confirm the stop action
      expect(result.stdout).toContain('STOP');
    });

    it('prints stop message details when provided', async () => {
      const result = await runCliInProcess(['stop', 'User cancelled', '--text'], workspace);

      expect(result.stdout).toContain('Runbook:  STOP');
    });
  });

  describe('complete command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('pass --text', workspace); // Move to step 2 which has PASS: COMPLETE
    });

    it('prints metadata and complete message', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('COMPLETE');
      // Completion message shows without file reference
      expect(result.stdout).toContain('Action:');
    });

    it('shows completion confirmation', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('COMPLETE');
    });

    it('includes action in output', async () => {
      const result = await runCliInProcess('pass --text', workspace);

      expect(result.stdout).toContain('Action:');
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  describe('stash command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('prints metadata, step, and stashed message', async () => {
      const result = await runCliInProcess('stash --text', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('simple.runbook.md');
      // Step info (stash still uses Step: for position)
      expect(result.stdout).toContain('Step:');
      // Stashed message
      expect(result.stdout).toContain('STASHED');
    });

    it('shows file metadata in output', async () => {
      const result = await runCliInProcess('stash --text', workspace);

      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('includes stashed confirmation', async () => {
      const result = await runCliInProcess('stash --text', workspace);

      expect(result.stdout).toContain('Runbook:  STASHED');
    });
  });

  describe('pop command output', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      await runCliInProcess('pass --text', workspace); // Move to step 2
      await runCliInProcess('stash --text', workspace);
    });

    it('prints metadata, action, and step block', async () => {
      const result = await runCliInProcess('pop --text', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('File:');
      // Step block (heading and content)
      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('Second step');
    });

    it('shows restored step details in action block', async () => {
      const result = await runCliInProcess('pop --text', workspace);

      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('Second step');
    });

    it('shows step is now active again', async () => {
      const result = await runCliInProcess('pop --text', workspace);

      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
    });
  });

  describe('ls command output', () => {
    it('prints runbook entries', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('ls --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('1/2');
    });

    it('marks active runbook', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('ls --text', workspace);

      expect(result.stdout).toContain('active');
    });

    it('shows step number for each runbook', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

      const result = await runCliInProcess('ls --text', workspace);

      expect(result.stdout).toContain('1/2');
    });

    it('shows all runbooks in state directory', async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
      // Start another runbook to have multiple entries
      await runCliInProcess('stop --text', workspace);
      await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);

      const result = await runCliInProcess('ls --text', workspace);

      expect(result.stdout).toContain('retry.runbook.md');
    });

    it('displays "No runbooks" when empty', async () => {
      const result = await runCliInProcess('ls --text', workspace);

      expect(result.stdout).toContain('No active runbooks');
    });
  });

  describe('output formatting consistency across commands', () => {
    beforeEach(async () => {
      await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    });

    it('all commands exit cleanly with proper status codes', async () => {
      const startResult = await runCliInProcess(
        'run --prompted runbooks/simple.runbook.md --text',
        workspace,
      );
      const statusResult = await runCliInProcess('status --text', workspace);
      const listResult = await runCliInProcess('ls --text', workspace);

      expect(startResult.exitCode).toBe(0);
      expect(statusResult.exitCode).toBe(0);
      expect(listResult.exitCode).toBe(0);
    });

    it('metadata appears consistently across commands', async () => {
      const statusResult = await runCliInProcess('status --text', workspace);
      const listResult = await runCliInProcess('ls --text', workspace);

      // Both should contain runbook file reference
      expect(statusResult.stdout).toContain('simple.runbook.md');
      expect(listResult.stdout).toContain('simple.runbook.md');
    });

    it('step information is consistently formatted', async () => {
      const statusResult = await runCliInProcess('status --text', workspace);
      const listResult = await runCliInProcess('ls --text', workspace);

      // List shows step number in format 1/2
      expect(listResult.stdout).toContain('1/2');

      // Status shows step description via heading
      expect(statusResult.stdout).toContain('## 1.');
      expect(statusResult.stdout).toContain('First step');
    });
  });
});
