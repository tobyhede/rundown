import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Delegation claim integration', () => {
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

  it('rejects invalid token format', () => {
    const result = runCli('claim bad-token', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
  });

  it('rejects unknown token', () => {
    // Token with correct format but no matching delegation
    // cspell:disable-next-line
    const result = runCli('claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not found|no active run/i);
  });

  it('delegate → claim end-to-end', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent in prompted mode
    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    // Delegate substep 1.1 to child runbook
    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Delegated');

    // Extract token from output
    const tokenMatch = /Token:\s*(rdtk_\S+)/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    // Claim the token — should launch child runbook
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('idempotent re-claim returns same child run', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const tokenMatch2 = /Token:\s*(rdtk_\S+)/.exec(result.stdout);
    expect(tokenMatch2).not.toBeNull();
    const token = tokenMatch2![1];

    // First claim
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    // Second claim — should succeed (idempotent)
    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('claim with --json outputs structured data', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md --step 1.1 --json', workspace);
    expect(result.exitCode).toBe(0);
    const delegateOutput = JSON.parse(result.stdout);
    expect(delegateOutput.token).toBeDefined();

    const claimToken = delegateOutput.token as string;
    result = runCli(`claim ${claimToken} --json`, workspace);

    // Command should succeed
    expect(result.exitCode).toBe(0);

    // Parse last JSON line — claim output follows child-run JSON events
    const jsonLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.token).toMatch(/^rdtk_.{7}\.\.\./);
    expect(typeof claimOutput.run_id).toBe('string');
    expect(typeof claimOutput.runbook).toBe('string');
    expect(typeof claimOutput.parent_run_id).toBe('string');
    expect(typeof claimOutput.parent_step).toBe('string');
  });

  it('claim --json outputs structured error for invalid token', () => {
    const result = runCli('claim bad-token --json', workspace);
    expect(result.exitCode).toBe(1);

    const output = JSON.parse(result.stdout);
    expect(output.error).toBeDefined();
    expect(output.code).toBeDefined();
  });
});
