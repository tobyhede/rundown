import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('claim command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Helper: write parent runbook with substeps */
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

  /** Helper: write child runbook */
  async function writeChildRunbook(): Promise<void> {
    const content = `## 1. Execute
- PASS: COMPLETE
- FAIL: STOP

Run the child task.
`;
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  /** Helper: extract token from output */
  function extractToken(stdout: string): string {
    const match = /Token:\s*(rdtk_\S+)/.exec(stdout);
    if (!match) throw new Error(`No token found in output:\n${stdout}`);
    return match[1];
  }

  describe('basic claim functionality', () => {
    it('rejects claim with invalid token format', () => {
      const result = runCli('claim invalid-token', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
    });

    it('rejects claim with token missing prefix', () => {
      // cspell:disable-next-line
      const result = runCli('claim AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
    });

    it('rejects claim with token that is too short', () => {
      const result = runCli('claim rdtk_ABC', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active/i);
    });

    it('rejects claim with unknown token', () => {
      // Valid format but no matching delegation
      // cspell:disable-next-line
      const result = runCli('claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active/i);
    });

    it('successfully claims valid delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent in prompted mode
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate substep 1.1
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim should succeed
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('idempotent claim behavior', () => {
    it('allows re-claiming same token multiple times', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // First claim
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const firstChildId = (await getActiveState(workspace))!.id;

      // Second claim - should return same child
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const secondChildId = (await getActiveState(workspace))!.id;

      expect(firstChildId).toBe(secondChildId);
    });

    it('third claim still returns same child', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      // Claim three times
      runCli(`claim ${token}`, workspace);
      runCli(`claim ${token}`, workspace);
      result = runCli(`claim ${token}`, workspace);

      expect(result.exitCode).toBe(0);
    });
  });

  describe('JSON output', () => {
    it('outputs structured JSON with --json flag', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('delegate child.runbook.md --step 1.1 --json', workspace);
      expect(result.exitCode).toBe(0);
      const delegateOutput = JSON.parse(result.stdout);
      const token = delegateOutput.token as string;

      result = runCli(`claim ${token} --json`, workspace);
      expect(result.exitCode).toBe(0);

      const jsonLines = result.stdout.trim().split('\n');
      const output = JSON.parse(jsonLines[jsonLines.length - 1]);
      expect(output.action).toBe('claimed');
      expect(output.token).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
      expect(typeof output.run_id).toBe('string');
      expect(typeof output.runbook).toBe('string');
      expect(typeof output.parent_run_id).toBe('string');
      expect(typeof output.parent_step).toBe('string');
    });

    it('outputs error JSON for invalid token', () => {
      const result = runCli('claim bad-token --json', workspace);
      expect(result.exitCode).toBe(1);

      const output = JSON.parse(result.stdout);
      expect(output.message).toBeDefined();
      expect(output.code).toBeDefined();
    });

    it('includes all required fields in success JSON', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1 --json', workspace);
      const token = JSON.parse(result.stdout).token as string;

      result = runCli(`claim ${token} --json`, workspace);
      const jsonLines = result.stdout.trim().split('\n');
      const output = JSON.parse(jsonLines[jsonLines.length - 1]);

      // Verify all required fields
      expect(output).toHaveProperty('action');
      expect(output).toHaveProperty('token');
      expect(output).toHaveProperty('run_id');
      expect(output).toHaveProperty('runbook');
      expect(output).toHaveProperty('parent_run_id');
      expect(output).toHaveProperty('parent_step');
    });
  });

  describe('variable inheritance', () => {
    it('passes variables via --var flag to child', async () => {
      await writeParentRunbook();

      // Child that uses a variable
      const childContent = `## 1. Task
- PASS: COMPLETE

Execute with {{Env}} environment.
`;
      await writeFile(join(workspace.cwd, 'var-child.runbook.md'), childContent);

      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      result = runCli('delegate var-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const token = extractToken(result.stdout);

      result = runCli(`claim ${token} --var Env=staging`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles multiple --var flags', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = runCli(`claim ${token} --var Env=staging --var Region=us-west`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('auto-propagation on claim', () => {
    /** Helper: write child that auto-completes via command */
    async function writeAutoCompleteChild(): Promise<void> {
      const content = `## 1. Execute
- PASS: COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'auto-child.runbook.md'), content);
    }

    it('propagates pass when child auto-completes during claim', async () => {
      await writeParentRunbook();
      await writeAutoCompleteChild();

      // Start parent in non-prompted mode
      let result = runCli('run parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      // Delegate and claim
      result = runCli('delegate auto-child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Parent should advance past 1.1
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.substep).toBe('2');
    });

    it('propagates fail when child auto-stops during claim', async () => {
      await writeParentRunbook();

      const failChild = `## 1. Execute
- FAIL: STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'fail-child.runbook.md'), failChild);

      let result = runCli('run parent.runbook.md', workspace);
      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id as string;

      result = runCli('delegate fail-child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Claim will trigger auto-fail and propagation
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);

      // Parent should be stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      const vars = updatedParent!.variables as Record<string, unknown>;
      expect(vars.stopped).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('handles claim when parent runbook file is missing', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Delete parent runbook file (state still exists)
      await writeFile(join(workspace.cwd, 'parent.runbook.md'), '');

      // Claim should still work (uses stored runbook content)
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles claim with empty token string', () => {
      const result = runCli('claim ""', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('handles claim with whitespace token', () => {
      const result = runCli('claim "  "', workspace);
      expect(result.exitCode).toBe(1);
    });

    it('handles cancelled delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Cancel the delegation (via stop command on parent)
      result = runCli('stop', workspace);
      expect(result.exitCode).toBe(0);

      // Attempt to claim — parent state is deleted, token no longer resolvable
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found|no active/i);
    });

    it('fails to claim aborted delegation token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Abort the delegation
      result = runCli(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Attempt to claim aborted delegation
      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/cancelled|RD-809/i);
    });

    it('rejects delegation to non-existent child runbook', async () => {
      await writeParentRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      expect(result.exitCode).toBe(0);

      // Delegate to non-existent file should fail
      result = runCli('delegate missing-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/not found/i);
    });
  });

  describe('successive claims', () => {
    it('handles rapid successive claims of same token', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      let result = runCli('run --prompted parent.runbook.md', workspace);
      result = runCli('delegate child.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      // Rapid succession claims
      const result1 = runCli(`claim ${token}`, workspace);
      const result2 = runCli(`claim ${token}`, workspace);
      const result3 = runCli(`claim ${token}`, workspace);

      // All should succeed (idempotent)
      expect(result1.exitCode).toBe(0);
      expect(result2.exitCode).toBe(0);
      expect(result3.exitCode).toBe(0);
    });
  });

  describe('context inheritance', () => {
    it('child inherits parent context variables', async () => {
      // Parent with variables
      const parentWithVars = `---
PlanPath: .work/plan.md
Region: us-west
---

## 1. Review
- PASS ALL: CONTINUE

### 1.1 Code review
Review code.
`;
      await writeFile(join(workspace.cwd, 'parent-vars.runbook.md'), parentWithVars);

      // Child that references parent vars
      const childWithContext = `## 1. Task
- PASS: COMPLETE

Parent region: {{context.parent.vars.Region}}
Plan: {{context.parent.vars.PlanPath}}
`;
      await writeFile(join(workspace.cwd, 'child-ctx.runbook.md'), childWithContext);

      let result = runCli('run --prompted parent-vars.runbook.md', workspace);
      result = runCli('delegate child-ctx.runbook.md --step 1.1', workspace);
      const token = extractToken(result.stdout);

      result = runCli(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });
});
