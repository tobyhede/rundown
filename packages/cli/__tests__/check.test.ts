import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from './helpers/test-utils.js';
import * as fs from 'fs';
import * as path from 'path';

describe('rd check', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('outputs PASS with step count for valid workflow', () => {
    const workflowPath = path.join(workspace.cwd, 'valid.runbook.md');
    fs.writeFileSync(workflowPath, `## 1. First step

Do something.

- PASS: CONTINUE

## 2. Second step

Do another thing.

- PASS: COMPLETE
`);

    const result = runCli(`check ${workflowPath}`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
    expect(result.stdout).toContain('2 steps');
  });

  it('outputs FAIL with all errors for invalid workflow', () => {
    const workflowPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(workflowPath, `## 1. First step

Do something.

- PASS: CONTINUE

## 3. Third step (skipped 2)

Do another thing.

- PASS: GOTO 99
`);

    const result = runCli(`check ${workflowPath}`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses both console.log and console.error
    const output = result.stdout + result.stderr;
    expect(output).toContain('FAIL');
    // Should report sequencing error when steps are not consecutive
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('includes line numbers in error output', () => {
    const workflowPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(workflowPath, `## 1. First step

Do something.

- PASS: CONTINUE

## 3. Third step

Missing step 2.

- PASS: COMPLETE
`);

    const result = runCli(`check ${workflowPath}`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses console.error for failures
    const output = result.stdout + result.stderr;
    // Error messages should contain descriptive error information with line numbers
    expect(output).toContain('FAIL');
    expect(output).toMatch(/Line \d+:/);
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('outputs FAIL for non-existent file', () => {
    const result = runCli('check /nonexistent/path/workflow.md', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('FAIL');
    expect(result.stderr || result.stdout).toMatch(/not found|does not exist/i);
  });
});
