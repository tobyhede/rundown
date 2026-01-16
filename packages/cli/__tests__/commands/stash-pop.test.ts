import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  runCli,
  readSession,
  getActiveState,
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
});