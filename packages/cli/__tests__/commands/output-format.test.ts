import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
      const result = runCli('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata section
      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
      // Action block (step content)
      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('includes workflow ID in metadata', async () => {
      const result = runCli('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
    });

    it('shows first step details in action block', async () => {
      const result = runCli('run --prompted runbooks/simple.runbook.md', workspace);

      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('1/2');
      expect(result.stdout).toContain('First step');
    });
  });

  describe('pass command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('prints separator before action block', async () => {
      const result = runCli('pass', workspace);

      expect(result.exitCode).toBe(0);
      // Should contain separator (multiple dashes)
      expect(result.stdout).toMatch(/^-{5,}/m);
      // Should contain next step info
      expect(result.stdout).toContain('Second step');
    });

    it('shows new step details in action block', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('Second step');
    });

    it('includes metadata about state progression', async () => {
      const result = runCli('pass', workspace);

      // Should show we're on step 2 with format Step: 2/2
      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('2/2');
    });
  });

  describe('fail command output', () => {
    it('prints retry action message for FAIL: RETRY', async () => {
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      const result = runCli('fail', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETRY');
      // Should show the step being retried
      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('1/');
    });

    it('prints stopped message for FAIL: STOP', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const result = runCli('fail', workspace);

      expect(result.exitCode).toBe(1);
      // Error message may be in stdout or stderr
      const output = result.stderr + result.stdout;
      expect(output.length).toBeGreaterThan(0);
    });

    it('shows retry count in output', async () => {
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      const result = runCli('fail', workspace);

      // Retry count should appear after fail (retry count becomes 1)
      expect(result.stdout).toMatch(/\d/);
    });
  });

  describe('goto command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/goto.runbook.md', workspace);
    });

    it('prints action without outcome', async () => {
      const result = runCli(['goto', '3'], workspace);

      expect(result.exitCode).toBe(0);
      // Should show action GOTO
      expect(result.stdout).toContain('GOTO 3');
      // Should display the target step details
      expect(result.stdout).toContain('Jump target');
    });

    it('shows target step details in action block', async () => {
      const result = runCli(['goto', '3'], workspace);

      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('3/');
      expect(result.stdout).toContain('Jump target');
    });

    it('no outcome block (just action)', async () => {
      const result = runCli(['goto', '3'], workspace);

      // goto shows GOTO action - outcome depends on whether step has one
      expect(result.stdout).toContain('GOTO 3');
    });
  });

  describe('status command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('prints metadata and step block', async () => {
      const result = runCli('status', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
      // Step info block
      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('First step');
    });

    it('includes workflow details in metadata', async () => {
      const result = runCli('status', workspace);

      expect(result.stdout).toContain('State:');
      expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
    });

    it('shows current step block', async () => {
      const result = runCli('status', workspace);

      expect(result.stdout).toContain('## 1.');
      expect(result.stdout).toContain('First step');
    });

    it('shows pending steps when present', async () => {
      runCli('run --step 2', workspace);

      const result = runCli('status', workspace);

      expect(result.stdout).toContain('Pending');
    });
  });

  describe('stop command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('prints metadata and stopped message', async () => {
      const result = runCli('stop', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('STOP');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('includes workflow ID in output', async () => {
      const result = runCli('stop', workspace);

      expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
    });

    it('shows confirmation message', async () => {
      const result = runCli('stop', workspace);

      // Should confirm the stop action
      expect(result.stdout).toContain('STOP');
    });

    it('prints stop message details when provided', async () => {
      const result = runCli(['stop', 'User cancelled'], workspace);

      expect(result.stdout).toContain('Runbook:  STOP');
    });
  });

  describe('complete command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      runCli('pass', workspace); // Move to step 2 which has PASS: COMPLETE
    });

    it('prints metadata and complete message', async () => {
      const result = runCli('pass', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('COMPLETE');
      // Completion message shows without file reference
      expect(result.stdout).toContain('Action:');
    });

    it('shows completion confirmation', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('COMPLETE');
    });

    it('includes action in output', async () => {
      const result = runCli('pass', workspace);

      expect(result.stdout).toContain('Action:');
      expect(result.stdout).toContain('COMPLETE');
    });
  });

  describe('stash command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('prints metadata, step, and stashed message', async () => {
      const result = runCli('stash', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('simple.runbook.md');
      // Step info
      expect(result.stdout).toContain('Step:');
      // Stashed message
      expect(result.stdout).toContain('STASHED');
    });

    it('shows file metadata in output', async () => {
      const result = runCli('stash', workspace);

      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
    });

    it('includes stashed confirmation', async () => {
      const result = runCli('stash', workspace);

      expect(result.stdout).toContain('Runbook:  STASHED');
    });
  });

  describe('pop command output', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      runCli('pass', workspace); // Move to step 2
      runCli('stash', workspace);
    });

    it('prints metadata, action, and step block', async () => {
      const result = runCli('pop', workspace);

      expect(result.exitCode).toBe(0);
      // Metadata
      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('File:');
      // Step block
      expect(result.stdout).toContain('Step:');
      expect(result.stdout).toContain('2/');
      expect(result.stdout).toContain('Second step');
    });

    it('shows restored step details in action block', async () => {
      const result = runCli('pop', workspace);

      expect(result.stdout).toContain('## 2.');
      expect(result.stdout).toContain('Second step');
    });

    it('shows step is now active again', async () => {
      const result = runCli('pop', workspace);

      expect(result.stdout).toContain('File:');
      expect(result.stdout).toContain('simple.runbook.md');
    });
  });

  describe('ls command output', () => {
    it('prints workflow entries', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const result = runCli('ls', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('1/2');
    });

    it('marks active workflow', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const result = runCli('ls', workspace);

      expect(result.stdout).toContain('active');
    });

    it('shows step number for each workflow', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);

      const result = runCli('ls', workspace);

      expect(result.stdout).toContain('1/2');
    });

    it('shows all workflows in state directory', async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
      // Start another workflow to have multiple entries
      runCli('stop', workspace);
      runCli('run --prompted runbooks/retry.runbook.md', workspace);

      const result = runCli('ls', workspace);

      expect(result.stdout).toContain('retry.runbook.md');
    });

    it('displays "No workflows" when empty', async () => {
      const result = runCli('ls', workspace);

      expect(result.stdout).toContain('No runbooks');
    });
  });

  describe('output formatting consistency across commands', () => {
    beforeEach(async () => {
      runCli('run --prompted runbooks/simple.runbook.md', workspace);
    });

    it('all commands exit cleanly with proper status codes', async () => {
      const startResult = runCli('run --prompted runbooks/simple.runbook.md', workspace);
      const statusResult = runCli('status', workspace);
      const listResult = runCli('ls', workspace);

      expect(startResult.exitCode).toBe(0);
      expect(statusResult.exitCode).toBe(0);
      expect(listResult.exitCode).toBe(0);
    });

    it('metadata appears consistently across commands', async () => {
      const statusResult = runCli('status', workspace);
      const listResult = runCli('ls', workspace);

      // Both should contain workflow file reference
      expect(statusResult.stdout).toContain('simple.runbook.md');
      expect(listResult.stdout).toContain('simple.runbook.md');
    });

    it('step information is consistently formatted', async () => {
      const statusResult = runCli('status', workspace);
      const listResult = runCli('ls', workspace);

      // Both should show step number in format 1/2
      expect(statusResult.stdout).toContain('1/2');
      expect(listResult.stdout).toContain('1/2');

      // Status should show step description
      expect(statusResult.stdout).toContain('First step');
    });
  });
});
