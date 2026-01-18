import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  listRunbookStates,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('status command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('displays current step info', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('status', workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows retryCount', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('status', workspace);

    // Status shows step information, retryCount is internal state
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
  });

  it('shows runbook ID', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('status', workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
  });

  it('outputs "No active runbook" when none', async () => {
    const result = runCli('status', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('shows pending steps count', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('run --step 2', workspace);

    const result = runCli('status', workspace);

    expect(result.stdout).toContain('Pending:');
  });

  it('shows agent bindings', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('run --step 1', workspace);
    runCli('run --agent test-agent', workspace);

    const result = runCli('status', workspace);

    expect(result.stdout).toContain('Agents:');
    expect(result.stdout).toContain('test-agent');
  });
});

describe('agent-scoped status', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('shows agent-specific runbook when --agent provided', async () => {
    // Start runbooks in different stacks (prompted to keep active)
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('run --prompted runbooks/retry.runbook.md --agent agent-001', workspace);

    // Default status shows default stack
    let result = runCli('status', workspace);
    expect(result.stdout).toContain('simple.runbook.md');

    // Agent status shows agent stack
    result = runCli('status --agent agent-001', workspace);
    expect(result.stdout).toContain('retry.runbook.md');
  });

  it('shows no active runbook for empty agent stack', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('status --agent nonexistent', workspace);
    expect(result.stdout).toContain('No active runbook');
  });
});

describe('ls command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('lists all runbook states', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('ls', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('marks active runbook', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('ls', workspace);

    expect(result.stdout).toContain('active');
  });

  it('shows current step for each', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('ls', workspace);

    expect(result.stdout).toContain('1/');
  });

  it('outputs "No active runbooks" when empty', async () => {
    const result = runCli('ls', workspace);

    expect(result.stdout).toContain('No active runbooks');
  });
});

describe('stop command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('deletes active runbook state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    runCli('stop', workspace);

    const states = await listRunbookStates(workspace);
    expect(states).toHaveLength(0);
  });

  it('clears active runbook', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    runCli('stop', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('outputs confirmation', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('stop', workspace);

    expect(result.stdout).toContain('STOP');
  });

  it('handles no active runbook gracefully', async () => {
    const result = runCli('stop', workspace);

    expect(result.stdout).toContain('No active runbook');
  });
});

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('marks runbook as complete', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('complete', workspace);

    expect(result.stdout).toContain('COMPLETE');
  });

  it('clears active runbook', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    runCli('complete', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles no active runbook', async () => {
    const result = runCli('complete', workspace);

    expect(result.stdout).toContain('No active runbook');
  });
});
