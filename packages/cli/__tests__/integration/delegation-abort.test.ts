import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Delegation abort integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
            },
            { title: 'Security review', delegate: true, content: 'Do security review.' },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), content);
  }

  /** Helper: start parent, delegate, return token. */
  async function setupDelegation(): Promise<string> {
    await writeParentRunbook();
    await writeChildRunbook();

    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);

    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    return tokenMatch![1];
  }

  it('rejects invalid token format', () => {
    const result = runCli('abort bad-token --text', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
  });

  it('rejects unknown token', () => {
    // cspell:disable-next-line
    const result = runCli('abort rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH --text', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not found|no active run/i);
  });

  it('pending abort succeeds', async () => {
    const token = await setupDelegation();

    const result = runCli(`abort ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CANCELLED/i);
  });

  it('claim after abort fails with RD-809', async () => {
    const token = await setupDelegation();

    // Abort the delegation
    let result = runCli(`abort ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to claim — should fail
    result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/cancelled|RD-809/i);
  });

  it('claimed abort without --force fails with RD-811', async () => {
    const token = await setupDelegation();

    // Claim the token
    let result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);

    // Try to abort without force — should fail
    result = runCli(`abort ${token} --text`, workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/already claimed|--force|RD-811/i);
  });

  it('claimed abort with --force succeeds', async () => {
    const token = await setupDelegation();

    // Claim the token
    let result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);

    // Force abort
    result = runCli(`abort ${token} --force --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/CANCELLED/i);
  });

  it('idempotent on already-cancelled', async () => {
    const token = await setupDelegation();

    // Abort twice
    let result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    result = runCli(`abort ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/already cancelled/i);
  });

  it('JSON output structure', async () => {
    const token = await setupDelegation();

    const result = runCli(`abort ${token}`, workspace);
    expect(result.exitCode).toBe(0);

    const output = JSON.parse(result.stdout);
    expect(output.action).toBe('abort');
    expect(output.status).toBe('cancelled');
    expect(output.token).toBeDefined();
    expect(output.substep).toBeDefined();
    expect(output.runbook).toContain('child.runbook.md');
    expect(output.parentRunId).toBeDefined();
  });
});
