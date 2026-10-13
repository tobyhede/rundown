import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  runCli,
  type TestWorkspace,
} from './helpers/test-utils.js';

describe('integration: full runbook scenarios', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Start a prompted run and return the token and id printed on runbook_started. */
  function start(runbook: string): { token: string; runId: string } {
    const started = runCli(`run --prompted ${runbook}`, workspace);
    expect(started.exitCode).toBe(0);
    return { token: requireOwnerToken(started.stdout), runId: requireRunId(started.stdout) };
  }

  it('completes simple two-step runbook', () => {
    const { token, runId } = start('runbooks/simple.runbook.md');

    // Advance to step 2
    let result = runCli(`pass --token ${token} --step 1 --text`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 2');

    // Complete runbook
    result = runCli(`pass --token ${token} --step 2 --text`, workspace);
    expect(result.stdout).toContain('COMPLETE');

    // The run is finished: a late command is refused as RD-303.
    result = runCli(`pass --token ${token} --step 2`, workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"code": "RD-303"');
    const status = runCli(`status --run ${runId}`, workspace);
    expect(JSON.parse(status.stdout)).toMatchObject({ active: false, status: 'completed' });
  });

  it('handles retry then success flow', () => {
    const { token } = start('runbooks/retry.runbook.md');

    // Fail first attempt
    let result = runCli(`fail --token ${token} --step 1 --text`, workspace);
    expect(result.stdout).toContain('Action:   RETRY (1/');

    // Fail second attempt
    result = runCli(`fail --token ${token} --step 1 --text`, workspace);
    expect(result.stdout).toContain('Action:   RETRY (2/');

    // Pass third attempt
    result = runCli(`pass --token ${token} --step 1 --text`, workspace);
    expect(result.stdout).toContain('## 2');

    // Complete
    result = runCli(`pass --token ${token} --step 2 --text`, workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles GOTO flow', async () => {
    const { token, runId } = start('runbooks/goto.runbook.md');

    // Pass step 1 which GOTOs step 3
    let result = runCli(`pass --token ${token} --step 1 --text`, workspace);
    expect(result.stdout).toContain('## 3');

    // Verify we're at step 3
    const state = await readRunbookState(workspace, runId);
    expect(state?.step).toBe('3');

    // Complete from step 3
    result = runCli(`pass --token ${token} --step 3 --text`, workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('refuses a stale --step and leaves the run where it was', async () => {
    const { token, runId } = start('runbooks/simple.runbook.md');
    runCli(`pass --token ${token} --step 1`, workspace); // Advance to step 2

    const stale = runCli(`pass --token ${token} --step 1`, workspace);
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ code: 'INVALID_STEP' });

    const state = await readRunbookState(workspace, runId);
    expect(state?.step).toBe('2');

    // Continue and complete
    const result = runCli(`pass --token ${token} --step 2 --text`, workspace);
    expect(result.stdout).toContain('COMPLETE');
  });
});
