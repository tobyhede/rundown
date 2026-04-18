import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from './helpers/test-utils.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('rd check', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('outputs PASS with step count for valid runbook', async () => {
    const runbookPath = path.join(workspace.cwd, 'valid.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. First step
- PASS CONTINUE

Do something.

## 2. Second step
- PASS COMPLETE

Do another thing.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
    expect(result.stdout).toContain('2 steps');
  });

  it('outputs FAIL with all errors for invalid runbook', async () => {
    const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. First step
- PASS CONTINUE

Do something.

## 3. Third step (skipped 2)
- PASS GOTO 99

Do another thing.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses both console.log and console.error
    const output = result.stdout + result.stderr;
    expect(output).toContain('FAIL');
    // Should report sequencing error when steps are not consecutive
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('includes line numbers in error output', async () => {
    const runbookPath = path.join(workspace.cwd, 'invalid.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. First step
- PASS CONTINUE

Do something.

## 3. Third step
- PASS COMPLETE

Missing step 2.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(1);
    // Check both stdout and stderr since validate uses console.error for failures
    const output = result.stdout + result.stderr;
    // Error messages should contain descriptive error information with line numbers
    expect(output).toContain('FAIL');
    expect(output).toMatch(/Line \d+:/);
    expect(output).toMatch(/sequentially|sequential/i);
  });

  it('outputs PASS with warnings for GOTO self runbook', async () => {
    const runbookPath = path.join(workspace.cwd, 'goto-self.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1 Step
- FAIL GOTO 1

Do something.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
    expect(result.stdout).toContain('GOTO self');
  });

  it('outputs FAIL for non-existent file', async () => {
    const result = await runCliInProcess('check /nonexistent/path/runbook.md --text', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr || result.stdout).toContain('FAIL');
    expect(result.stderr || result.stdout).toMatch(/not found|does not exist/i);
  });

  it('outputs FAIL for frontmatter var using reserved name Step', async () => {
    const runbookPath = path.join(workspace.cwd, 'reserved.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
inputs:
  Step: custom
---
## 1. Do something
- PASS COMPLETE

Hello.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('FAIL');
    expect(output).toMatch(/reserved/i);
  });

  it('outputs FAIL for frontmatter var using reserved name Index (case-insensitive)', async () => {
    const runbookPath = path.join(workspace.cwd, 'reserved-index.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
inputs:
  Index: 5
---
## 1. Do something
- PASS COMPLETE

Hello.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('FAIL');
    expect(output).toMatch(/reserved/i);
  });

  it('outputs PASS for frontmatter var using overridable built-in Date', async () => {
    const runbookPath = path.join(workspace.cwd, 'builtin.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `---
inputs:
  Date: "2025-01-01"
---
## 1. Do something
- PASS COMPLETE

Hello.
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
  });

  it('passes check for runbook with RunbookRef template variable', async () => {
    const runbookPath = path.join(workspace.cwd, 'meta.runbook.md');
    fs.writeFileSync(
      runbookPath,
      `## 1. Execute
- {{ TargetRunbook }}
`,
    );

    const result = await runCliInProcess(`check ${runbookPath} --text`, workspace);

    // check only parses, doesn't resolve variables — should pass
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('PASS:');
  });
});
