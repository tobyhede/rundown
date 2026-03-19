import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, runCliInProcess, type TestWorkspace } from '../helpers/test-utils.js';

describe('rd run --var and --var-file', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should accept --var-file option', async () => {
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
      'run test.runbook.md --var-file vars.yaml --json',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('should accept --var option', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --var message=world --json',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('world');
  });

  it('should allow multiple --var options', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{a}} {{b}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = await runCliInProcess(
      'run test.runbook.md --var a=first --var b=second --json',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });

  it('should inherit env var value with --var KEY (no =)', async () => {
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
        'run test.runbook.md --var MY_TEST_VAR --json',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('inherited-value');
    } finally {
      delete process.env.MY_TEST_VAR;
    }
  });

  it('should merge multiple --var-file options', async () => {
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
      'run test.runbook.md --var-file a.yaml --var-file b.yaml --json',
      workspace,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('from-a');
    expect(result.stdout).toContain('from-b');
  });

  it('should pick up RD_VAR_* environment variables', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    process.env.RD_VAR_message = 'hello-from-env';
    try {
      const result = await runCliInProcess('run test.runbook.md --json', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello-from-env');
    } finally {
      delete process.env.RD_VAR_message;
    }
  });
});
