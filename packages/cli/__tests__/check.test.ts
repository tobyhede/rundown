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

  it('checks an absolute runbook path outside the current project', async () => {
    const externalDir = fs.mkdtempSync(path.join(path.dirname(workspace.cwd), 'rd-external-'));
    try {
      const runbookPath = path.join(externalDir, 'external.runbook.md');
      fs.writeFileSync(
        runbookPath,
        `## 1. External step
- PASS COMPLETE

Do something.
`,
      );

      const result = await runCliInProcess(['check', runbookPath, '--text'], workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PASS:');
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
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
  - Step
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
  - Index
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
  - Date
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

  it('warns on a FOR source that is neither declared nor produced', async () => {
    const runbookPath = path.join(workspace.cwd, 'check-warn.runbook.md');
    fs.writeFileSync(
      runbookPath,
      [
        '# Check Warn',
        '## 1. Iterate',
        '- FOR item IN {{ Missing }}',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 Check',
        '- PASS CONTINUE',
        '- FAIL STOP',
        '',
        'do work',
        '',
      ].join('\n'),
    );

    const res = await runCliInProcess(['check', runbookPath], workspace);
    const json = JSON.parse(res.stdout);
    expect(json.valid).toBe(true);
    expect(json.warnings).toContainEqual(
      expect.objectContaining({
        message:
          'Step 1: FOR source "Missing" is neither a declared input nor produced by a step — ensure it is provided at runtime.',
      }),
    );
  });

  it('warns on a data-source FOR with multiple delegated refs (shared binding)', async () => {
    const runbookPath = path.join(workspace.cwd, 'check-multi-ref.runbook.md');
    fs.writeFileSync(
      runbookPath,
      [
        '---',
        'inputs:',
        '  - Tasks',
        '---',
        '# Check Multi Ref',
        '## 1. Iterate',
        '- FOR item IN {{ Tasks }}',
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
        '',
        '### 1.1 First',
        '- DELEGATE',
        '- child-a.runbook.md',
        '',
        '### 1.2 Second',
        '- DELEGATE',
        '- child-b.runbook.md',
        '',
      ].join('\n'),
    );

    const res = await runCliInProcess(['check', runbookPath], workspace);
    const json = JSON.parse(res.stdout);
    expect(json.valid).toBe(true);
    expect(json.warnings).toContainEqual(
      expect.objectContaining({
        message:
          'Step 1: FOR "Tasks" delegates 2 references per iteration; the loop item is shared across all of them (not paired). Use a single delegated reference for per-item-per-worker.',
      }),
    );
    // `Tasks` is a declared input, so the unsatisfiable-source warning must not co-fire.
    expect(json.warnings).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('is neither a declared input nor produced'),
      }),
    );
  });
});
