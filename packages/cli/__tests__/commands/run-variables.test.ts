import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

describe('rd run --input and --input-file', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should accept --input-file option', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    await writeFile(join(workspace.cwd, 'vars.yaml'), 'message: hello');

    const result = await runCliInProcess(
      'run test.runbook.md --input-file vars.yaml --text',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('should accept --input option', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --input message=world --text',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('world');
  });

  it('should allow multiple --input options', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{a}} {{b}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --input a=first --input b=second --text',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });

  it('should inherit env var value with --input KEY (no =)', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{MY_TEST_VAR}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    process.env.MY_TEST_VAR = 'inherited-value';
    try {
      const result = await runCliInProcess(
        'run test.runbook.md --input MY_TEST_VAR --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('inherited-value');
    } finally {
      delete process.env.MY_TEST_VAR;
    }
  });

  it('should merge multiple --input-file options', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{alpha}} {{beta}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);
    await writeFile(join(workspace.cwd, 'a.yaml'), 'alpha: from-a');
    await writeFile(join(workspace.cwd, 'b.yaml'), 'beta: from-b');

    const result = await runCliInProcess(
      'run test.runbook.md --input-file a.yaml --input-file b.yaml --text',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('from-a');
    expect(result.stdout).toContain('from-b');
  });

  it('should pick up RD_INPUT_* environment variables', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const prevMessage = process.env.RD_INPUT_message;
    process.env.RD_INPUT_message = 'hello-from-env';
    try {
      const result = await runCliInProcess('run test.runbook.md --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-from-env');
    } finally {
      if (prevMessage === undefined) {
        delete process.env.RD_INPUT_message;
      } else {
        process.env.RD_INPUT_message = prevMessage;
      }
    }
  });

  it('should accept --input-json for inline JSON values', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{count}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --input-json count=42 --text',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('42');
  });

  it('should reject malformed --input-json values', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{count}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --input-json count=not-json --text',
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toContain('count');
  });
});
