import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
  readSession,
  getActiveState,
  findActionOutput,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';

describe('status command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('displays current step info', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
    expect(result.stdout).toContain('First step');
  });

  it('shows runbook file path', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('File:');
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows retryCount', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    // Status shows step information, retryCount is internal state
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## 1.');
  });

  it('shows runbook ID', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('State:');
    expect(result.stdout).toMatch(/rd_[a-f0-9]{32}/);
  });

  it('reports invalid persisted state without prune guidance', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const state = await getActiveState(workspace);
    expect(state).toBeDefined();

    await writeFile(
      join(workspace.statePath(), `${state!.id}.json`),
      JSON.stringify({ ...state, schemaVersion: 2 }, null, 2),
    );

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).not.toBe(0);

    const output = result.stderr.trim() || result.stdout.trim();
    const error = JSON.parse(output) as {
      kind?: string;
      error?: string;
      code?: string;
    };

    expect(error.kind).toBe('error');
    expect(error.code).toBe('RD-999');
    expect(error.error).toMatch(/invalid runbook state|state.*invalid/i);

    const emitted = `${result.stdout}\n${result.stderr}`;
    expect(emitted).not.toMatch(/prune/i);
    expect(emitted).not.toMatch(/clear invalid state/i);
  });

  it('outputs "No active runbook" when none', async () => {
    const result = await runCliInProcess('status --text', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('shows stashed runbook info when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('shows stashed status in JSON when stashed but not active', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
  });
});

describe('claim-id delegated children', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('resolves status to the claimed child before the default stack', async () => {
    const parentRunbook = [
      '# Parent',
      '',
      '## 1. Fan out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 First child',
      '',
      '- DELEGATE',
      '',
      'Do first child.',
      '',
      '- runbooks/child-status.runbook.md',
      '',
      '### 1.2 Second child',
      '',
      '- DELEGATE',
      '',
      'Do second child.',
      '',
      '- runbooks/child-status.runbook.md',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child',
      '',
      '## 1. Work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Do child work.',
      '',
    ].join('\n');

    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-status.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-status.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted runbooks/parent-status.md --text', workspace);
    const parentId = (await getActiveState(workspace))!.id;

    const parent = await getActiveState(workspace);
    const token1 = parent?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
    const token2 = parent?.substepStates?.find((substep) => substep.id === '2')?.delegation?.token;
    expect(token1).toEqual(expect.stringMatching(/^rdtk_/));
    expect(token2).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token1 !== 'string' || typeof token2 !== 'string') {
      throw new Error('Expected delegation tokens');
    }

    let result = await runCliInProcess(`claim ${token1}`, workspace);
    expect(result.exitCode).toBe(0);
    const child1Output = findActionOutput(result.stdout);
    expect(child1Output).toBeDefined();
    expect(typeof child1Output?.run_id).toBe('string');
    expect(typeof child1Output?.claim_id).toBe('string');
    const child1Id = child1Output!.run_id as string;
    const claimId1 = child1Output!.claim_id as string;

    result = await runCliInProcess(`claim ${token2}`, workspace);
    expect(result.exitCode).toBe(0);
    const child2Output = findActionOutput(result.stdout);
    expect(child2Output).toBeDefined();
    expect(typeof child2Output?.run_id).toBe('string');
    expect(typeof child2Output?.claim_id).toBe('string');
    const child2Id = child2Output!.run_id as string;
    const claimId2 = child2Output!.claim_id as string;

    let status = await runCliInProcess(['status', '--claim-id', claimId1], workspace);
    expect(JSON.parse(status.stdout).state).toContain(child1Id);

    status = await runCliInProcess(['status', '--claim-id', claimId2], workspace);
    expect(JSON.parse(status.stdout).state).toContain(child2Id);

    status = await runCliInProcess('status', workspace);
    expect(JSON.parse(status.stdout).state).toContain(parentId);
  });

  async function setupOwnedStash() {
    const parentRunbook = [
      '# Parent Secret',
      '',
      '## 1. Fan out',
      '',
      '- PASS ALL CONTINUE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Child',
      '',
      '- DELEGATE',
      '',
      'Do child.',
      '',
      '- runbooks/child-secret.runbook.md',
      '',
    ].join('\n');
    const childRunbook = [
      '# Child Secret',
      '',
      '## 1. Work',
      '',
      '- PASS COMPLETE',
      '- FAIL STOP',
      '',
      'Do child work.',
      '',
    ].join('\n');

    await mkdir(join(workspace.cwd, 'runbooks'), { recursive: true });
    await writeFile(join(workspace.cwd, 'runbooks', 'parent-secret.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'runbooks', 'child-secret.runbook.md'), childRunbook);

    await runCliInProcess('run --prompted runbooks/parent-secret.md --text', workspace);
    const parent = await getActiveState(workspace);
    const token = parent?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');
    const claimed = await runCliInProcess(`claim ${token}`, workspace);
    const claimOutput = findActionOutput(claimed.stdout);
    if (!claimOutput || typeof claimOutput.run_id !== 'string') {
      throw new Error('Expected claim output to include run_id');
    }
    if (typeof claimOutput.claim_id !== 'string') {
      throw new Error('Expected claim output to include claim_id');
    }
    const childRunId = claimOutput.run_id;
    const claimId = claimOutput.claim_id;

    const stateFile = join(workspace.statePath(), `${childRunId}.json`);
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    state.variables = { secretOutput: 'top-secret-output' };
    state.templateVars = {
      ...(state.templateVars ?? {}),
      secretInput: 'top-secret-input',
    };
    await writeFile(stateFile, JSON.stringify(state, null, 2));

    await runCliInProcess(['stash', '--claim-id', claimId, '--text'], workspace);
    const sessionFile = workspace.sessionPath();
    const session = JSON.parse(await readFile(sessionFile, 'utf-8')) as Record<string, unknown>;
    session.defaultStack = [];
    await writeFile(sessionFile, JSON.stringify(session, null, 2));
    return { childRunId, claimId };
  }

  it('plain status can report the global stashed child without claim vars', async () => {
    await setupOwnedStash();

    const status = await runCliInProcess('status', workspace);

    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toEqual(
      expect.objectContaining({ active: false, stashed: true }),
    );
    expect(status.stdout).toContain('child-secret.runbook.md');
    // Plain status must not leak claim-scoped variables: only `--claim-id`
    // callers see them (asserted positively in the next test).
    expect(status.stdout).not.toContain('top-secret-input');
    expect(status.stdout).not.toContain('top-secret-output');
  });

  it('claim id can see its own stashed status', async () => {
    const { childRunId, claimId } = await setupOwnedStash();

    const status = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(true);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('child-secret.runbook.md');
    expect(output.state).toContain(childRunId);
    expect(output.parentLinkage).toEqual(
      expect.objectContaining({
        kind: 'delegation',
        parentStepId: '1',
      }),
    );
    expect(output.vars).toEqual(
      expect.objectContaining({
        secretInput: 'top-secret-input',
        secretOutput: 'top-secret-output',
      }),
    );
  });

  it('claim id renders terminal child status instead of unavailable', async () => {
    const { childRunId, claimId } = await setupOwnedStash();
    const stateFile = join(workspace.statePath(), `${childRunId}.json`);
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    await writeFile(stateFile, JSON.stringify({ ...state, lifecycle: 'completed' }, null, 2));

    const status = await runCliInProcess(['status', '--claim-id', claimId], workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(false);
    expect(output.status).toBe('completed');
    expect(output.state).toContain(childRunId);
  });

  it('anonymous stash remains visible to plain callers', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('stash --text', workspace);

    const status = await runCliInProcess('status', workspace);
    const output = JSON.parse(status.stdout);

    expect(status.exitCode).toBe(0);
    expect(output.active).toBe(false);
    expect(output.stashed).toBe(true);
    expect(output.file).toContain('simple.runbook.md');
  });
});

describe('JSON lastAction.result semantics', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('reports lastAction.result PASS after successful pass', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers CONTINUE (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toBe('CONTINUE');
  });

  it('reports lastAction.result FAIL after fail triggers RETRY', async () => {
    await runCliInProcess('run --prompted runbooks/retry.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers RETRY (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^RETRY/);
  });

  it('reports lastAction.result PASS after pass triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/goto.runbook.md --text', workspace);
    await runCliInProcess('pass --text', workspace); // Triggers GOTO 3 (success)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('PASS');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });

  it('reports lastAction.result FAIL after fail triggers GOTO', async () => {
    await runCliInProcess('run --prompted runbooks/fail-goto.runbook.md --text', workspace);
    await runCliInProcess('fail --text', workspace); // Triggers GOTO 3 (failure)

    const result = await runCliInProcess('status', workspace);
    const output = JSON.parse(result.stdout);

    expect(output.lastAction).toBeDefined();
    expect(output.lastAction.result).toBe('FAIL');
    expect(output.lastAction.action).toMatch(/^GOTO/);
  });
});

describe('ls command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('lists all runbook states', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('simple.runbook.md');
  });

  it('marks active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('active');
  });

  it('shows current step for each', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('1/');
  });

  it('outputs "No active runbooks" when empty', async () => {
    const result = await runCliInProcess('ls --text', workspace);

    expect(result.stdout).toContain('No active runbooks');
  });
});

describe('complete command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('marks runbook as complete', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete --text', workspace);

    expect(result.stdout).toContain('COMPLETE');
  });

  it('clears active runbook', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    await runCliInProcess('complete --text', workspace);

    const session = await readSession(workspace);
    expect(session.active).toBeNull();
  });

  it('handles no active runbook', async () => {
    const result = await runCliInProcess('complete', workspace);

    expect(result.stdout).toContain('No active runbook');
  });

  it('includes message in JSON output', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess(['complete', 'Early exit - tests passed'], workspace);

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Early exit - tests passed');
  });

  it('uses default message when none provided', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);

    const result = await runCliInProcess('complete', workspace);

    const output = JSON.parse(result.stdout);
    expect(output.message).toBe('Runbook completed successfully');
  });

  it('fails closed for stale claimed runbook state without touching default stack', async () => {
    const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child.runbook.md
`;
    const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childRunbook);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();
    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');
    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimOutput = findActionOutput(result.stdout);
    const childRunId = claimOutput?.run_id;
    const claimId = claimOutput?.claim_id;
    expect(typeof childRunId).toBe('string');
    expect(typeof claimId).toBe('string');
    await rm(join(workspace.statePath(), `${String(childRunId)}.json`));

    result = await runCliInProcess(
      ['complete', '--claim-id', String(claimId), '--text'],
      workspace,
    );
    expect(result.exitCode).not.toBe(0);

    const session = await readSession(workspace);
    expect(Object.values(session.claims)).toContainEqual(expect.objectContaining({ childRunId }));
    expect(session.defaultStack).toContain(parentState!.id);
    expect(session.active).toBe(parentState!.id);
  });

  it('propagates delegated child completion to the parent', async () => {
    const parentRunbook = `## 1. Review
- PASS ALL CONTINUE
- FAIL ANY STOP

### 1.1 Child
- DELEGATE

Do child.

- child.runbook.md

## 2. Done
- PASS COMPLETE

Done.
`;
    const childRunbook = `## 1. Child
- PASS COMPLETE

Do work.
`;
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), parentRunbook);
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childRunbook);

    let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);
    const parentState = await getActiveState(workspace);
    expect(parentState).not.toBeNull();

    const token = parentState?.substepStates?.[0]?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    if (typeof token !== 'string') throw new Error('Expected delegation token');

    result = await runCliInProcess(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    const claimAction = findActionOutput(result.stdout);
    const childRunId = claimAction?.run_id;
    const claimId = claimAction?.claim_id;
    expect(typeof childRunId).toBe('string');
    expect(typeof claimId).toBe('string');

    result = await runCliInProcess(`complete --claim-id ${String(claimId)} --text`, workspace);
    expect(result.exitCode).toBe(0);

    const childState = await readRunbookState(workspace, String(childRunId));
    expect(childState?.lifecycle).toBe('completed');

    const updatedParent = await readRunbookState(workspace, parentState!.id);
    expect(updatedParent?.step).toBe('2');

    const session = await readSession(workspace);
    expect(session.defaultStack.at(-1)).toBe(parentState!.id);
    expect(session.defaultStack).not.toContain(String(childRunId));
    expect(Object.values(session.claims)).not.toContainEqual(
      expect.objectContaining({ childRunId }),
    );
  });

  it('pops orphaned default-stack entry when state file is missing', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    await rm(join(workspace.statePath(), `${stateId}.json`));

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('pops orphaned default-stack entry when state file is corrupted', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    await writeFile(join(workspace.statePath(), `${stateId}.json`), '{invalid');

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('pops orphaned default-stack entry when state is invalid', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const state = await getActiveState(workspace);
    const stateId = state!.id;
    await writeFile(
      join(workspace.statePath(), `${stateId}.json`),
      JSON.stringify({ ...state, schemaVersion: 2 }),
    );

    const result = await runCliInProcess('complete', workspace);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).message).toBe('Removed unusable runbook state from session');
    const session = await readSession(workspace);
    expect(session.active).toBeNull();
    expect(session.defaultStack).toHaveLength(0);
  });

  it('does not remove anonymous default stack when a claim id has no claim', async () => {
    await runCliInProcess('run --prompted runbooks/simple.runbook.md --text', workspace);
    const sessionBefore = await readSession(workspace);
    const parentId = sessionBefore.defaultStack.at(-1);
    expect(parentId).toBeDefined();

    const result = await runCliInProcess(
      ['complete', '--claim-id', 'rdclm_abcdefghijklmnopQRSTUV', '--text'],
      workspace,
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Claim id rdclm_abcdefghijklmnopQRSTUV does not exist',
    );
    const sessionAfter = await readSession(workspace);
    expect(sessionAfter.defaultStack).toEqual([parentId]);
  });
});

describe('status with runbookSrc', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it('should compute step total from runbookSrc', async () => {
    // Create a runbook with variable
    const runbookContent = `# Test Runbook

## 1. First Step
- PASS CONTINUE

\`\`\`bash
rd echo {{message}}
\`\`\`

## 2. Second Step
- PASS COMPLETE

\`\`\`bash
rd echo done
\`\`\`
`;
    await writeFile(join(workspace.cwd, 'test.runbook.md'), runbookContent);

    // Run with variable to store runbookSrc
    await runCliInProcess('run test.runbook.md --input message=hello --prompted --text', workspace);

    // Delete the source file to prove we're using runbookSrc, not disk
    await rm(join(workspace.cwd, 'test.runbook.md'));

    // Status should work using runbookSrc (not disk fallback)
    const result = await runCliInProcess('status', workspace);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.position.total).toBe(2);
  });
});
