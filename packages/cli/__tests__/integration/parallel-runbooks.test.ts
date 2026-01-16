import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

describe('Parallel Runbooks Integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('parallel agents do not interfere with each other', async () => {
    // Create runbooks
    const parentRunbook = `## 1. Dispatch agents
- PASS: CONTINUE

Dispatch work.

## 2. Verify
- PASS: COMPLETE

Check results.
`;
    const childRunbook = `## 1. Do work
- PASS: COMPLETE

Complete task.
`;

    const runbooksDir = join(workspace.cwd, 'runbooks');
    await mkdir(runbooksDir, { recursive: true });
    await writeFile(join(runbooksDir, 'parent.md'), parentRunbook);
    await writeFile(join(runbooksDir, 'child.md'), childRunbook);

    // 1. Start parent runbook (default stack, prompted to keep active)
    let result = runCli('run --prompted runbooks/parent.md', workspace);
    expect(result.exitCode).toBe(0);

    // 2. Start 3 child runbooks in parallel agent stacks (prompted to keep active)
    result = runCli('run --prompted runbooks/child.md --agent agent-001', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('run --prompted runbooks/child.md --agent agent-002', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('run --prompted runbooks/child.md --agent agent-003', workspace);
    expect(result.exitCode).toBe(0);

    // 3. Verify each agent sees their own runbook
    result = runCli('status --agent agent-001', workspace);
    expect(result.stdout).toContain('child.md');

    result = runCli('status --agent agent-002', workspace);
    expect(result.stdout).toContain('child.md');

    result = runCli('status --agent agent-003', workspace);
    expect(result.stdout).toContain('child.md');

    // 4. Parent runbook should still be accessible
    result = runCli('status', workspace);
    expect(result.stdout).toContain('parent.md');

    // 5. Complete agent-001's runbook
    result = runCli('pass --agent agent-001', workspace);
    expect(result.stdout).toContain('COMPLETE');

    // 6. Verify agent-001 stack is empty, others still active
    result = runCli('status --agent agent-001', workspace);
    expect(result.stdout).toContain('No active runbook');

    result = runCli('status --agent agent-002', workspace);
    expect(result.stdout).toContain('child.md');

    // 7. Parent still active
    result = runCli('status', workspace);
    expect(result.stdout).toContain('parent.md');
  });

  it('supports arbitrary nesting depth', async () => {
    // Create nested runbooks
    const level1 = `## 1. Start level 2
- PASS: COMPLETE
`;
    const level2 = `## 1. Start level 3
- PASS: COMPLETE
`;
    const level3 = `## 1. Do work
- PASS: COMPLETE
`;

    const runbooksDir = join(workspace.cwd, 'runbooks');
    await mkdir(runbooksDir, { recursive: true });
    await writeFile(join(runbooksDir, 'level1.md'), level1);
    await writeFile(join(runbooksDir, 'level2.md'), level2);
    await writeFile(join(runbooksDir, 'level3.md'), level3);

    // Start nested runbooks (prompted to keep active at each level)
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
    expect(result.stdout).toContain('No active runbook');
  });

  it('session stacks persist correctly', async () => {
    const runbook = `## 1. Step
- PASS: COMPLETE
`;
    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'test.md'), runbook);

    // Start runbooks in different stacks (prompted to keep active)
    runCli('run --prompted runbooks/test.md', workspace);
    runCli('run --prompted runbooks/test.md --agent agent-001', workspace);
    runCli('run --prompted runbooks/test.md --agent agent-002', workspace);

    // Read raw session
    const session = await readSession(workspace);

    expect(session.defaultStack).toHaveLength(1);
    expect(session.stacks['agent-001']).toHaveLength(1);
    expect(session.stacks['agent-002']).toHaveLength(1);

    // All stacks should have different runbook IDs
    const allIds = [
      session.defaultStack[0],
      session.stacks['agent-001'][0],
      session.stacks['agent-002'][0],
    ];
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(3);
  });
});
