import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createTestWorkspace,
  runCliInProcess,
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

  async function mirrorActiveSubstepStatesIntoSnapshot(): Promise<void> {
    const state = await getActiveState(workspace);
    if (!state) throw new Error('Expected active state');
    const snapshot =
      state.snapshot && typeof state.snapshot === 'object'
        ? (state.snapshot as Record<string, unknown>)
        : {};
    const context =
      snapshot.context && typeof snapshot.context === 'object'
        ? (snapshot.context as Record<string, unknown>)
        : {};
    const stateFile = join(workspace.statePath(), `${state.id}.json`);
    await writeFile(
      stateFile,
      JSON.stringify(
        {
          ...state,
          snapshot: {
            ...snapshot,
            context: {
              ...context,
              substepStates: state.substepStates,
            },
          },
        },
        null,
        2,
      ),
    );
  }

  /** Start a prompted runbook with substeps and create a child runbook. */
  async function setupDelegation(): Promise<void> {
    // Create a child runbook in the workspace
    const childContent = createRunbook({
      steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
    });
    await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

    // Start the substeps runbook in prompted mode
    const startResult = await runCliInProcess(
      'run --prompted runbooks/substeps.runbook.md --text',
      workspace,
    );
    expect(startResult.exitCode).toBe(0);
  }

  describe('successful delegation', () => {
    it('emits a delegation token for a valid substep', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1 --text',
        workspace,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DELEGATED');
      expect(result.stdout).toContain('Token:');
      expect(result.stdout).toContain('rdtk_');
      expect(result.stdout).toContain('RD_CLAIM_TOKEN=');
    });

    it('token has correct format (rdtk_ prefix, length 37)', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
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

      const result = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      expect(substepStates).toBeDefined();

      const ss1 = substepStates?.find((ss) => ss.id === '1');
      expect(ss1?.delegation).toBeDefined();

      const delegation = ss1?.delegation as Record<string, unknown>;
      expect(delegation.tokenHash).toBeDefined();
      expect((delegation.tokenHash as string).startsWith('sha256:')).toBe(true);
      expect(delegation.token).toBe(output.token);
      expect(delegation.childRunId).toBeNull();
    });

    it('status shows delegation info', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = JSON.parse(delegated.stdout).token as string;

      const statusResult = await runCliInProcess('status', workspace);
      expect(statusResult.exitCode).toBe(0);

      const statusOutput = JSON.parse(statusResult.stdout) as Record<string, unknown>;
      const delegations = statusOutput.delegations as Array<Record<string, unknown>> | undefined;
      expect(delegations).toBeDefined();
      expect(delegations).toHaveLength(1);
      expect(delegations?.[0]?.substep).toBe('1');
      expect(delegations?.[0]?.state).toBe('pending');
      expect(delegations?.[0]?.token).toBe(token);
      expect(delegations?.[0]?.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
    });

    it('removes the raw recovery token after claim', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = JSON.parse(delegated.stdout).token as string;

      const claimed = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimed.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown>;
      expect(delegation.childRunId).toEqual(expect.stringMatching(/^rd_[a-f0-9]{32}$/));
      expect(delegation.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
      expect(delegation.token).toBeUndefined();

      const statusResult = await runCliInProcess('status', workspace);
      expect(statusResult.exitCode).toBe(0);
      const statusOutput = JSON.parse(statusResult.stdout) as Record<string, unknown>;
      const delegations = statusOutput.delegations as Array<Record<string, unknown>>;
      expect(delegations[0]?.state).toBe('claimed');
      expect(delegations[0]?.token).toBeUndefined();
    });

    it('removes the raw recovery token from persisted snapshot after claim', async () => {
      await setupDelegation();

      const delegated = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(delegated.exitCode).toBe(0);
      const token = JSON.parse(delegated.stdout).token as string;
      await mirrorActiveSubstepStatesIntoSnapshot();

      const claimed = await runCliInProcess(`claim ${token}`, workspace);
      expect(claimed.exitCode).toBe(0);

      const parent = await getActiveState(workspace);
      if (!parent) throw new Error('Expected parent state');
      const persisted = JSON.parse(
        await readFile(join(workspace.statePath(), `${parent.id}.json`), 'utf-8'),
      ) as {
        snapshot?: {
          context?: { substepStates?: Array<{ delegation?: Record<string, unknown> }> };
        };
      };
      const snapshotDelegation = persisted.snapshot?.context?.substepStates?.[0]?.delegation;
      expect(snapshotDelegation?.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
      expect(snapshotDelegation?.token).toBeUndefined();
    });

    it('JSON output has snake_case keys', async () => {
      await setupDelegation();

      const result = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
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
        '- PASS ALL COMPLETE',
        '- FAIL ANY STOP',
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
      await writeFile(join(workspace.runbooksDir(), 'child.runbook.md'), childContent);

      const startResult = await runCliInProcess(
        'run --prompted runbooks/with-ref.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);
    }

    it('rd delegate (no args) infers both substep and runbook', async () => {
      await setupDelegationWithRunbookRef();

      const result = await runCliInProcess(['delegate'], workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.step).toBe('1.1');
      expect(output.runbook).toBe('child.runbook.md');
    });

    it('rd delegate --step 1.1 infers runbook from substep reference', async () => {
      await setupDelegationWithRunbookRef();

      const result = await runCliInProcess(['delegate', '--step', '1.1'], workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(output.action).toBe('delegated');
      expect(output.step).toBe('1.1');
      expect(output.runbook).toBe('child.runbook.md');
    });

    it('backward compat: explicit rd delegate child.runbook.md --step 1.1 still works', async () => {
      await setupDelegationWithRunbookRef();

      const result = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
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

      const result = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 99.1',
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Step not found');
    });

    it('fails for duplicate delegation on same substep', async () => {
      await setupDelegation();

      // First delegation succeeds
      const first = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(first.exitCode).toBe(0);

      // Second delegation on same substep fails
      const second = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );
      expect(second.exitCode).not.toBe(0);
      expect(second.stdout + second.stderr).toContain('delegation exists');
    });

    it('reports no active runbook when none is running', async () => {
      // Don't start any runbook
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      const result = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );

      // The CLI exits 0 but outputs "no active runbook" per convention
      expect(result.stdout).toContain('No active runbook');
    });

    it('fails for unresolvable child runbook', async () => {
      // Start a runbook but don't create the child
      await runCliInProcess('run --prompted runbooks/substeps.runbook.md --text', workspace);

      const result = await runCliInProcess('delegate nonexistent.runbook.md --step 1.1', workspace);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('not found');
    });

    it('refuses nested delegation when active runbook is itself a claimed child', async () => {
      // Single-level delegation invariant: a claimed (delegated) child runbook
      // may not issue further delegations. Seed an active runbook with
      // `parentLinkage.kind === 'delegation'` (mirroring how `rd claim` writes
      // child state) and verify `rd delegate` is rejected with RD-819 before
      // any token is minted or persisted.
      await setupDelegation();

      const state = await getActiveState(workspace);
      if (!state) throw new Error('Expected active state');
      const stateFile = join(workspace.statePath(), `${state.id}.json`);
      await writeFile(
        stateFile,
        JSON.stringify(
          {
            ...state,
            parentLinkage: {
              kind: 'delegation',
              parentRunId: 'parent-run-id',
              parentStepId: '1',
              tokenHash: `sha256:${'a'.repeat(64)}`,
            },
          },
          null,
          2,
        ),
      );

      const result = await runCliInProcess(
        'delegate runbooks/child.runbook.md --step 1.1',
        workspace,
      );

      expect(result.exitCode).not.toBe(0);
      // withErrorHandling -> toJSON envelope emits the formatted error code.
      expect(result.stdout + result.stderr).toMatch(/RD-819/);
      expect(result.stdout + result.stderr).toMatch(/nested delegation forbidden/i);

      // No token persisted: state.substepStates retains the original (no
      // delegation field on substep '1').
      const after = await getActiveState(workspace);
      const substepStates = after?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      expect(ss1?.delegation).toBeUndefined();
    });
  });

  describe('rd delegate --retry', () => {
    it('token form: cancels old delegation and mints fresh token', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;
      const originalHash = firstOutput.token_hash as string;

      const retry = await runCliInProcess(['delegate', '--retry', originalToken], workspace);

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect((retryOutput.token as string).startsWith('rdtk_')).toBe(true);
      expect(retryOutput.token).not.toBe(originalToken);
      expect(retryOutput.token_hash).not.toBe(originalHash);
      expect(retryOutput.step).toBe('1.1');
    });

    it('--step form: resolves active-frame substep and retries', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(['delegate', '--retry', '--step', '1.1'], workspace);

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect(retryOutput.token).not.toBe(originalToken);
      expect(retryOutput.step).toBe('1.1');
    });

    it('inferred form: retries the active substep delegation', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(['delegate', '--retry'], workspace);

      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect(retryOutput.token).not.toBe(originalToken);
    });

    it('rejects ambiguity: token + --step both provided', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);
      const firstOutput = JSON.parse(first.stdout) as Record<string, unknown>;
      const originalToken = firstOutput.token as string;

      const retry = await runCliInProcess(
        ['delegate', '--retry', originalToken, '--step', '1.1'],
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toMatch(/specify either a token or --step/);
    });

    it('errors when --step has no delegation', async () => {
      await setupDelegation();

      const retry = await runCliInProcess(['delegate', '--retry', '--step', '1.1'], workspace);

      expect(retry.exitCode).not.toBe(0);
      // Retry CLI now propagates the inner RundownError verbatim through
      // withErrorHandling — RD-801 is "Step not found", produced by
      // retryDelegation's not_found variant via Errors.delegationStepNotFound.
      expect(retry.stdout + retry.stderr).toMatch(/RD-801/);
    });

    it('errors when token is unknown', async () => {
      await setupDelegation();

      const retry = await runCliInProcess(
        ['delegate', '--retry', 'rdtk_unknown00000000000000000000000000'],
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toMatch(/token .* not found/i);
    });

    it('errors when inferred form has no active runbook', async () => {
      // No runbook started — sessionService.getActive() returns null on the
      // inferred path, hitting the explicit fail() at delegate.ts:388-390.
      const retry = await runCliInProcess(['delegate', '--retry'], workspace);

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toContain(
        '--retry requires a token, --step <id>, or an active substep',
      );
    });

    it('errors when inferred form has no active substep', async () => {
      // Start a runbook whose active cursor sits on a step with no substeps
      // (single-step runbook, prompted mode) — state exists but
      // activeState.substep is undefined, hitting the fail() at
      // delegate.ts:392-394.
      const content = createRunbook({
        steps: [{ title: 'Only step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'single.runbook.md'), content);
      const start = await runCliInProcess(
        'run --prompted runbooks/single.runbook.md --text',
        workspace,
      );
      expect(start.exitCode).toBe(0);

      const retry = await runCliInProcess(['delegate', '--retry'], workspace);

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toContain(
        '--retry requires a token, --step <id>, or an active substep',
      );
    });

    it('errors when --step targets an off-frontier step', async () => {
      // setupDelegation starts at step '1'. Create a delegation on 1.1, then advance
      // the cursor past step 1 so a retry --step 1.1 sees a non-current step.
      await setupDelegation();
      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);

      // Move cursor off step 1 by goto'ing step 2.
      const goto = await runCliInProcess(['goto', '2'], workspace);
      expect(goto.exitCode).toBe(0);

      const retry = await runCliInProcess(['delegate', '--retry', '--step', '1.1'], workspace);

      expect(retry.exitCode).not.toBe(0);
      // Retry CLI now propagates the inner RundownError verbatim through
      // withErrorHandling — RD-802 is "Step not at execution frontier",
      // produced by retryDelegation's not_current variant via
      // Errors.delegationStepNotCurrent.
      expect(retry.stdout + retry.stderr).toMatch(/RD-802/);
    });

    it('inherits extraVars from the prior delegation', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        [
          'delegate',
          'runbooks/child.runbook.md',
          '--step',
          '1.1',
          '--input',
          'environment=staging',
        ],
        workspace,
      );
      expect(first.exitCode).toBe(0);

      const retry = await runCliInProcess(['delegate', '--retry', '--step', '1.1'], workspace);
      expect(retry.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown> | undefined;
      const extraVars = delegation?.extraVars as Record<string, unknown> | undefined;
      expect(extraVars).toEqual({ environment: 'staging' });
    });

    it('overrides inherited vars when --input is passed', async () => {
      await setupDelegation();

      const first = await runCliInProcess(
        [
          'delegate',
          'runbooks/child.runbook.md',
          '--step',
          '1.1',
          '--input',
          'environment=staging',
        ],
        workspace,
      );
      expect(first.exitCode).toBe(0);

      const retry = await runCliInProcess(
        ['delegate', '--retry', '--step', '1.1', '--input', 'environment=production'],
        workspace,
      );
      expect(retry.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      const ss1 = substepStates?.find((ss) => ss.id === '1');
      const delegation = ss1?.delegation as Record<string, unknown> | undefined;
      const extraVars = delegation?.extraVars as Record<string, unknown> | undefined;
      expect(extraVars).toEqual({ environment: 'production' });
    });

    it('accepts retry on a non-failed delegation (result-agnostic per spec §4.4)', async () => {
      await setupDelegation();

      // Create a delegation; default substepState status is 'pending' (not failed).
      const first = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1'],
        workspace,
      );
      expect(first.exitCode).toBe(0);

      // Retry succeeds regardless of substep result.
      const retry = await runCliInProcess(['delegate', '--retry', '--step', '1.1'], workspace);
      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');
      expect((retryOutput.token as string).startsWith('rdtk_')).toBe(true);
    });

    it('rejects --index on a non-FOR step with a clear error', async () => {
      // substeps.runbook.md step 1 has kind 'substeps', not 'for'.
      await setupDelegation();

      const retry = await runCliInProcess(
        ['delegate', '--retry', '--step', '1.1', '--index', '3'],
        workspace,
      );

      expect(retry.exitCode).not.toBe(0);
      expect(retry.stdout + retry.stderr).toMatch(/--index requires step .* to be a FOR step/);
    });

    it('FOR-iteration: --step with --index targets the right frame', async () => {
      // Write a FOR parent with a substep that can host delegations per iteration.
      const parentContent = createRunbook({
        title: 'FOR Parent',
        steps: [
          {
            title: 'Process items',
            for: { variable: 'i', start: 1, end: 2 },
            pass: 'CONTINUE',
            substeps: [{ title: 'Handle item', content: 'Handle item {{i}}.' }],
          },
          { title: 'Done', pass: 'COMPLETE', content: 'Final step.' },
        ],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'for-parent.runbook.md'), parentContent);

      // Create the child runbook used for delegation
      const childContent = createRunbook({
        steps: [{ title: 'Child step', pass: 'COMPLETE', command: 'rd echo --result pass' }],
      });
      await writeFile(join(workspace.cwd, 'runbooks', 'child.runbook.md'), childContent);

      // Start the parent in prompted mode
      const startResult = await runCliInProcess(
        'run --prompted runbooks/for-parent.runbook.md --text',
        workspace,
      );
      expect(startResult.exitCode).toBe(0);

      // Seed delegations in both FOR iteration frames (buildFrameKey('1', 1) and ('1', 2))
      const del1 = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '1'],
        workspace,
      );
      expect(del1.exitCode).toBe(0);
      const del1Output = JSON.parse(del1.stdout) as Record<string, unknown>;
      const _iter1Token = del1Output.token as string;
      const iter1Hash = del1Output.token_hash as string;

      const del2 = await runCliInProcess(
        ['delegate', 'runbooks/child.runbook.md', '--step', '1.1', '--index', '2'],
        workspace,
      );
      expect(del2.exitCode).toBe(0);
      const del2Output = JSON.parse(del2.stdout) as Record<string, unknown>;
      const iter2Token = del2Output.token as string;
      const iter2Hash = del2Output.token_hash as string;

      // Retry only iteration 2
      const retry = await runCliInProcess(
        ['delegate', '--retry', '--step', '1.1', '--index', '2'],
        workspace,
      );
      expect(retry.exitCode).toBe(0);
      const retryOutput = JSON.parse(retry.stdout) as Record<string, unknown>;
      expect(retryOutput.action).toBe('retried');

      // Iteration 2 got a fresh token
      expect(retryOutput.token).not.toBe(iter2Token);
      expect(retryOutput.token_hash).not.toBe(iter2Hash);

      // Verify frame isolation in persisted state: iteration 1 is untouched,
      // iteration 2 has the new hash.
      const state = await getActiveState(workspace);
      const substepStates = state?.substepStates as Array<Record<string, unknown>> | undefined;
      expect(substepStates).toBeDefined();

      const iter1Entry = substepStates?.find((ss) => ss.id === '1' && ss.frameKey === '1|1');
      const iter2Entry = substepStates?.find((ss) => ss.id === '1' && ss.frameKey === '1|2');
      expect(iter1Entry).toBeDefined();
      expect(iter2Entry).toBeDefined();

      const iter1Delegation = iter1Entry?.delegation as Record<string, unknown> | undefined;
      const iter2Delegation = iter2Entry?.delegation as Record<string, unknown> | undefined;

      // Iteration 1 preserved its original hash — frame isolation.
      expect(iter1Delegation?.tokenHash).toBe(iter1Hash);
      expect(iter1Delegation?.cancelledAt).toBeNull();

      // Iteration 2 has the fresh hash and the old one is gone.
      expect(iter2Delegation?.tokenHash).toBe(retryOutput.token_hash);
      expect(iter2Delegation?.tokenHash).not.toBe(iter2Hash);
    });
  });
});
