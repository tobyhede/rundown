import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    await runCliInProcess('stash --text', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.stashed).toBe(runbookId);
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    await runCliInProcess('stash --text', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('outputs stash confirmation', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('stash --text', workspace);

    expect(result.stdout).toContain('STASHED');
    expect(result.stdout).toContain('Runbook:');
  });

  it('fails if no active runbook', async () => {
    const result = await runCliInProcess('stash --text', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('preserves runbook state', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Advance to step 2
    const beforeState = await getActiveState(workspace);

    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('pop --text', workspace);

    const afterState = await getActiveState(workspace);
    expect(afterState?.step).toBe(beforeState?.step);
    expect(afterState?.runbook).toBe(beforeState?.runbook);
  });

  it('returns non-zero when another runbook is already stashed', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('stash', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      kind: 'error',
      error: 'A runbook is already stashed. Pop it first.',
      code: 'ALREADY_STASHED',
    });
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
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;

    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('pop --text', workspace);

    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBe(runbookId);
  });

  it('clears stashed state', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    await runCliInProcess('pop --text', workspace);

    const session = await readSession(workspace);
    expect(session.stashed).toBeNull();
  });

  it('outputs restored runbook info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.stdout).toContain('First step');
    expect(result.stdout).toContain('## 1');
  });

  it('fails if nothing stashed', async () => {
    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No stashed runbook');
  });

  it('shows resuming step info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Advance to step 2
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

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
      lifecycle: 'running',
      schemaVersion: 2,
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    // Set up session to have this runbook stashed (with empty defaultStack)
    await writeSession(workspace, { stashed: runbookId, defaultStack: [] });

    const result = await runCliInProcess('pop --text', workspace);

    // Text mode should NOT be silent - should show error message on stderr
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });
});
