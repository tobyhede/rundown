import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCli,
  getActiveState,
  type TestWorkspace,
  createRunbook,
} from '../helpers/test-utils.js';

describe('delegate command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Start a prompted runbook with substeps and create a child runbook. */
  async function setupDelegation(): Promise<void> {
    // Create a child runbook in the workspace
    const childContent = createRunbook({
      steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

    // Start the substeps runbook in prompted mode
    const startResult = runCli('run --prompted runbooks/substeps.runbook.md', workspace);
    expect(startResult.exitCode).toBe(0);
  }

  describe('successful delegation', () => {
    it('emits a delegation token for a valid substep', async () => {
      await setupDelegation();

      const result = runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DELEGATED');
      expect(result.stdout).toContain('Token:');
      expect(result.stdout).toContain('rdtk_');
      expect(result.stdout).toContain('RD_CLAIM_TOKEN=');
    });

    it('token has correct format (rdtk_ prefix, length 37)', async () => {
      await setupDelegation();

      const result = runCli(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--json'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      const token = output.token as string;
      expect(token.startsWith('rdtk_')).toBe(true);
      expect(token.length).toBe(37);
    });

    it('updates state with delegation on substep', async () => {
      await setupDelegation();

      runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      expect(substepStates).toBeDefined();

      const ss1 = substepStates?.find((ss) => ss.id === '1');
      expect(ss1?.delegation).toBeDefined();

      const delegation = ss1?.delegation as Record<string, unknown>;
      expect(delegation.tokenHash).toBeDefined();
      expect((delegation.tokenHash as string).startsWith('sha256:')).toBe(true);
      expect(delegation.childRunId).toBeNull();
    });

    it('status --json shows delegation info', async () => {
      await setupDelegation();

      runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);

      const statusResult = runCli('status --json', workspace);
      expect(statusResult.exitCode).toBe(0);

      const statusOutput = JSON.parse(statusResult.stdout) as Record<string, unknown>;
      const delegations = statusOutput.delegations as Array<Record<string, unknown>> | undefined;
      expect(delegations).toBeDefined();
      expect(delegations).toHaveLength(1);
      expect(delegations?.[0]?.substep).toBe('1');
      expect(delegations?.[0]?.state).toBe('pending');
    });

    it('JSON output has snake_case keys', async () => {
      await setupDelegation();

      const result = runCli(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--json'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.token).toBeDefined();
      expect(output.token_hash).toBeDefined();
      expect(output.parent_run_id).toBeDefined();
    });
  });

  describe('inference', () => {
    /**
     * Setup a runbook whose substep has a runbook reference (`- child.runbook.md`),
     * enabling `rd delegate` to infer both target and runbook.
     */
    async function setupDelegationWithRunbookRef(): Promise<void> {
      // Parent runbook: substep 1.1 references child.runbook.md
      const parentContent = [
        '# Delegation Test',
        '',
        '## 1. Main step',
        '',
        '- PASS ALL: COMPLETE',
        '- FAIL ANY: STOP',
        '',
        '### 1.1 Child task',
        '',
        'Delegated to a child runbook.',
        '',
        '- child.runbook.md',
      ].join('\n');
      await writeFile(join(workspace.cwd, 'runbooks', 'with-ref.runbook.md'), parentContent);

      // Create child runbook in all discovery locations
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);
      await writeFile(
        join(workspace.cwd, '.claude', 'rundown', 'runbooks', 'child.runbook.md'),
        childContent,
      );

      const startResult = runCli('run --prompted runbooks/with-ref.runbook.md', workspace);
      expect(startResult.exitCode).toBe(0);
    }

    it('rd delegate (no args) infers both substep and runbook', async () => {
      await setupDelegationWithRunbookRef();

      const result = runCli(['delegate', '--json'], workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.step).toBe('1.1');
      expect(output.runbook).toBe('child.runbook.md');
    });

    it('rd delegate --step 1.1 infers runbook from substep reference', async () => {
      await setupDelegationWithRunbookRef();

      const result = runCli(['delegate', '--step', '1.1', '--json'], workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.step).toBe('1.1');
      expect(output.runbook).toBe('child.runbook.md');
    });

    it('backward compat: explicit rd delegate child.runbook.md --step 1.1 still works', async () => {
      await setupDelegationWithRunbookRef();

      const result = runCli(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--json'],
        workspace,
      );

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.step).toBe('1.1');
    });
  });

  describe('error cases', () => {
    it('fails for nonexistent step', async () => {
      await setupDelegation();

      const result = runCli('delegate runbooks/child.runbook.md --step 99.1', workspace);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('step not found');
    });

    it('fails for duplicate delegation on same substep', async () => {
      await setupDelegation();

      // First delegation succeeds
      const first = runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);
      expect(first.exitCode).toBe(0);

      // Second delegation on same substep fails
      const second = runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain('delegation exists');
    });

    it('reports no active runbook when none is running', async () => {
      // Don't start any runbook
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const result = runCli('delegate runbooks/child.runbook.md --step 1.1', workspace);

      // The CLI exits 0 but outputs "no active runbook" per convention
      expect(result.stdout).toContain('No active runbook');
    });

    it('fails for unresolvable child runbook', async () => {
      // Start a runbook but don't create the child
      runCli('run --prompted runbooks/substeps.runbook.md', workspace);

      const result = runCli('delegate nonexistent.runbook.md --step 1.1', workspace);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not found');
    });
  });
});
