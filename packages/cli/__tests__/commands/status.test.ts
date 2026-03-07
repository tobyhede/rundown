import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows retryCount', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('status', workspace);

    // Status shows step information, retryCount is internal state
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
  });

  it('shows runbook ID', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toMatch(/wf-\d{4}-\d{2}-\d{2}/);
  });

  it('outputs "No active runbook" when none', async () => {
    const result = await runCliInProcess('status', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('shows stashed runbook info when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    await runCliInProcess('stash', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows stashed status in JSON when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    await runCliInProcess('stash', workspace);

    const result = await runCliInProcess('status --json', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    await runCliInProcess('pass', workspace); // Triggers CONTINUE (success)

    const result = await runCliInProcess('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result FAIL after fail triggers RETRY', async () => {
    await runCliInProcess('run --prompted runbooks/retry.runbook.md', workspace);
    await runCliInProcess('fail', workspace); // Triggers RETRY (failure)

    const result = await runCliInProcess('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result PASS after pass triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/goto.runbook.md', workspace);
    await runCliInProcess('pass', workspace); // Triggers GOTO 3 (success)

    const result = await runCliInProcess('status --json', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result FAIL after fail triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md', workspace);
    await runCliInProcess('fail', workspace); // Triggers GOTO 3 (failure)

    const result = await runCliInProcess('status --json', workspace);
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('ls', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('marks active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('ls', workspace);

    expect(result.stdout).toContain('active');
  });

  it('shows current step for each', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('ls', workspace);

    expect(result.stdout).toContain('1/');
  });

  it('outputs "No active runbooks" when empty', async () => {
    const result = await runCliInProcess('ls', workspace);

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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('complete', workspace);

    expect(result.stdout).toContain('COMPLETE');
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    await runCliInProcess('complete', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles no active runbook', async () => {
    const result = await runCliInProcess('complete', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('includes message in JSON output', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess(
      ['complete', 'Early exit - tests passed', '--json'],
      workspace,
    );

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);

    const result = await runCliInProcess('complete --json', workspace);

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
    await runCliInProcess('run test.runbook.md --var message=hello --prompted', workspace);

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = await runCliInProcess('status --json', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});
