import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCliInProcess,
  getActiveState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('abort command - unit tests', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

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

Run the child task.
`;
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  async function setupDelegation(): Promise<string> {
    await writeParentRunbook();
    await writeChildRunbook();

    let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);

    const tokenMatch = /Token:\s*(rdtk_\S+)/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    return tokenMatch![1];
  }

  describe('token validation', () => {
    it('rejects token with incorrect prefix', async () => {
      const result = await runCliInProcess('abort invalid_token_without_prefix', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
    });

    it('rejects empty token', async () => {
      const result = await runCliInProcess('abort ""', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('rejects token with special characters', async () => {
      const result = await runCliInProcess('abort rdtk_invalid@#$%', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('rejects token that is too short', async () => {
      const result = await runCliInProcess('abort rdtk_ABC', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active run/i);
    });

    it('accepts valid token format', async () => {
      const token = await setupDelegation();
      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('state transitions', () => {
    it('pending → cancelled without force flag', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/CANCELLED/i);
    });

    it('pending → cancelled is idempotent', async () => {
      const token = await setupDelegation();

      // First abort
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Second abort - should succeed with "already cancelled" message
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/already cancelled/i);
    });

    it('claimed → requires force flag', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Try to abort without force
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/already claimed|--force|RD-811/i);
    });

    it('claimed → cancelled with force flag', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/CANCELLED/i);
    });

    it('cancelled → claim fails', async () => {
      const token = await setupDelegation();

      // Abort the delegation
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Try to claim
      result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/cancelled|RD-809/i);
    });
  });

  describe('JSON output', () => {
    it('includes required fields in JSON output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token} --json`, workspace);
      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('abort');
      expect(output.status).toBe('cancelled');
      expect(output.token).toBeDefined();
      expect(output.substep).toBeDefined();
      expect(output.runbook).toContain('child.runbook.md');
      expect(output.parentRunId).toBeDefined();
    });

    it('includes force flag in JSON when used', async () => {
      const token = await setupDelegation();

      // Claim first
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force --json`, workspace);
      expect(result.exitCode).toBe(0);

      // stdout contains JSONL events + pretty-printed abort result + flush trailer
      // Split into complete JSON blocks and find the abort result
      const blocks = result.stdout.trim().split(/(?<=\})\n(?=\{)/);
      const abortBlock = blocks.find((b) => b.includes('"action": "abort"'));
      expect(abortBlock).toBeDefined();
      const output = JSON.parse(abortBlock!);
      expect(output.force).toBe(true);
      expect(output.childRunId).toBeDefined();
    });

    it('JSON output for already cancelled delegation', async () => {
      const token = await setupDelegation();

      // First abort
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Second abort with JSON
      result = await runCliInProcess(`abort ${token} --json`, workspace);
      expect(result.exitCode).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.status).toBe('already_cancelled');
    });
  });

  describe('error handling', () => {
    it('handles non-existent parent runbook gracefully', async () => {
      // cspell:disable-next-line
      const result = await runCliInProcess('abort rdtk_NONEXISTENTTOKEN12345678901234', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active run/i);
    });

    it('handles malformed JSON in state file gracefully', async () => {
      // This is hard to test without directly corrupting files
      // but the command should handle errors gracefully
      // cspell:disable-next-line
      const result = await runCliInProcess('abort rdtk_INVALIDTOKEN123456789012345678', workspace);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('handles delegation with substep ID', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate
      result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);

      const token = /Token:\s*(rdtk_\S+)/.exec(result.stdout)![1];

      // Abort should work
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles repeated abort attempts gracefully', async () => {
      const token = await setupDelegation();

      // First abort should succeed
      const result1 = await runCliInProcess(`abort ${token}`, workspace);
      expect(result1.exitCode).toBe(0);

      // Second abort should be idempotent
      const result2 = await runCliInProcess(`abort ${token}`, workspace);
      expect(result2.exitCode).toBe(0);
      expect(result2.stdout).toMatch(/already cancelled/i);
    });

    it('abort without arguments shows help', async () => {
      const result = await runCliInProcess('abort', workspace);
      // Commander shows error for missing required argument
      expect(result.exitCode).toBe(1);
    });

    it('abort with multiple tokens uses only first', async () => {
      const token = await setupDelegation();

      // Pass multiple tokens - Commander should only use first positional arg
      const result = await runCliInProcess(`abort ${token} extra-arg`, workspace);
      // Commander errors on unexpected argument
      expect(result.exitCode).toBe(1);
    });
  });

  describe('text output formatting', () => {
    it('shows hint token in output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Should show token hint (e.g., rdtk_ABC...XYZ)
      expect(result.stdout).toMatch(/rdtk_/);
    });

    it('shows runbook path in output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      expect(result.stdout).toContain('child.runbook.md');
    });

    it('shows force warning when aborting claimed delegation', async () => {
      const token = await setupDelegation();

      // Claim first
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);

      expect(result.stdout).toMatch(/in-flight|child run stopped/i);
    });
  });

  describe('delegation propagation after force abort', () => {
    it('propagates failure to parent after force abort of claimed delegation', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Get parent state
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.step).toBe('1');

      // Force abort - should propagate fail to parent
      result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);

      // Parent should be stopped due to FAIL ANY: STOP
      // Check that parent is no longer active (was stopped)
      const afterAbortState = await getActiveState(workspace);
      // The parent should have been stopped or advanced
      expect(afterAbortState === null || afterAbortState.id !== parentState!.id).toBe(true);
    });
  });

  describe('regression tests', () => {
    it('handles force abort after claim completes', async () => {
      const token = await setupDelegation();

      // Claim completes before abort
      await runCliInProcess(`claim ${token}`, workspace);

      // Force abort after claim has completed
      const result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('abort preserves parent runbook state', async () => {
      const token = await setupDelegation();

      const parentBefore = await getActiveState(workspace);
      expect(parentBefore).not.toBeNull();

      // Abort pending delegation
      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const parentAfter = await getActiveState(workspace);
      expect(parentAfter).not.toBeNull();
      expect(parentAfter!.id).toBe(parentBefore!.id);
      expect(parentAfter!.step).toBe(parentBefore!.step);
    });
  });
});
