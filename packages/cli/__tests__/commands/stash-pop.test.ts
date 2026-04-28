import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  findActionOutput,
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

  it('keeps agent-owned delegated children out of anonymous pop', async () => {
    const parent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [{ title: 'Code review', content: 'Do code review.' }],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run child.' }],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const token = JSON.parse(result.stdout).token as string;

    const agent = { env: { RD_AGENT_ID: 'stash-agent', RD_SESSION_ID: 'stash-session' } };
    result = await runCliInProcess(`claim ${token}`, workspace, agent);
    expect(result.exitCode).toBe(0);
    const childRunId = String(findActionOutput(result.stdout)?.run_id);

    result = await runCliInProcess('stash --text', workspace, agent);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('pop', workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'OWNED_RUNBOOK_UNAVAILABLE',
      }),
    );

    let session = await readSession(workspace);
    expect(session.active).not.toBe(childRunId);
    expect(session.stashed).toBe(childRunId);

    result = await runCliInProcess('pop --text', workspace, agent);
    expect(result.exitCode).toBe(0);
    session = await readSession(workspace);
    expect(session.active).not.toBe(childRunId);
    expect(Object.values(session.ownedRunbooks)).toContainEqual(
      expect.objectContaining({
        agent_id: 'stash-agent',
        session_id: 'stash-session',
        childRunId,
      }),
    );
  });

  it('refuses cross-agent pop when stash is owned by a different agent', async () => {
    // Regression: a stash owned by agent-A must not be restorable by agent-B —
    // the CLI pre-check in pop.ts rejects with OWNED_RUNBOOK_UNAVAILABLE.
    const parent = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [{ title: 'Code review', content: 'Do code review.' }],
        },
      ],
    });
    const child = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', fail: 'STOP', content: 'Run child.' }],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parent);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), child);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const token = JSON.parse(result.stdout).token as string;

    const agentA = { env: { RD_AGENT_ID: 'agent-a', RD_SESSION_ID: 'shared-session' } };
    const agentB = { env: { RD_AGENT_ID: 'agent-b', RD_SESSION_ID: 'shared-session' } };

    result = await runCliInProcess(`claim ${token}`, workspace, agentA);
    expect(result.exitCode).toBe(0);
    const childRunId = String(findActionOutput(result.stdout)?.run_id);

    result = await runCliInProcess('stash --text', workspace, agentA);
    expect(result.exitCode).toBe(0);

    // Agent-B attempts pop — must be refused; stash must remain intact.
    result = await runCliInProcess('pop', workspace, agentB);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'OWNED_RUNBOOK_UNAVAILABLE',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);

    // Rightful owner can still recover.
    result = await runCliInProcess('pop --text', workspace, agentA);
    expect(result.exitCode).toBe(0);
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

  it('fails closed when owned stash provenance exists without delegation linkage', async () => {
    const runbookId = 'wf-2025-01-28-owned01';
    const stateFile = join(workspace.statePath(), `${runbookId}.json`);
    const runbookSrc = [
      '# Test Runbook',
      '',
      '## 1. First step',
      '- PASS COMPLETE',
      '',
      'Do work.',
      '',
    ].join('\n');
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          id: runbookId,
          runbook: 'owned.runbook.md',
          runbookPath: 'owned.runbook.md',
          title: 'Test Runbook',
          step: '1',
          stepName: 'First step',
          retryCount: 0,
          variables: {},
          steps: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          runbookSrc,
          lifecycle: 'running',
          schemaVersion: 2,
        },
        null,
        2,
      ),
    );

    await writeSession(workspace, {
      stashed: runbookId,
      defaultStack: [],
      stashedRunbookOwnership: {
        kind: 'agent-owned-runbook',
        ownerKey: 'agent:stash-agent:session:stash-session',
        agent_id: 'stash-agent',
        session_id: 'stash-session',
        childRunId: runbookId,
        tokenHash: `sha256:${'a'.repeat(64)}`,
        parentRunId: 'missing-parent',
        parentStepId: '1',
        claimedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      },
    });

    const result = await runCliInProcess('pop', workspace, {
      env: { RD_AGENT_ID: 'stash-agent', RD_SESSION_ID: 'stash-session' },
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'OWNED_RUNBOOK_UNAVAILABLE',
      }),
    );
    const session = await readSession(workspace);
    expect(session.active).not.toBe(runbookId);
    expect(session.stashed).toBe(runbookId);
  });
});
