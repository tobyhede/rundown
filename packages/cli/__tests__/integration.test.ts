import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  getActiveState,
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

  it('completes simple two-step runbook', async () => {
    // Start runbook (prompted mode to test manual pass/fail flow)
    let result = runCli('run --prompted runbooks/simple.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');

    // Advance to step 2
    result = runCli('pass --text', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 2');

    // Complete runbook
    result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('COMPLETE');

    // Verify no active runbook
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles retry then success flow', async () => {
    runCli('run --prompted runbooks/retry.runbook.md --text', workspace);

    // Fail first attempt
    let result = runCli('fail --text', workspace);
    expect(result.stdout).toContain('Action:   RETRY (1/');

    // Fail second attempt
    result = runCli('fail --text', workspace);
    expect(result.stdout).toContain('Action:   RETRY (2/');

    // Pass third attempt
    result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('## 2');

    // Complete
    result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles GOTO flow', async () => {
    runCli('run --prompted runbooks/goto.runbook.md --text', workspace);

    // Pass step 1 which GOTOs step 3
    let result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('## 3');

    // Verify we're at step 3
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('3');

    // Complete from step 3
    result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles stash and pop during runbook', async () => {
    runCli('run --prompted runbooks/simple.runbook.md --text', workspace);
    runCli('pass --text', workspace); // Advance to step 2

    // Stash
    let result = runCli('stash --text', workspace);
    expect(result.stdout).toContain('STASHED');

    // Verify no active runbook
    result = runCli('status --text', workspace);
    expect(result.stdout).toContain('STASHED');

    // Pop
    result = runCli('pop --text', workspace);
    expect(result.stdout).toContain('Second step');
    expect(result.stdout).toContain('## 2');

    // Continue and complete
    result = runCli('pass --text', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });
});
