import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { createTestWorkspace, runCli, type TestWorkspace } from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('FOR + agent debug', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('traces FOR + agent dispatch flow', async () => {
    const runbooksDir = join(workspace.cwd, 'runbooks');
    await mkdir(runbooksDir, { recursive: true });

    await writeFile(
      join(runbooksDir, 'parent.runbook.md'),
      `## 1. Process items
- FOR i IN 1 TO 2
  - PASS ALL: CONTINUE
  - FAIL ANY: BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Work item

- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final step.
`,
    );

    await writeFile(
      join(runbooksDir, 'child.runbook.md'),
      `## 1. Do work
- PASS: COMPLETE

Complete the work.
`,
    );

    // Start parent
    let result = runCli('run --prompted runbooks/parent.runbook.md', workspace);
    console.log('=== START ===');
    console.log('stdout:', result.stdout);
    console.log('stderr:', result.stderr);
    console.log('exit:', result.exitCode);

    // Status
    result = runCli('status', workspace);
    console.log('=== STATUS after start ===');
    console.log('stdout:', result.stdout);

    // Try queue step
    result = runCli('run --step 1', workspace);
    console.log('=== RUN --step 1 (iter 1) ===');
    console.log('stdout:', result.stdout);
    console.log('stderr:', result.stderr);
    console.log('exit:', result.exitCode);

    // Bind agent
    result = runCli('run --agent agent-1', workspace);
    console.log('=== RUN --agent agent-1 ===');
    console.log('stdout:', result.stdout);
    console.log('stderr:', result.stderr);
    console.log('exit:', result.exitCode);

    // Status
    result = runCli('status', workspace);
    console.log('=== STATUS after agent-1 bound ===');
    console.log('stdout:', result.stdout);

    // Pass agent
    result = runCli('pass --agent agent-1', workspace);
    console.log('=== PASS --agent agent-1 ===');
    console.log('stdout:', result.stdout);
    console.log('stderr:', result.stderr);
    console.log('exit:', result.exitCode);

    // Status
    result = runCli('status', workspace);
    console.log('=== STATUS after agent-1 pass ===');
    console.log('stdout:', result.stdout);

    expect(true).toBe(true);
  });

  it('traces FOR + plain pass flow', async () => {
    const runbooksDir = join(workspace.cwd, 'runbooks');
    await mkdir(runbooksDir, { recursive: true });

    await writeFile(
      join(runbooksDir, 'parent.runbook.md'),
      `## 1. Process items
- FOR i IN 1 TO 2
  - PASS ALL: CONTINUE
  - FAIL ANY: BREAK
- PASS ALL: CONTINUE
- FAIL ANY: STOP

### 1.1 Work item

- child.runbook.md

## 2. Done
- PASS: COMPLETE

Final step.
`,
    );

    await writeFile(
      join(runbooksDir, 'child.runbook.md'),
      `## 1. Do work
- PASS: COMPLETE

Complete the work.
`,
    );

    // Start parent
    let result = runCli('run --prompted runbooks/parent.runbook.md', workspace);
    console.log('=== START ===');
    console.log('stdout:', result.stdout);

    // Plain pass iteration 1
    result = runCli('pass', workspace);
    console.log('=== PASS iter 1 ===');
    console.log('stdout:', result.stdout);
    console.log('exit:', result.exitCode);

    // Plain pass iteration 2
    result = runCli('pass', workspace);
    console.log('=== PASS iter 2 ===');
    console.log('stdout:', result.stdout);
    console.log('exit:', result.exitCode);

    // Status
    result = runCli('status', workspace);
    console.log('=== STATUS after both iters ===');
    console.log('stdout:', result.stdout);

    // If at step 2, pass to complete
    result = runCli('pass', workspace);
    console.log('=== PASS step 2 ===');
    console.log('stdout:', result.stdout);
    console.log('exit:', result.exitCode);

    expect(true).toBe(true);
  });
});
