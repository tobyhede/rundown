import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  findActionOutput,
  readSession,
  readRunbookState,
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
    expect(afterState?.runbook).toEqual(beforeState?.runbook);
  });

  it('returns non-zero when another runbook is already stashed', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('stash', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        error: 'A runbook is already stashed. Pop it first.',
        code: 'ALREADY_STASHED',
        command: 'stash',
      }),
    );
  });

  it('keeps claimed delegated children out of plain pop', async () => {
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

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('pop', workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'NO_STASHED_RUNBOOK',
      }),
    );

    let session = await readSession(workspace);
    expect(session.active).not.toBe(childRunId);
    expect(session.stashed).toBe(childRunId);

    result = await runCliInProcess(['pop', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);
    session = await readSession(workspace);
    expect(session.stashed).toBeNull();
    expect(session.active).not.toBe(childRunId);
    expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
    const ownerStatus = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    expect(JSON.parse(ownerStatus.stdout).state).toContain(childRunId);
  });

  it('refuses pop with a different claim id', async () => {
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

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);
    const otherClaimId = 'rdclm_abcdefghijklmnopQRSTUV';

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess(['pop', '--claim-id', otherClaimId], workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);

    result = await runCliInProcess(['pop', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);
    const sessionAfterOwnerPop = await readSession(workspace);
    expect(sessionAfterOwnerPop.stashed).toBeNull();
    const ownerStatus = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    expect(JSON.parse(ownerStatus.stdout).state).toContain(childRunId);
  });

  it('prevents default stash from replacing a claimed child stash', async () => {
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

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    result = await runCliInProcess('stash', workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'ALREADY_STASHED',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);
    expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
  });

  it('keeps a claimed stash when the stashed child state is missing', async () => {
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
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = String(claimOutput?.run_id);
    const claimId = String(claimOutput?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);
    await unlink(join(workspace.statePath(), `${childRunId}.json`));

    result = await runCliInProcess(['pop', '--claim-id', claimId], workspace);
    expect(result.exitCode).toBe(1);
    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);
    expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
  });

  it('refuses to pop a claimed stash when the parent is terminal', async () => {
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
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();

    result = await runCliInProcess('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const token = JSON.parse(result.stdout).token as string;
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const output = findActionOutput(result.stdout);
    expect(output?.run_id).toBeDefined();
    expect(output?.claim_id).toBeDefined();
    const childRunId = String(output?.run_id);
    const claimId = String(output?.claim_id);

    result = await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    expect(result.exitCode).toBe(0);

    const latestParent = await readRunbookState(workspace, parentState!.id);
    expect(latestParent).not.toBeNull();
    await writeFile(
      join(workspace.statePath(), `${parentState!.id}.json`),
      JSON.stringify({ ...latestParent, lifecycle: 'completed' }),
    );

    result = await runCliInProcess(['pop', '--claim-id', claimId], workspace);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'CLAIMED_RUNBOOK_UNAVAILABLE',
      }),
    );

    const session = await readSession(workspace);
    expect(session.stashed).toBe(childRunId);
    expect(session.active).not.toBe(childRunId);
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

  it('restores an anonymous stash without claim id', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;
    if (!runbookId) throw new Error('Expected active runbook before stash');
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(0);
    const afterSession = await readSession(workspace);
    expect(afterSession.stashed).toBeNull();
    expect(afterSession.active).toBe(runbookId);
  });

  it('emits INVALID_CLAIM_ID for invalid claim id', async () => {
    const result = await runCliInProcess('pop --claim-id not-a-claim', workspace);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        kind: 'error',
        code: 'INVALID_CLAIM_ID',
      }),
    );
  });

  it('anonymous caller can still restore an anonymous stash', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const beforeSession = await readSession(workspace);
    const runbookId = beforeSession.active;
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('pop --text', workspace);

    expect(result.exitCode).toBe(0);
    const afterSession = await readSession(workspace);
    expect(afterSession.active).toBe(runbookId);
    expect(afterSession.stashed).toBeNull();
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
    const runbookId = `rd_${'3'.repeat(32)}`;
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
      runbook: { source: 'project', path: 'runbooks/simple.runbook.md' },
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
      schemaVersion: 4,
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    // Set up session to have this runbook stashed (with empty defaultStack)
    await writeSession(workspace, { stashed: runbookId, defaultStack: [] });

    const result = await runCliInProcess('pop --text', workspace);

    // Text mode should NOT be silent - should show error message on stderr
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found');
  });

  it('restores a claimed stash using captured claim provenance', async () => {
    const runbookId = `rd_${'4'.repeat(32)}`;
    const parentRunId = `rd_${'5'.repeat(32)}`;
    await writeFile(
      join(workspace.statePath(), `${parentRunId}.json`),
      JSON.stringify(
        {
          id: parentRunId,
          runbook: { source: 'project', path: 'parent.runbook.md' },
          runbookPath: 'parent.runbook.md',
          title: 'Parent Runbook',
          step: '1',
          stepName: 'Parent step',
          retryCount: 0,
          variables: {},
          steps: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          runbookSrc: '# Parent\n\n## 1. Parent step\n- PASS CONTINUE\n',
          lifecycle: 'running',
          schemaVersion: 4,
        },
        null,
        2,
      ),
    );
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
          runbook: { source: 'project', path: 'owned.runbook.md' },
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
          parentLinkage: {
            kind: 'delegation',
            parentRunId,
            parentStepId: '1',
            parentStep: '1',
            tokenHash: `sha256:${'a'.repeat(64)}`,
          },
          lifecycle: 'running',
          schemaVersion: 4,
        },
        null,
        2,
      ),
    );

    await writeSession(workspace, {
      stashed: runbookId,
      defaultStack: [],
      claims: {
        rdclm_abcdefghijklmnopQRSTUV: {
          kind: 'claim-record',
          claimId: 'rdclm_abcdefghijklmnopQRSTUV',
          childRunId: runbookId,
          tokenHash: `sha256:${'a'.repeat(64)}`,
          parentRunId,
          parentStepId: '1',
          parentStep: '1',
          claimedAt: '2026-04-28T00:00:00.000Z',
          updatedAt: '2026-04-28T00:00:00.000Z',
        },
      },
    });

    const result = await runCliInProcess('pop --claim-id rdclm_abcdefghijklmnopQRSTUV', workspace);

    expect(result.exitCode).toBe(0);
    const session = await readSession(workspace);
    expect(session.active).not.toBe(runbookId);
    expect(session.stashed).toBeNull();
    const ownerStatus = await runCliInProcess(
      'status --claim-id rdclm_abcdefghijklmnopQRSTUV',
      workspace,
    );
    expect(JSON.parse(ownerStatus.stdout).state).toContain(runbookId);
  });
});
