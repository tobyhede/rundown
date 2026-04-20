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

  async function writeParentRunbook(): Promise<void> {
    const content = createRunbook({
      title: 'Parent',
      steps: [
        {
          title: 'Review',
          pass: 'CONTINUE',
          substeps: [
            { title: 'Code review', content: 'Do code review.' },
            { title: 'Security review', content: 'Do security review.' },
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

    // Delegate substep 1.1 to child runbook
    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).action).toBe('delegated');

    // Extract token from output
    const delegateOutput = JSON.parse(result.stdout) as { token?: string };
    expect(delegateOutput.token).toBeDefined();
    const token = delegateOutput.token!;

    // Claim the token — should launch child runbook
    result = runCli(`claim ${token} --text`, workspace);
    expect(result.exitCode).toBe(0);
  });

  it('idempotent re-claim returns same child run', async () => {
    await writeParentRunbook();
    await writeChildRunbook();

    // Start parent, delegate
    let result = runCli('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const delegateOutput2 = JSON.parse(result.stdout) as { token?: string };
    expect(delegateOutput2.token).toBeDefined();
    const token = delegateOutput2.token!;

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

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const delegateOutput = JSON.parse(result.stdout);
    expect(delegateOutput.token).toBeDefined();

    const claimToken = delegateOutput.token as string;
    result = runCli(`claim ${claimToken}`, workspace);

    // Command should succeed
    expect(result.exitCode).toBe(0);

    // Parse last JSON line — claim output follows child-run JSON events
    const jsonLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(claimOutput.action).toBe('claimed');
    expect(claimOutput.token).toMatch(/^rdtk_.{3}\.\.\..{4}$/);
    expect(typeof claimOutput.run_id).toBe('string');
    expect(typeof claimOutput.runbook).toBe('string');
    expect(typeof claimOutput.parent_run_id).toBe('string');
    expect(typeof claimOutput.parent_step).toBe('string');
  });

  it('claim with --var-file merges file variables into child context', async () => {
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

    result = runCli('delegate child.runbook.md --step 1.1', workspace);
    expect(result.exitCode).toBe(0);
    const tokenMatch = /"token":\s*"(rdtk_[^"]+)"/.exec(result.stdout);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];

    // Claim with --var-file
    result = runCli(`claim ${token} --var-file vars.yaml`, workspace);
    expect(result.exitCode).toBe(0);

    // Verify the variable was rendered in child execution output
    expect(result.stdout).toContain('Task uses fromFile.');

    // Parse last JSON line for claimed output
    const jsonLines = result.stdout.trim().split('\n');
    const claimOutput = JSON.parse(jsonLines[jsonLines.length - 1]);
    expect(claimOutput.action).toBe('claimed');
  });

  it('claim outputs structured error for invalid token', () => {
    const result = runCli('claim bad-token', workspace);
    expect(result.exitCode).toBe(1);

    const output = JSON.parse(result.stderr);
    expect(output.message).toBeDefined();
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
      '      - rd delegate child.runbook.md --step 1.1',
      '      - rd claim ${TOKEN_0}',
      '---',
      '',
      '## 1. Parent',
      '- PASS ALL COMPLETE',
      '- FAIL ANY STOP',
      '',
      '### 1.1 Delegated step',
      'Do work.',
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
      await writeParentRunbook();
      await writeAutoCompleteChildRunbook();

      // Start parent in non-prompted mode (so child will auto-complete)
      let result = runCli('run parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      // Verify parent is waiting at substep 1.1
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      expect(parentState!.step).toBe('1');
      expect(parentState!.substep).toBe('1');
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = runCli('delegate auto-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const delegateOutput = JSON.parse(result.stdout) as { token?: string };
      expect(delegateOutput.token).toBeDefined();
      const token = delegateOutput.token!;

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
      await writeParentRunbook();
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
      const parentRunId = parentState!.id as string;

      // Delegate substep 1.1
      result = runCli('delegate fail-child.runbook.md --step 1.1', workspace);
      expect(result.exitCode).toBe(0);
      const delegateOutput = JSON.parse(result.stdout) as { token?: string };
      expect(delegateOutput.token).toBeDefined();
      const token = delegateOutput.token!;

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
