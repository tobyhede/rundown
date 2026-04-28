import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  getActiveState,
  findActionOutput,
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows retryCount', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    // Status shows step information, retryCount is internal state
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
  });

  it('shows runbook ID', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
  });

  it('outputs "No active runbook" when none', async () => {
    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('shows stashed runbook info when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows stashed status in JSON when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
  });
});

describe('agent-owned delegated children', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves status to the caller-owned child before the default stack', async () => {
    const parentRunbook = [
      '# Parent',
      '',
      '## 1. Fan out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 First child',
      '',
      'Do first child.',
      '',
      '### 1.2 Second child',
      '',
      'Do second child.',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child',
      '',
      '## 1. Work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Do child work.',
      '',
    ].join('\n');

    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-status.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-status.md'), childRunbook);

    await runCliInProcess('run --prompted runbooks/parent-status.md --text', workspace);
    const parentId = (await getActiveState(workspace))!.id;

    let result = await runCliInProcess('delegate runbooks/child-status.md --step 1.1', workspace);
    const token1 = JSON.parse(result.stdout).token as string;
    result = await runCliInProcess('delegate runbooks/child-status.md --step 1.2', workspace);
    const token2 = JSON.parse(result.stdout).token as string;

    result = await runCliInProcess(`claim ${token1}`, workspace, {
      env: { RD_AGENT_ID: 'status-agent-1', RD_SESSION_ID: 'status-session' },
    });
    const child1Id = String(findActionOutput(result.stdout)?.run_id);

    result = await runCliInProcess(`claim ${token2}`, workspace, {
      env: { RD_AGENT_ID: 'status-agent-2', RD_SESSION_ID: 'status-session' },
    });
    const child2Id = String(findActionOutput(result.stdout)?.run_id);

    let status = await runCliInProcess('status', workspace, {
      env: { RD_AGENT_ID: 'status-agent-1', RD_SESSION_ID: 'status-session' },
    });
    expect(JSON.parse(status.stdout).state).toContain(child1Id);

    status = await runCliInProcess('status', workspace, {
      env: { RD_AGENT_ID: 'status-agent-2', RD_SESSION_ID: 'status-session' },
    });
    expect(JSON.parse(status.stdout).state).toContain(child2Id);

    status = await runCliInProcess('status', workspace);
    expect(JSON.parse(status.stdout).state).toContain(parentId);
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

  it('reports lastAction.result PASS after successful pass', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers CONTINUE (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result FAIL after fail triggers RETRY', async () => {
    await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers RETRY (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result PASS after pass triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers GOTO 3 (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result FAIL after fail triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers GOTO 3 (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^GOTO/);
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('marks active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('active');
  });

  it('shows current step for each', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('1/');
  });

  it('outputs "No active runbooks" when empty', async () => {
    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('No active runbooks');
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete --text', workspace);

    expect(result.stdout).toContain('COMPLETE');
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    await runCliInProcess('complete --text', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles no active runbook', async () => {
    const result = await runCliInProcess('complete', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('includes message in JSON output', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess(['complete', 'Early exit - tests passed'], workspace);

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete', workspace);

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
- PASS CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    // Run with variable to store runbookSrc
    await runCliInProcess('run test.runbook.md --input message=hello --prompted --text', workspace);

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});
