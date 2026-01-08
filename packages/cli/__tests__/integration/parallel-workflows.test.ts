import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('Parallel Workflows Integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('parallel agents do not interfere with each other', async () => {
    // Create workflows
    const parentWorkflow = `## 1. Dispatch agents
Dispatch work.
- PASS: CONTINUE

## 2. Verify
Check results.
- PASS: COMPLETE
`;
    const childWorkflow = `## 1. Do work
Complete task.
- PASS: COMPLETE
`;

    const workflowsDir = join(workspace.cwd, 'runbooks');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'parent.md'), parentWorkflow);
    await writeFile(join(workflowsDir, 'child.md'), childWorkflow);

    // 1. Start parent workflow (default stack, prompted to keep active)
    let result = runCli('run --prompted runbooks/parent.md', workspace);
    expect(result.exitCode).toBe(0);

    // 2. Start 3 child workflows in parallel agent stacks (prompted to keep active)
    result = runCli('run --prompted runbooks/child.md --agent agent-001', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('run --prompted runbooks/child.md --agent agent-002', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('run --prompted runbooks/child.md --agent agent-003', workspace);
    expect(result.exitCode).toBe(0);

    // 3. Verify each agent sees their own workflow
    result = runCli('status --agent agent-001', workspace);
    expect(result.stdout).toContain('child.md');

    result = runCli('status --agent agent-002', workspace);
    expect(result.stdout).toContain('child.md');

    result = runCli('status --agent agent-003', workspace);
    expect(result.stdout).toContain('child.md');

    // 4. Parent workflow should still be accessible
    result = runCli('status', workspace);
    expect(result.stdout).toContain('parent.md');

    // 5. Complete agent-001's workflow
    result = runCli('pass --agent agent-001', workspace);
    expect(result.stdout).toContain('complete');

    // 6. Verify agent-001 stack is empty, others still active
    result = runCli('status --agent agent-001', workspace);
    expect(result.stdout).toContain('No active workflow');

    result = runCli('status --agent agent-002', workspace);
    expect(result.stdout).toContain('child.md');

    // 7. Parent still active
    result = runCli('status', workspace);
    expect(result.stdout).toContain('parent.md');
  });

  it('supports arbitrary nesting depth', async () => {
    // Create nested workflows
    const level1 = `## 1. Start level 2
- PASS: COMPLETE
`;
    const level2 = `## 1. Start level 3
- PASS: COMPLETE
`;
    const level3 = `## 1. Do work
- PASS: COMPLETE
`;

    const workflowsDir = join(workspace.cwd, 'runbooks');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, 'level1.md'), level1);
    await writeFile(join(workflowsDir, 'level2.md'), level2);
    await writeFile(join(workflowsDir, 'level3.md'), level3);

    // Start nested workflows (prompted to keep active at each level)
    runCli('run --prompted runbooks/level1.md', workspace);
    runCli('run --prompted runbooks/level2.md', workspace);
    runCli('run --prompted runbooks/level3.md', workspace);

    // Verify deepest is active
    let result = runCli('status', workspace);
    expect(result.stdout).toContain('level3.md');

    // Complete level3 - should pop to level2
    runCli('pass', workspace);
    result = runCli('status', workspace);
    expect(result.stdout).toContain('level2.md');

    // Complete level2 - should pop to level1
    runCli('pass', workspace);
    result = runCli('status', workspace);
    expect(result.stdout).toContain('level1.md');

    // Complete level1 - should be empty
    runCli('pass', workspace);
    result = runCli('status', workspace);
    expect(result.stdout).toContain('No active workflow');
  });

  it('session stacks persist correctly', async () => {
    const workflow = `## 1. Step
- PASS: COMPLETE
`;
    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'test.md'), workflow);

    // Start workflows in different stacks (prompted to keep active)
    runCli('run --prompted runbooks/test.md', workspace);
    runCli('run --prompted runbooks/test.md --agent agent-001', workspace);
    runCli('run --prompted runbooks/test.md --agent agent-002', workspace);

    // Read raw session
    const session = await readSession(workspace);

    expect(session.defaultStack).toHaveLength(1);
    expect(session.stacks['agent-001']).toHaveLength(1);
    expect(session.stacks['agent-002']).toHaveLength(1);

    // All stacks should have different workflow IDs
    const allIds = [
      session.defaultStack[0],
      session.stacks['agent-001'][0],
      session.stacks['agent-002'][0],
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(3);
  });
});
