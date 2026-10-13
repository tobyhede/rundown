import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Errors, RunbookStateManager, type RunId } from '@rundown-org/core';
import {
  createTestWorkspace,
  runCliInProcess,
  listRunbookStates,
  readRunbookState,
  requireOwnerToken,
  requireRunId,
  type TestWorkspace,
} from '../helpers/test-utils.js';
import { patchPersistedRunState, seedRun } from '@rundown-org/core/testing/run-fixtures';
import { validateCommandOutput } from '../helpers/schema-validator.js';
import { Command } from 'commander';
// Stryker static-import linkage (mutation testing): links this test file into
// Jest's static inverse-module graph so `--findRelatedTests src/commands/prune.ts`
// credits the behavioural tests below (which reach the command only via the
// dynamic `import('../cli.js')` seam in runCliInProcess).
import { registerPruneCommand } from '../../src/commands/prune.js';

const UNKNOWN_TOKEN = 'rdo_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('prune command wiring', () => {
  it('registers the prune command with its documented flags and descriptions', () => {
    const program = new Command();
    registerPruneCommand(program);

    const prune = program.commands.find((c) => c.name() === 'prune');
    expect(prune).toBeDefined();
    expect(prune?.description()).toBe('Remove run state (does not delete runbook files)');

    const byLong = new Map(prune!.options.map((o) => [o.long, o]));
    expect([...byLong.keys()].sort()).toEqual(
      [
        '--dry-run',
        '--completed',
        '--stopped',
        '--active',
        '--inactive',
        '--all',
        '--token',
        '--text',
      ].sort(),
    );
    expect(byLong.get('--dry-run')?.description).toBe(
      'Show what would be removed without deleting',
    );
    expect(byLong.get('--completed')?.description).toBe('Prune successfully completed run state');
    expect(byLong.get('--stopped')?.description).toBe('Prune stopped (aborted/failed) run state');
    expect(byLong.get('--active')?.description).toBe(
      'Prune running run state (each running run needs its --token)',
    );
    expect(byLong.get('--inactive')?.description).toBe('Prune invalid or abandoned run state');
    expect(byLong.get('--all')?.description).toBe('Prune all run state');
    expect(byLong.get('--token')?.description).toContain('deletes that one running run');
    expect(byLong.get('--text')?.description).toBe('Output as human-readable text');
  });
});

describe('prune command', () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  /** Start a prompted run that stays running; returns its id and Owner Token. */
  async function startRunning(): Promise<{ runId: string; token: string }> {
    const start = await runCliInProcess('run --prompted runbooks/simple.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    return { runId: requireRunId(start.stdout), token: requireOwnerToken(start.stdout) };
  }

  /** Auto-run completes simple.runbook.md (both steps pass). */
  async function startCompleted(): Promise<string> {
    const start = await runCliInProcess('run runbooks/simple.runbook.md', workspace);
    expect(start.exitCode).toBe(0);
    return requireRunId(start.stdout);
  }

  /** Start a prompted run and stop it under its own token. */
  async function startStopped(): Promise<string> {
    const { runId, token } = await startRunning();
    const stopped = await runCliInProcess(`stop --token ${token}`, workspace);
    expect(stopped.exitCode).toBe(1);
    return runId;
  }

  describe('empty workspace', () => {
    it('outputs empty message when no state exists', async () => {
      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No run state to prune.');
    });

    it('outputs empty array in JSON mode when no state exists', async () => {
      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });

    it('leaves unrelated JSON files byte-identical', async () => {
      const inertFiles = [
        join(workspace.cwd, '.rundown', 'session.json'),
        join(workspace.cwd, '.rundown', 'runs', 'rd_legacy.json'),
        join(workspace.cwd, '.claude', 'rundown', 'session.json'),
      ];
      const bytes = Buffer.from([0, 255, 123, 110, 111, 116, 45, 106, 115, 111, 110]);
      for (const file of inertFiles) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
      }

      const result = await runCliInProcess('prune --all', workspace);

      expect(result.exitCode).toBe(0);
      for (const file of inertFiles) {
        await expect(readFile(file)).resolves.toEqual(bytes);
      }
    });
  });

  describe('default behavior (--completed + --stopped)', () => {
    it('prunes completed run state by default', async () => {
      await startCompleted();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('emits only the documented entry fields in JSON, not raw RunbookState', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(validateCommandOutput('prune', output)).toEqual({ valid: true, errors: [] });
      expect(output.length).toBeGreaterThan(0);
      const allowed = ['id', 'runbook', 'step', 'status', 'total', 'title', 'retained'];
      const leakedKeys = Object.keys(output[0]).filter((k) => !allowed.includes(k));
      expect(leakedKeys).toEqual([]);
      expect(output[0]).not.toHaveProperty('snapshot');
      expect(output[0]).not.toHaveProperty('variables');
    });

    it('removes artifact-bearing variables when pruning a completed run', async () => {
      const stateId = await startCompleted();
      const state = await readRunbookState(workspace, stateId);
      expect(state).not.toBeNull();
      const artifact = {
        kind: 'artifact-record' as const,
        uri: `rd://artifacts/ctx1/${stateId}/plan.json`,
        runId: stateId,
        contextId: 'ctx1',
        runbook: state!.runbook,
        key: 'plan.json',
        timestamp: '2026-05-07T00:00:00.000Z',
      };
      // Persist an ArtifactRecord inside the unified `variables` bucket
      // alongside a string OUTPUTS value.
      await patchPersistedRunState(workspace.cwd, stateId, (current) => ({
        ...current,
        variables: {
          ...state!.variables,
          PlanPath: artifact,
          Note: 'string-output',
        },
      }));

      // Sanity-check: the artifact-shaped value really is on disk before prune.
      const before = await readRunbookState(workspace, stateId);
      expect(before?.variables.PlanPath).toMatchObject({
        uri: artifact.uri,
        key: 'plan.json',
      });
      expect(before?.variables.Note).toBe('string-output');

      await runCliInProcess('prune --completed --text', workspace);

      const loaded = await readRunbookState(workspace, stateId);
      expect(loaded).toBeNull();
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toHaveLength(0);
    });

    it('prunes stopped run state by default', async () => {
      await startStopped();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('prunes both completed and stopped run state by default', async () => {
      await startCompleted();
      await startStopped();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('does not prune a running run by default', async () => {
      await startRunning();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune', workspace);
      expect(result.exitCode).toBe(0);
      // Not selected at all: a bare prune does not even report it retained.
      expect(JSON.parse(result.stdout)).toEqual([]);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('shows pruned runbook info in output', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('simple.runbook.md');
      expect(result.stdout).toContain('complete');
    });
  });

  describe('--completed flag', () => {
    it('prunes only completed run state', async () => {
      await startCompleted();
      const running = await startRunning();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --completed --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toEqual([`${running.runId}.json`]);
    });
  });

  describe('--stopped flag', () => {
    it('prunes only stopped run state', async () => {
      await startStopped();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --stopped --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(0);
    });

    it('does not prune completed state when only --stopped specified', async () => {
      await startCompleted();
      await startStopped();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      await runCliInProcess('prune --stopped --text', workspace);

      // Only the completed state should remain
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
      const remainingState = await readRunbookState(workspace, statesAfter[0].replace('.json', ''));
      expect(remainingState?.lifecycle).toBe('completed');
    });
  });

  describe('--active flag (one writer per run)', () => {
    it('retains a running run without its token and reports why', async () => {
      const { runId } = await startRunning();

      const result = await runCliInProcess('prune --active', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(validateCommandOutput('prune', output)).toEqual({ valid: true, errors: [] });
      expect(output).toEqual([
        expect.objectContaining({ id: runId, status: 'running', retained: 'token required' }),
      ]);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toEqual([`${runId}.json`]);
    });

    it('shows the retained reason in text output', async () => {
      const { runId } = await startRunning();

      const result = await runCliInProcess('prune --active --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('RETAINED');
      expect(result.stdout).toContain('token required');
      expect(result.stdout).toContain(runId);
    });

    it('does not prune completed state when only --active specified', async () => {
      const completedId = await startCompleted();
      await startRunning();

      await runCliInProcess('prune --active --text', workspace);

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(2);
      expect(statesAfter).toContain(`${completedId}.json`);
    });
  });

  describe('--token (the only way to prune a running run)', () => {
    it('deletes exactly the running run the token names', async () => {
      const first = await startRunning();
      const second = await startRunning();

      const result = await runCliInProcess(`prune --token ${first.token}`, workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(validateCommandOutput('prune', output)).toEqual({ valid: true, errors: [] });
      expect(output).toEqual([expect.objectContaining({ id: first.runId, status: 'running' })]);
      expect(output[0]).not.toHaveProperty('retained');

      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toEqual([`${second.runId}.json`]);
    });

    it('selects only the token’s run when no lifecycle filter is given', async () => {
      const completedId = await startCompleted();
      const { runId, token } = await startRunning();

      const result = await runCliInProcess(`prune --token ${token}`, workspace);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ id: runId })]);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toEqual([`${completedId}.json`]);
    });

    it('combines with --active: the token’s run is deleted, other running runs are retained', async () => {
      const first = await startRunning();
      const second = await startRunning();

      const result = await runCliInProcess(`prune --active --token ${first.token}`, workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.runId, status: 'running' }),
          expect.objectContaining({ id: second.runId, retained: 'token required' }),
        ]),
      );
      expect(output.find((row) => row.id === first.runId)).not.toHaveProperty('retained');
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter).toEqual([`${second.runId}.json`]);
    });

    it('also deletes the token’s run once it has finished', async () => {
      const { runId, token } = await startRunning();
      const complete = await runCliInProcess(`complete --token ${token}`, workspace);
      expect(complete.exitCode).toBe(0);

      const result = await runCliInProcess(`prune --token ${token}`, workspace);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ id: runId, status: 'complete' }),
      ]);
      expect(await listRunbookStates(workspace)).toEqual([]);
    });

    it('refuses an unknown token with UNKNOWN_TOKEN and prunes nothing', async () => {
      const { runId } = await startRunning();

      const result = await runCliInProcess(`prune --token ${UNKNOWN_TOKEN}`, workspace);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.kind).toBe('error');
      expect(output.code).toBe('UNKNOWN_TOKEN');
      expect(await listRunbookStates(workspace)).toEqual([`${runId}.json`]);
    });

    it('refuses a malformed token with INVALID_SYNTAX without echoing it', async () => {
      await startRunning();

      const result = await runCliInProcess('prune --token not-a-token', workspace);

      expect(result.exitCode).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.code).toBe('INVALID_SYNTAX');
      expect(String(output.error)).not.toContain('not-a-token');
    });

    it('honours --dry-run for the token’s run', async () => {
      const { runId, token } = await startRunning();

      const result = await runCliInProcess(`prune --token ${token} --dry-run`, workspace);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ id: runId })]);
      expect(await listRunbookStates(workspace)).toEqual([`${runId}.json`]);
    });
  });

  describe('--inactive flag', () => {
    it('prunes abandoned run state', async () => {
      const abandoned = await seedRun(workspace.cwd);
      await patchPersistedRunState(workspace.cwd, abandoned.runId, { lifecycle: 'abandoned' });
      const { runId: runningId } = await startRunning();

      const result = await runCliInProcess('prune --inactive', workspace);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ id: abandoned.runId, status: 'abandoned' }),
      ]);
      expect(await listRunbookStates(workspace)).toEqual([`${runningId}.json`]);
    });

    it('does not prune running or completed state when only --inactive specified', async () => {
      await startCompleted();
      await startRunning();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(2);

      const result = await runCliInProcess('prune --inactive --text', workspace);

      expect(result.exitCode).toBe(0);
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(2);
    });
  });

  describe('--all flag', () => {
    it('prunes every finished run and retains running runs for want of a token', async () => {
      await startCompleted();
      await startStopped();
      const { runId: runningId } = await startRunning();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(3);

      const result = await runCliInProcess('prune --all', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output).toHaveLength(3);
      expect(output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: runningId, retained: 'token required' }),
        ]),
      );
      expect(await listRunbookStates(workspace)).toEqual([`${runningId}.json`]);
    });

    it('prunes everything when the running run’s token accompanies --all', async () => {
      await startCompleted();
      const { token } = await startRunning();

      const result = await runCliInProcess(`prune --all --token ${token}`, workspace);

      expect(result.exitCode).toBe(0);
      expect(await listRunbookStates(workspace)).toEqual([]);
    });
  });

  describe('--dry-run flag', () => {
    it('shows what would be removed without deleting', async () => {
      await startCompleted();

      const statesBefore = await listRunbookStates(workspace);
      expect(statesBefore.length).toBe(1);

      const result = await runCliInProcess('prune --dry-run --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('simple.runbook.md');

      // State should still exist
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('shows empty message when nothing matches in dry-run', async () => {
      const result = await runCliInProcess('prune --dry-run --text', workspace);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No run state to prune.');
    });
  });

  describe('output', () => {
    it('outputs pruned items as JSON array', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBe(1);
      expect(output[0].runbook).toBe('runbooks/simple.runbook.md');
      expect(output[0].status).toBe('complete');
    });

    it('includes id, runbook, and status fields in JSON output', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune', workspace);

      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output[0]).toHaveProperty('id');
      expect(output[0]).toHaveProperty('runbook');
      expect(output[0]).toHaveProperty('status');
    });

    it('does not include internal _status or _retained fields in JSON output', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune', workspace);

      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output[0]).not.toHaveProperty('_status');
      expect(output[0]).not.toHaveProperty('_retained');
    });
  });

  describe('--dry-run combined', () => {
    it('outputs items as JSON without deleting state', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune --dry-run', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, unknown>[];
      expect(output.length).toBe(1);
      expect(output[0].runbook).toBe('runbooks/simple.runbook.md');

      // State should still exist (dry-run)
      const statesAfter = await listRunbookStates(workspace);
      expect(statesAfter.length).toBe(1);
    });

    it('outputs empty array when nothing matches', async () => {
      const result = await runCliInProcess('prune --dry-run', workspace);

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual([]);
    });
  });

  describe('text output format', () => {
    it('displays column headers in text output', async () => {
      await startCompleted();

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('ID');
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('RUNBOOK');
    });

    it('displays title in brackets when runbook has a title', async () => {
      const runbookContent = `# My Titled Runbook

## 1. Only step
- PASS COMPLETE

\`\`\`bash
rd echo --result pass
\`\`\`
`;
      await writeFile(join(workspace.cwd, 'titled.runbook.md'), runbookContent);
      await runCliInProcess('run titled.runbook.md --text', workspace);

      const result = await runCliInProcess('prune --text', workspace);

      expect(result.stdout).toContain('[My Titled Runbook]');
    });
  });

  describe('invalid persisted rows', () => {
    /**
     * The prune invocation quoted in the RD-309 message (e.g. `prune --inactive`),
     * with the binary name stripped so it can be handed to the in-process CLI.
     */
    function pruneCommandFromRd309Message(): string {
      const { message } = Errors.invalidPersistedRunState('Invalid runbook state for "rd_x".');
      const quoted = /discard it with "rundown ([^"]+)"/.exec(message)?.[1];
      if (quoted === undefined) {
        // Not an assertion: the extraction failing means the message stopped
        // naming a prune command at all, which is a different regression from
        // naming the wrong one, and the message itself is the evidence.
        throw new Error(`RD-309 message names no prune command: ${message}`);
      }
      return quoted;
    }

    /** A run whose persisted state this build refuses — the RD-309 subject. */
    async function seedInvalidRun(): Promise<RunId> {
      const { runId } = await seedRun(workspace.cwd);
      await patchPersistedRunState(workspace.cwd, runId, { schemaVersion: 99 });
      return runId;
    }

    it('leaves the invalid run in place under a bare prune', async () => {
      const invalidId = await seedInvalidRun();

      const result = await runCliInProcess('prune', workspace);

      // Exits 0 having deleted nothing: `list()` skips the invalid row, so the
      // default completed + stopped selection can never reach it. That is why
      // the RD-309 message must name a mode.
      expect(result.exitCode).toBe(0);
      expect(await new RunbookStateManager(workspace.cwd).listRunIds()).toContain(invalidId);
    });

    it('clears the invalid run under the mode the RD-309 message names', async () => {
      const invalidId = await seedInvalidRun();

      const result = await runCliInProcess(pruneCommandFromRd309Message(), workspace);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ id: invalidId, status: 'invalid', runbook: '(invalid)' }),
      ]);
      expect(await new RunbookStateManager(workspace.cwd).listRunIds()).not.toContain(invalidId);
    });

    it('clears the invalid run under --all while retaining a running run', async () => {
      const invalidId = await seedInvalidRun();
      const { runId: runningId } = await startRunning();

      const result = await runCliInProcess('prune --all', workspace);

      expect(result.exitCode).toBe(0);
      const ids = await new RunbookStateManager(workspace.cwd).listRunIds();
      expect(ids).not.toContain(invalidId);
      expect(ids).toContain(runningId);
    });
  });
});
