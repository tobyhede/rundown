import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  readSession,
  getActiveState,
  writeSession,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('stash command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('moves active runbook to stashed', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    runCli('stash', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.stashed).toBe(runbookId);
  });

  it('clears active runbook', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    runCli('stash', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('outputs stash confirmation', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);

    const result = runCli('stash', workspace);

    expect(result.stdout).toContain('STASHED');
    expect(result.stdout).toContain('Runbook:');
  });

  it('fails if no active runbook', async () => {
    const result = runCli('stash', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('preserves runbook state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('pass', workspace); // Advance to step 2
    const beforeState = await getActiveState(workspace);

    runCli('stash', workspace);
    runCli('pop', workspace);

    const afterState = await getActiveState(workspace);
    expect(afterState?.step).toBe(beforeState?.step);
    expect(afterState?.runbook).toBe(beforeState?.runbook);
  });
});

describe('pop command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('restores stashed runbook to active', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    runCli('stash', workspace);
    runCli('pop', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBe(runbookId);
  });

  it('clears stashed state', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('stash', workspace);

    runCli('pop', workspace);

    const session = await readSession(workspace);
    expect(session.stashed).toBeNull();
  });

  it('outputs restored runbook info', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('stash', workspace);

    const result = runCli('pop', workspace);

    expect(result.stdout).toContain('First step');
    expect(result.stdout).toContain('## 1');
  });

  it('fails if nothing stashed', async () => {
    const result = runCli('pop', workspace);

    expect(result.stdout).toContain('No stashed runbook');
  });

  it('shows resuming step info', async () => {
    runCli('run --prompted runbooks/simple.runbook.md', workspace);
    runCli('pass', workspace); // Advance to step 2
    runCli('stash', workspace);

    const result = runCli('pop', workspace);

    expect(result.stdout).toContain('Second step');
  });

  it('outputs error when step not found in runbook', async () => {
    // Create a state file with a step that doesn't exist in the runbook
    // runbookSrc must be present for pop to read from stored content
    const runbookId = 'wf-2025-01-28-test01';
    const stateFile = join(workspace.statePath(), `${runbookId}.json`);
    const runbookSrc = `# Test Runbook

## 1. First step
- PASS COMPLETE

\`\`\`bash
rd echo "hello"
\`\`\`
`;
    const state = {
      id: runbookId,
      runbook: 'runbooks/simple.runbook.md',
      runbookPath: join(workspace.cwd, 'runbooks', 'simple.runbook.md'),
      title: 'Test Runbook',
      step: 'NonExistentStep', // Step that doesn't exist in runbookSrc
      stepName: 'A step that does not exist',
      retryCount: 0,
      variables: {},
      steps: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runbookSrc, // Include runbookSrc so pop can read steps
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    // Set up session to have this runbook stashed (with empty defaultStack)
    await writeSession(workspace, { stashed: runbookId, defaultStack: [] });

    const result = runCli('pop', workspace);

    // Text mode should NOT be silent - should show error message
    expect(result.stdout.trim()).not.toBe('');
    expect(result.stdout).toContain('not found');
  });
});
