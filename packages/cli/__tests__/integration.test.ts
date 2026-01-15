import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  getActiveState,
  type TestWorkspace,
} from './helpers/test-utils.js';

describe('integration: full workflow scenarios', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('completes simple two-step workflow', async () => {
    // Start workflow (prompted mode to test manual pass/fail flow)
    let result = runCli('run --prompted runbooks/simple.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');

    // Advance to step 2
    result = runCli('pass', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 2');

    // Complete workflow
    result = runCli('pass', workspace);
    expect(result.stdout).toContain('COMPLETE');

    // Verify no active runbook
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles retry then success flow', async () => {
    runCli('run --prompted runbooks/retry.runbook.md', workspace);

    // Fail first attempt
    let result = runCli('fail', workspace);
    expect(result.stdout).toContain('Action:   RETRY (1/');

    // Fail second attempt
    result = runCli('fail', workspace);
    expect(result.stdout).toContain('Action:   RETRY (2/');

    // Pass third attempt
    result = runCli('pass', workspace);
    expect(result.stdout).toContain('## 2');

    // Complete
    result = runCli('pass', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles GOTO flow', async () => {
    runCli('run --prompted runbooks/goto.runbook.md', workspace);

    // Pass step 1 which GOTOs step 3
    let result = runCli('pass', workspace);
    expect(result.stdout).toContain('## 3');

    // Verify we're at step 3
    const state = await getActiveState(workspace);
    expect(state?.step).toBe('3');

    // Complete from step 3
    result = runCli('pass', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles stash and pop during workflow', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('pass', workspace); // Advance to step 2

    // Stash
    let result = runCli('stash', workspace);
    expect(result.stdout).toContain('STASHED');

    // Verify no active runbook
    result = runCli('status', workspace);
    expect(result.stdout).toContain('STASHED');

    // Pop
    result = runCli('pop', workspace);
    expect(result.stdout).toContain('Second step');
    expect(result.stdout).toContain('## 2');

    // Continue and complete
    result = runCli('pass', workspace);
    expect(result.stdout).toContain('COMPLETE');
  });

  it('handles agent binding workflow', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    // Queue steps for agents
    runCli('run --step 1', workspace);
    runCli('run --step 2', workspace);

    // Bind first agent
    let result = runCli('run --agent agent-1', workspace);
    expect(result.stdout).toContain('agent-1');
    expect(result.stdout).toContain('bound');

    // Bind second agent
    result = runCli('run --agent agent-2', workspace);
    expect(result.stdout).toContain('agent-2');
    expect(result.stdout).toContain('bound');

    // Check status shows both agents
    result = runCli('status', workspace);
    expect(result.stdout).toContain('agent-1');
    expect(result.stdout).toContain('agent-2');

    // Complete agents
    result = runCli('pass --agent agent-1', workspace);
    expect(result.stdout).toContain('pass');

    result = runCli('pass --agent agent-2', workspace);
    expect(result.stdout).toContain('All agents complete');
  });
});