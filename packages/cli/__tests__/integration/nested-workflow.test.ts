import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('Nested Workflow Integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should complete full parent-child workflow cycle', async () => {
    // 1. Create parent and child workflows
    const parentWorkflow = `## 1. Dispatch agent

Parent step that dispatches work.

- PASS: COMPLETE
`;

    const childWorkflow = `## 1. Do work

Complete the work.

- PASS: COMPLETE
`;

    // Write workflows to workspace
    const workflowsDir = join(workspace.cwd, 'runbooks');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'parent.runbook.md'), parentWorkflow);
    await writeFile(join(workflowsDir, 'child.runbook.md'), childWorkflow);

    // 2. Start parent workflow (prompted to keep it active)
    let result = runCli('run --prompted runbooks/parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Action:   START');

    // 3. Queue step for agent binding
    result = runCli(['run', '--step', '1'], workspace);
    expect(result.stdout).toContain('Step 1 queued');

    // 4. Bind agent (no child workflow in this simple case)
    result = runCli(['run', '--agent', 'test-agent'], workspace);
    expect(result.stdout).toContain('bound');

    // 5. Complete agent's work (updates binding on parent)
    result = runCli(['pass', '--agent', 'test-agent'], workspace);
    expect(result.stdout).toContain('marked as pass');

    // 6. Verify parent sees completion
    result = runCli('status', workspace);
    expect(result.stdout).toContain('test-agent: 1 [done] (pass)');
  });
});