import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';

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
- PASS: COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    await writeFile(
      join(workspace.cwd, 'vars.yaml'),
      'message: hello'
    );

    const result = runCli('run test.runbook.md --var-file vars.yaml --json', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
  });

  it('should accept --var option', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS: COMPLETE

\`\`\`bash
rd echo {{message}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = runCli('run test.runbook.md --var message=world --json', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('world');
  });

  it('should allow multiple --var options', async () => {
    const runbookContent = `# Test Runbook

## 1. Echo Test
- PASS: COMPLETE

\`\`\`bash
rd echo {{a}} {{b}}
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    const result = runCli('run test.runbook.md --var a=first --var b=second --json', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('first');
    expect(result.stdout).toContain('second');
  });
});
