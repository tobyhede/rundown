import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCli,
  getActiveState,
  readRunbookState,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Delegation claim integration', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function writeParentRunbook(childRunbook = 'child.runbook.md'): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
              runbooks: [childRunbook],
            },
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: [childRunbook],
            },
          ],
        },
        { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
      ],
    });
    await writeFile(join(workspace.cwd, 'parent.runbook.md'), content);
  }

  async function writeChildRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Child',
      steps: [{ title: 'Execute', pass: 'COMPLETE', content: 'Run the child task.' }],
    });
    await writeFile(join(workspace.cwd, 'child.runbook.md'), content);
  }

  async function getAutoIssuedToken(substepId = '1'): Promise<string> {
    const state = await getActiveState(workspace);
    const token = state?.substepStates?.find((substep) => substep.id === substepId)?.delegation
      ?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    return token!;
  }

  it('rejects invalid token format', () => {
    const result = runCli('claim bad-token --text', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/invalid.*token|rdtk_/i);
  });

  it('rejects unknown token', () => {
    // Token with correct format but no matching delegation
    // cspell:disable-next-line
    const result = runCli('claim rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH --text', workspace);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/not found|no active run/i);
  });

  it('delegate → claim end-to-end', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent in prompted mode
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // Claim the token — should launch child runbook
    result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('claims a delegated child resolved from the bundled runbooks directory', async () => {
    const parentContent = `# Parent

## 1. Parent work
- PASS ALL COMPLETE
- FAIL ANY STOP

### 1.1 Bundled child

- DELEGATE

- delegation-child-pass.runbook.md
`;
    await writeFile(join(workspace.cwd, 'parent-bundled-child.runbook.md'), parentContent);

    let result = runCli('run parent-bundled-child.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    result = runCli(`claim ${token}`, workspace);
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(
      'Resolved runbook path escapes source root',
    );

    const outputLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(outputLines[outputLines.length - 1]) as {
      kind?: string;
      action?: string;
      runbook?: string;
    };
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.runbook).toContain('delegation-child-pass.runbook.md');
  });

  it('idempotent re-claim returns same child run', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // First claim
    result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);

    // Second claim — should succeed (idempotent)
    result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('claim with outputs structured data', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    let result = runCli('run --prompted parent.runbook.md', workspace);
    expect(result.exitCode).toBe(0);

    const claimToken = await getAutoIssuedToken();
    result = runCli(`claim ${claimToken}`, workspace);

    // Command should succeed
    expect(result.exitCode).toBe(0);

    // Parse last JSON line — claim output follows child-run JSON events
    const jsonLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.token).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
    expect(typeof claimOutput.run_id).toBe('string');
    expect(typeof claimOutput.runbook).toBe('string');
    expect(typeof claimOutput.parent_run_id).toBe('string');
    expect(typeof claimOutput.parent_step).toBe('string');
  });

  it('claim with --input-file merges file variables into child context', async () => {
    await writeParentRunbook();

    // Child runbook echoes the variable to confirm it was received
    const childContent = `## 1. Execute
- PASS COMPLETE

Task uses {{ myVar }}.
`;
    await writeFile(join(workspace.cwd, 'child.runbook.md'), childContent);

    // Write a YAML var file
    await writeFile(join(workspace.cwd, 'vars.yaml'), 'myVar: fromFile\n');

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const token = await getAutoIssuedToken();

    // Claim with --input-file
    result = runCli(`claim ${token} --input-file vars.yaml`, workspace);
    expect(result.exitCode).toBe(0);

    // Verify the variable was rendered in child execution output
    expect(result.stdout).toContain('Task uses fromFile.');

    // Parse last JSON line for claimed output
    const jsonLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(claimOutput.kind).toBe('claim');
    expect(claimOutput.action).toBe('claimed');
  });

  it('claim outputs structured error for invalid token', () => {
    const result = runCli('claim bad-token', workspace);
    expect(result.exitCode).toBe(1);

    const output = JSON.parse(result.stdout);
    expect(output.error).toBeDefined();
    expect(output.code).toBeDefined();
  });

  it('rejects ${TOKEN_0} in scenario command sequence', async () => {
    // Write a runbook whose scenario uses the invalid ${TOKEN_0} placeholder
    const content = [
      '---',
      'scenarios:',
      '  bad-token:',
      '    description: TOKEN_0 is invalid (1-based indexing)',
      '    result: STOP',
      '    commands:',
      '      - rd run --prompted bad-token.runbook.md',
      '      - rd claim ${TOKEN_0}',
      '---',
      '',
      '## 1. Parent',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Delegated step',
      '- DELEGATE',
      '',
      'Do work.',
      '',
      '- child.runbook.md',
      '',
      '## 2. Done',
      '- PASS COMPLETE',
      '',
      'Finished.',
    ].join('\n');
    await writeFile(join(workspace.runbooksDir(), 'bad-token.runbook.md'), content);

    // Child runbook for the delegation
    const childContent = '## 1. Execute\n- PASS COMPLETE\n\nRun task.\n';
    await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

    const result = runCli('scenario run bad-token.runbook.md bad-token -q --text', workspace);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/TOKEN_0|references uncaptured token/);
  });

  describe('auto-propagation on claim', () => {
    /** Helper: write a child runbook that auto-completes (no prompting needed). */
    async function writeAutoCompleteChildRunbook(): Promise<void> {
      const content = `## 1. Execute
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'auto-child.runbook.md'), content);
    }

    it('auto-propagates when child completes during claim', async () => {
      await writeParentRunbook('auto-child.runbook.md');
      await writeAutoCompleteChildRunbook();

      // Start parent in non-prompted mode (so child will auto-complete)
      let result = runCli('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent is waiting at substep 1.1
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.step).toBe('1');
      expect(parentState!.substep).toBe('1');
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken();

      // Claim — child auto-completes and propagates pass to parent 1.1
      // DEFER model: parent advances to 1.2
      result = runCli(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Complete parent substep 1.2 → aggregation → PASS ALL → CONTINUE → step 2
      result = runCli('pass --text', workspace);
      expect(result.exitCode).toBe(0);

      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.step).toBe('2');
    });

    it('auto-propagates fail when child stops during claim', async () => {
      await writeParentRunbook('fail-child.runbook.md');
      // Write a child that will fail/stop
      const failChildContent = `## 1. Execute
- FAIL STOP

\`\`\`bash
rd echo --result fail
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'fail-child.runbook.md'), failChildContent);

      // Start parent
      let result = runCli('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const parentState = await getActiveState(workspace);
      const parentRunId = parentState!.id;

      const token = await getAutoIssuedToken();

      // Claim — child auto-fails and propagates fail to parent 1.1
      // DEFER model: parent advances to 1.2
      result = runCli(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(1);

      // Complete parent substep 1.2 → aggregation → FAIL ANY: STOP
      result = runCli('pass --text', workspace);
      expect(result.exitCode).toBe(1);

      // Parent should be stopped
      const updatedParent = await readRunbookState(workspace, parentRunId);
      expect(updatedParent).not.toBeNull();
      expect(updatedParent!.lifecycle).toBe('stopped');
    });
  });
});
