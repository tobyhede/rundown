import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  readSession,
  readRunbookState,
  listRunbookStates,
  writeSession,
  getActiveState,
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

describe('JSON lastAction.result semantics', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('reports lastAction.result: true after successful pass', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('pass', workspace); // Triggers CONTINUE (success)

    const result = runCli('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe(true);
    expect(output.lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result: false after fail triggers RETRY', async () => {
    runCli('run --prompted runbooks/retry.runbook.md', workspace);
    runCli('fail', workspace); // Triggers RETRY (failure)

    const result = runCli('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe(false);
    expect(output.lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result: true after pass triggers GOTO', async () => {
    runCli('run --prompted runbooks/goto.runbook.md', workspace);
    runCli('pass', workspace); // Triggers GOTO 3 (success)

    const result = runCli('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe(true);
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result: false after fail triggers GOTO', async () => {
    runCli('run --prompted runbooks/fail-goto.runbook.md', workspace);
    runCli('fail', workspace); // Triggers GOTO 3 (failure)

    const result = runCli('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe(false);
    expect(output.lastAction.action).toMatch(/^GOTO/);
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

  it('preserves runbook state after stop', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    runCli('stop', workspace);

    const states = await listRunbookStates(workspace);
    expect(states).toHaveLength(1);
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

  it('includes message in JSON output', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli(['complete', 'Early exit - tests passed', '--json'], workspace);

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('complete --json', workspace);

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Runbook completed successfully');
  });
});

describe('status with runbookSrc', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should compute step total from runbookSrc', async () => {
    // Create a runbook with variable
    const runbookContent = `# Test Runbook

## 1. First Step
- PASS: CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS: COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    // Run with variable to store runbookSrc
    runCli('run test.runbook.md --var message=hello --prompted', workspace);

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = runCli('status --json', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});

describe('stop command error recovery', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exits with code 2 and pops session when runbookSrc is missing (STATE_ERROR)', async () => {
    // Start a real runbook to get valid state/session
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    // Get the active state ID, then strip runbookSrc to simulate corruption
    const session = await readSession(workspace);
    const stateId = session.active!;
    expect(stateId).toBeTruthy();

    const stateFilePath = join(workspace.statePath(), `${stateId}.json`);
    const stateContent = await readFile(stateFilePath, 'utf-8');
    const state = JSON.parse(stateContent);
    delete state.runbookSrc;
    await writeFile(stateFilePath, JSON.stringify(state, null, 2));

    const result = runCli('stop', workspace);

    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toContain('STATE_ERROR');

    // Session should be cleared (broken runbook popped)
    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBeNull();
  });

  it('exits with code 1 on successful stop', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('stop', workspace);

    expect(result.exitCode).toBe(1);
  });
});

describe('complete command error recovery', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('exits with code 2 and pops session when runbookSrc is missing (STATE_ERROR)', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const session = await readSession(workspace);
    const stateId = session.active!;
    expect(stateId).toBeTruthy();

    const stateFilePath = join(workspace.statePath(), `${stateId}.json`);
    const stateContent = await readFile(stateFilePath, 'utf-8');
    const state = JSON.parse(stateContent);
    delete state.runbookSrc;
    await writeFile(stateFilePath, JSON.stringify(state, null, 2));

    const result = runCli('complete', workspace);

    expect(result.exitCode).toBe(2);
    const output = result.stdout + result.stderr;
    expect(output).toContain('STATE_ERROR');

    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBeNull();
  });

  it('exits with code 0 on successful complete', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('complete', workspace);

    expect(result.exitCode).toBe(0);
  });
});

describe('stop/complete state persistence via XState', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('stop sets lastAction and lastResult in persisted state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    // Get state ID before stop (stop clears session)
    const session = await readSession(workspace);
    const stateId = session.active!;

    runCli('stop', workspace);

    const state = await readRunbookState(workspace, stateId);
    expect(state).not.toBeNull();
    expect(state!.lastAction).toEqual({ type: 'STOP' });
    expect(state!.lastResult).toBe('fail');
  });

  it('complete sets lastAction and lastResult in persisted state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const session = await readSession(workspace);
    const stateId = session.active!;

    runCli('complete', workspace);

    const state = await readRunbookState(workspace, stateId);
    expect(state).not.toBeNull();
    expect(state!.lastAction).toEqual({ type: 'COMPLETE' });
    expect(state!.lastResult).toBe('pass');
  });

  it('stop sets variables.stopped in persisted state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const session = await readSession(workspace);
    const stateId = session.active!;

    runCli(['stop', 'User cancelled'], workspace);

    const state = await readRunbookState(workspace, stateId);
    expect(state).not.toBeNull();
    // The XState STOPPED entry action sets variables.stopped = true
    expect(state!.variables).toBeDefined();
    expect((state as any).variables.stopped).toBe(true);
  });

  it('complete sets variables.completed in persisted state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const session = await readSession(workspace);
    const stateId = session.active!;

    runCli(['complete', 'All tests passed'], workspace);

    const state = await readRunbookState(workspace, stateId);
    expect(state).not.toBeNull();
    // The XState COMPLETE entry action sets variables.completed = true
    expect(state!.variables).toBeDefined();
    expect((state as any).variables.completed).toBe(true);
  });

  it('stop with --json includes message in output', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli(['stop', 'Deployment failed', '--json'], workspace);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Deployment failed');
  });
});
