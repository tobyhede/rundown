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

  it('outputs PASS with step count for valid runbook', () => {
    const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
    fs.writeFileSync(runbookPath, `## 1. First step
- PASS: CONTINUE

Do something.

## 2. Second step
- PASS: COMPLETE

Do another thing.
`);

    const result = runCli(`check ${runbookPath}`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
    expect(result.stdout).toContain('2 steps');
  });

  it('outputs FAIL with all errors for invalid runbook', () => {
    const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(runbookPath, `## 1. First step
- PASS: CONTINUE

Do something.

## 3. Third step (skipped 2)
- PASS: GOTO 99

Do another thing.
`);

    const result = runCli(`check ${runbookPath}`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses both console.log and console.error
    const output = result.stdout + result.stderr;
    expect(output).toContain('FAIL');
    // Should report sequencing error when steps are not consecutive
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('includes line numbers in error output', () => {
    const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(runbookPath, `## 1. First step
- PASS: CONTINUE

Do something.

## 3. Third step
- PASS: COMPLETE

Missing step 2.
`);

    const result = runCli(`check ${runbookPath}`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses console.error for failures
    const output = result.stdout + result.stderr;
    // Error messages should contain descriptive error information with line numbers
    expect(output).toContain('FAIL');
    expect(output).toMatch(/Line \d+:/);
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('outputs FAIL for non-existent file', () => {
    const result = runCli('check /nonexistent/path/runbook.md', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('FAIL');
    expect(result.stderr || result.stdout).toMatch(/not found|does not exist/i);
  });
});
