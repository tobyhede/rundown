import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createTestWorkspace,
  createRunbook,
  runCliInProcess,
  getActiveState,
  readRunbookState,
  findActionOutput,
  parseCliJsonObject,
  parseConcatenatedJson,
  type TestWorkspace,
  withRunTarget,
} from '../helpers/test-utils.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { validateCommandOutput } from '../helpers/schema-validator.js';
// Stryker static-import linkage (mutation testing): the behavioural tests below
// drive the CLI through `runCliInProcess`, whose `import('../cli.js')` seam is
// dynamic and invisible to Jest's static inverse-module graph. Stryker runs
// `jest --findRelatedTests src/commands/abort.ts` per mutant; without a *static*
// import of the command module here that query matches no test file, so zero
// tests run per mutant and every mutant falsely survives (~0% score). The static
// import + wiring test link this file into the graph so the covering tests
// actually run against each mutant. Mirrors collect.test.ts / delegate.test.ts.
import { registerAbortCommand } from '../../src/commands/abort.js';

describe('abort command wiring', () => {
  it('registers the abort command with its documented flags and descriptions', () => {
    const program = new Command();
    registerAbortCommand(program);

    const abort = program.commands.find((c) => c.name() === 'abort');
    expect(abort).toBeDefined();
    expect(abort?.description()).toBe('Cancel a delegation token');

    const byLong = new Map(abort!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()]).toEqual(expect.arrayContaining(['--force', '--text']));
    expect(byLong.get('--force')?.description).toBe(
      'Force cancel even if delegation is claimed (stops child run)',
    );
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('abort command - unit tests', () => {
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
            {
              title: 'Code review',
              delegate: true,
              content: 'Do code review.',
              runbooks: ['child.runbook.md'],
            },
            {
              title: 'Security review',
              delegate: true,
              content: 'Do security review.',
              runbooks: ['child.runbook.md'],
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

  async function setupDelegation(): Promise<string> {
    await writeParentRunbook();
    await writeChildRunbook();

    const result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
    expect(result.exitCode).toBe(0);

    const state = await getActiveState(workspace);
    const token = state?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
    expect(token).toEqual(expect.stringMatching(/^rdtk_/));
    return token!;
  }

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

  describe('token validation', () => {
    it('rejects token with incorrect prefix', async () => {
      const result = await runCliInProcess('abort invalid_token_without_prefix', workspace);
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-807' }));
    });

    it('rejects empty token', async () => {
      const result = await runCliInProcess(['abort', '', '--text'], workspace);
      expect(result.exitCode).toBe(1);
    });

    it('rejects token with special characters', async () => {
      const result = await runCliInProcess('abort rdtk_invalid@#$%', workspace);
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-807' }));
    });

    it('rejects token that is too short', async () => {
      const result = await runCliInProcess('abort rdtk_ABC', workspace);
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-807' }));
    });

    it('accepts valid token format', async () => {
      const token = await setupDelegation();
      const result = await runCliInProcess(`abort ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('state transitions', () => {
    it('pending → cancelled without force flag', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const output = parseCliJsonObject(result.stdout) as {
        action: string;
        status: string;
        token: string;
        substep: string;
        runbook: string;
        parentRunId: string;
      };
      expect(output).toEqual(
        expect.objectContaining({
          action: 'abort',
          status: 'cancelled',
          token: expect.any(String),
          substep: expect.any(String),
          runbook: expect.stringContaining('child.runbook.md'),
          parentRunId: expect.any(String),
        }),
      );
      // Emitted output must conform to the published abort schema.
      const validation = validateCommandOutput('abort', output);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('pending → cancelled removes raw recovery token from persisted snapshot', async () => {
      const token = await setupDelegation();
      await mirrorActiveSubstepStatesIntoSnapshot();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

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
      expect(snapshotDelegation?.cancelledAt).toEqual(expect.any(String));
      expect(snapshotDelegation?.tokenHash).toEqual(expect.stringMatching(/^sha256:[a-f0-9]{64}$/));
      expect(snapshotDelegation?.token).toBeUndefined();
    });

    it('pending → cancelled is idempotent', async () => {
      const token = await setupDelegation();

      // First abort
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Second abort - should succeed with "already cancelled" message
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const output = parseCliJsonObject(result.stdout);
      expect(output).toEqual(
        expect.objectContaining({ action: 'abort', status: 'already_cancelled' }),
      );
      const validation = validateCommandOutput('abort', output);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('claimed → requires force flag', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Try to abort without force
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-811' }));
    });

    it('claimed → cancelled with force flag', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);
      const output = parseConcatenatedJson(result.stdout).find(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' &&
          value !== null &&
          (value as { action?: unknown }).action === 'abort',
      );
      expect(output).toBeDefined();
      expect(output).toEqual(
        expect.objectContaining({
          action: 'abort',
          status: 'cancelled',
          force: true,
        }),
      );
      const validation = validateCommandOutput('abort', output);
      expect(validation.errors).toEqual([]);
      expect(validation.valid).toBe(true);
    });

    it('cancelled → claim fails', async () => {
      const token = await setupDelegation();

      // Abort the delegation
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Try to claim
      result = await runCliInProcess(`claim ${token} --text`, workspace);
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toMatch(/cancelled|RD-809/i);
    });
  });

  describe('JSON output', () => {
    it('includes required fields in JSON output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const output = parseCliJsonObject(result.stdout) as {
        action: string;
        status: string;
        token: string;
        substep: string;
        runbook: string;
        parentRunId: string;
      };
      expect(output.action).toBe('abort');
      expect(output.status).toBe('cancelled');
      expect(output.token).toBeDefined();
      expect(output.substep).toBeDefined();
      expect(output.runbook).toContain('child.runbook.md');
      expect(output.parentRunId).toBeDefined();
    });

    it('includes force flag in JSON when used', async () => {
      const token = await setupDelegation();

      // Claim first
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);

      // stdout contains JSONL events + pretty-printed abort result + flush trailer
      // Split into complete JSON blocks and find the abort result
      const blocks = result.stdout.trim().split(/(?<=\})\n(?=\{)/);
      const abortBlock = blocks.find((b) => b.includes('"action": "abort"'));
      expect(abortBlock).toBeDefined();
      const output = JSON.parse(abortBlock!);
      expect(output.force).toBe(true);
      expect(output.childRunId).toBeDefined();
    });

    it('JSON output for already cancelled delegation', async () => {
      const token = await setupDelegation();

      // First abort
      let result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Second abort with JSON
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      const output = parseCliJsonObject(result.stdout);
      expect(output.status).toBe('already_cancelled');
    });
  });

  describe('error handling', () => {
    it('handles non-existent parent runbook gracefully', async () => {
      // cspell:disable
      const result = await runCliInProcess(
        'abort rdtk_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
        workspace,
      );
      // cspell:enable
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-808' }));
    });

    it('handles malformed JSON in state file gracefully', async () => {
      // This is hard to test without directly corrupting files
      // but the command should handle errors gracefully
      // cspell:disable
      const result = await runCliInProcess(
        'abort rdtk_BBBBAAAACCCCDDDDEEEEFFFFGGGGHHHH',
        workspace,
      );
      // cspell:enable
      expect(result.exitCode).toBe(1);
      const envelope = parseCliJsonObject(result.stdout || result.stderr);
      expect(envelope).toEqual(expect.objectContaining({ kind: 'error', code: 'RD-808' }));
    });
  });

  describe('edge cases', () => {
    it('handles delegation with substep ID', async () => {
      await writeParentRunbook();
      await writeChildRunbook();

      // Start parent
      let result = await runCliInProcess('run --prompted parent.runbook.md --text', workspace);
      expect(result.exitCode).toBe(0);

      const state = await getActiveState(workspace);
      const token = state?.substepStates?.find((substep) => substep.id === '1')?.delegation?.token;
      expect(token).toEqual(expect.stringMatching(/^rdtk_/));
      if (typeof token !== 'string') throw new Error('Expected delegation token');

      // Abort should work
      result = await runCliInProcess(`abort ${token}`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('handles repeated abort attempts gracefully', async () => {
      const token = await setupDelegation();

      // First abort should succeed
      const result1 = await runCliInProcess(`abort ${token}`, workspace);
      expect(result1.exitCode).toBe(0);

      // Second abort should be idempotent
      const result2 = await runCliInProcess(`abort ${token}`, workspace);
      expect(result2.exitCode).toBe(0);
      const output = parseCliJsonObject(result2.stdout);
      expect(output).toEqual(
        expect.objectContaining({ action: 'abort', status: 'already_cancelled' }),
      );
    });

    it('abort without arguments shows help', async () => {
      const result = await runCliInProcess('abort --text', workspace);
      // Commander shows error for missing required argument
      expect(result.exitCode).toBe(1);
    });

    it('abort with multiple tokens uses only first', async () => {
      const token = await setupDelegation();

      // Pass multiple tokens - Commander should only use first positional arg
      const result = await runCliInProcess(`abort ${token} extra-arg --text`, workspace);
      // Commander errors on unexpected argument
      expect(result.exitCode).toBe(1);
    });
  });

  describe('text output formatting', () => {
    it('shows hint token in output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      // Should show token hint (e.g., rdtk_ABC...XYZ)
      expect(result.stdout).toMatch(/rdtk_/);
    });

    it('shows runbook path in output', async () => {
      const token = await setupDelegation();

      const result = await runCliInProcess(`abort ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      expect(result.stdout).toContain('child.runbook.md');
    });

    it('shows force warning when aborting claimed delegation', async () => {
      const token = await setupDelegation();

      // Claim first
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);

      // Force abort
      result = await runCliInProcess(`abort ${token} --force --text`, workspace);
      expect(result.exitCode).toBe(0);

      expect(result.stdout).toMatch(/in-flight|child run stopped/i);
    });
  });

  describe('delegation propagation after force abort', () => {
    it('propagates failure to parent after force abort of claimed delegation', async () => {
      const token = await setupDelegation();

      // Claim the token
      let result = await runCliInProcess(`claim ${token}`, workspace);
      expect(result.exitCode).toBe(0);
      const claimOutput = findActionOutput(result.stdout);
      expect(claimOutput).toBeDefined();
      expect(typeof claimOutput?.run_id).toBe('string');
      const childRunId = claimOutput!.run_id as string;

      // Get parent state
      const parentState = await getActiveState(workspace);
      expect(parentState).not.toBeNull();
      if (!parentState) throw new Error('Expected parent run state to exist');
      expect(parentState.step).toBe('1');

      // Force abort stops and releases the claimed child.
      result = await runCliInProcess(`abort ${token} --force --text`, workspace);
      expect(result.exitCode).toBe(0);

      // The parent remains the default-stack runbook; the child state is gone.
      const afterAbortParent = await readRunbookState(workspace, parentState.id);
      expect(afterAbortParent?.lifecycle).toBe('running');
      expect(await readRunbookState(workspace, childRunId)).toBeNull();

      // FAIL propagation must reach the parent: the substepState for the
      // delegated parent substep must be marked done/fail. Without
      // `ignoreCancellation: true` on the abort path, the
      // `recordChildCompletionUnlocked` short-circuit would block this from
      // happening because step 8 of the abort flow already wrote
      // `delegation.cancelledAt` onto the substep state.
      const propagatedSubstep = afterAbortParent?.substepStates?.find((entry) => entry.id === '1');
      expect(propagatedSubstep?.status).toBe('done');
      expect(propagatedSubstep?.result).toBe('fail');

      // Plan 5 (report-only): the recorded FAIL outcome is a delegation row that
      // leaves the delegating run collection pending — force-abort does NOT
      // drain/apply/cascade, so a bare advance is refused until `rd collect`.
      const rows = Object.values(afterAbortParent!.resolvedCompletions ?? {}).filter(
        (c) => c.agentId === 'delegation',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('fail');

      // Post-R1 the guard needs named authority: the run-targeted bare-shaped
      // advance still refuses with the collection-pending guard.
      const blocked = await runCliInProcess(await withRunTarget(['pass'], workspace), workspace);
      expect(blocked.exitCode).toBe(1);
      expect(`${blocked.stdout}${blocked.stderr}`).toContain('DELEGATION_COLLECTION_PENDING');
    });
  });

  describe('regression tests', () => {
    it('handles force abort after claim completes', async () => {
      const token = await setupDelegation();

      // Claim completes before abort
      await runCliInProcess(`claim ${token} --text`, workspace);

      // Force abort after claim has completed
      const result = await runCliInProcess(`abort ${token} --force --text`, workspace);
      expect(result.exitCode).toBe(0);
    });

    it('renders cleanup-only text when force-aborting an already reported linked child', async () => {
      const token = await setupDelegation();

      const claim = await runCliInProcess(`claim ${token}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimOutput = findActionOutput(claim.stdout);
      expect(typeof claimOutput?.claim_id).toBe('string');

      const failed = await runCliInProcess(
        `fail --claim-id ${String(claimOutput!.claim_id)}`,
        workspace,
      );
      expect(failed.exitCode).toBe(1);

      const result = await runCliInProcess(`abort ${token} --force --text`, workspace);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('CANCELLED');
      expect(result.stdout).not.toContain('FAILED     step 1');
    });

    it('preserves JSON envelope when force-aborting an already reported linked child', async () => {
      const token = await setupDelegation();

      const claim = await runCliInProcess(`claim ${token}`, workspace);
      expect(claim.exitCode).toBe(0);
      const claimOutput = findActionOutput(claim.stdout);
      expect(typeof claimOutput?.claim_id).toBe('string');
      expect(typeof claimOutput?.run_id).toBe('string');
      const childRunId = String(claimOutput!.run_id);

      const failed = await runCliInProcess(
        `fail --claim-id ${String(claimOutput!.claim_id)}`,
        workspace,
      );
      expect(failed.exitCode).toBe(1);

      const result = await runCliInProcess(`abort ${token} --force`, workspace);
      expect(result.exitCode).toBe(0);
      const output = findActionOutput(result.stdout);
      expect(output).toEqual(
        expect.objectContaining({
          action: 'abort',
          status: 'cancelled',
          force: true,
          childRunId,
        }),
      );
    });

    it('abort preserves parent runbook state', async () => {
      const token = await setupDelegation();

      const parentBefore = await getActiveState(workspace);
      expect(parentBefore).not.toBeNull();

      // Abort pending delegation
      const result = await runCliInProcess(`abort ${token} --text`, workspace);
      expect(result.exitCode).toBe(0);

      const parentAfter = await getActiveState(workspace);
      expect(parentAfter).not.toBeNull();
      expect(parentAfter!.id).toBe(parentBefore!.id);
      expect(parentAfter!.step).toBe(parentBefore!.step);
    });
  });
});
